require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TLSSigAPIv2 = require('tls-sig-api-v2');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Client, validateSignature, messagingApi } = require('@line/bot-sdk');

// ==========================================
// LINE Messaging API Init
// ==========================================  
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken: lineConfig.channelAccessToken });

const sendLineMessage = async (lineUserId, houseNumber, residentUrl, visitorInfo = null) => {
    if (!lineUserId) return false;

    // สร้าง body contents — ถ้ามี visitorInfo ให้แสดงข้อมูลบัตรด้วย
    const bodyContents = [
        { type: 'text', text: '🔔 มีผู้ต้องการติดต่อ', weight: 'bold', size: 'md', color: '#1a1a1a' },
        { type: 'text', text: `บ้านเลขที่ ${houseNumber}`, size: 'sm', color: '#555555', margin: 'xs' }
    ];
    if (visitorInfo?.nameTh) {
        bodyContents.push({ type: 'separator', margin: 'md' });
        bodyContents.push({ type: 'text', text: '🪪 ข้อมูลผู้มาติดต่อ', size: 'xs', color: '#888888', margin: 'md' });
        bodyContents.push({ type: 'text', text: visitorInfo.nameTh, size: 'sm', weight: 'bold', color: '#1a1a1a', margin: 'xs' });
        if (visitorInfo.idNumber) bodyContents.push({ type: 'text', text: `บัตรเลข ${visitorInfo.idNumber}`, size: 'xs', color: '#888888', margin: 'xs' });
    }

    try {
        await lineClient.pushMessage({
            to: lineUserId,
            messages: [{
                type: 'flex',
                altText: `🔔 มีผู้ต้องการติดต่อ บ้าน ${houseNumber}${visitorInfo?.nameTh ? ' — ' + visitorInfo.nameTh : ''}`,
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'lg', contents: bodyContents },
                    footer: {
                        type: 'box', layout: 'vertical', spacing: 'none', paddingAll: 'md',
                        contents: [{
                            type: 'button',
                            action: { type: 'uri', label: '📞 กดรับสาย', uri: residentUrl },
                            style: 'primary', color: '#00B900', height: 'sm'
                        }]
                    }
                }
            }]
        });
        console.log(`💬 LINE message sent → บ้าน ${houseNumber}`);
        return true;
    } catch (err) {
        console.error(`❌ LINE send failed:`, err.message);
        return false;
    }
};

// ==========================================
// Google Cloud Vision OCR + Speech-to-Text
// ==========================================
const vision = require('@google-cloud/vision');
const speech = require('@google-cloud/speech');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const visionClient = new vision.ImageAnnotatorClient({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    projectId: process.env.GOOGLE_PROJECT_ID,
});

const speechClient = new speech.SpeechClient({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    projectId: process.env.GOOGLE_PROJECT_ID,
});

function parseHouseNumber(text) {
    if (!text) return null;
    const cleaned = text.trim().toLowerCase();
    const digits = cleaned.match(/\d{2,4}/);
    if (digits) return digits[0];

    const wordMap = {
        'ศูนย์': '0', 'เลขศูนย์': '0', 'หนึ่ง': '1', 'เอ็ด': '1', 'สอง': '2', 'ยี่': '2', 'สาม': '3',
        'สี่': '4', 'ห้า': '5', 'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9',
        'หนึ่ง': '1', 'สอง': '2', 'สาม': '3', 'สี่': '4', 'ห้า': '5', 'หก': '6', 'เจ็ด': '7', 'แปด': '8', 'เก้า': '9'
    };
    let transformed = cleaned;
    Object.keys(wordMap).forEach(word => {
        transformed = transformed.split(word).join(wordMap[word]);
    });
    const numeric = transformed.match(/\d{2,4}/);
    return numeric ? numeric[0] : null;
}

// Parse ข้อมูลบัตรประชาชนไทยจาก OCR text (Tesseract-friendly)
function parseThaiIdCard(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const full  = text.replace(/\n/g, ' ');

    // ── เลขบัตร 13 หลัก ──
    let idNumber = null;
    const idPatterns = [
        /\b(\d[\s-]?\d{4}[\s-]?\d{5}[\s-]?\d{2}[\s-]?\d)\b/,
        /\b(\d{13})\b/,
        /(\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d[\s]\d)/
    ];
    for (const p of idPatterns) {
        const m = full.match(p);
        if (m) { idNumber = m[1].replace(/[\s-]/g, ''); break; }
    }

    // ── ชื่อภาษาไทย ──
    // บัตรประชาชนไทย: ชื่อไทยอยู่หลังคำว่า "ชื่อ" ในรูปแบบต่างๆ
    // OCR มักอ่านเป็น "ชื่อเก WI" หรือ "ชื่องกล WIE" ปนอยู่
    let nameTh = null;

    // 1) หาจาก pattern คำนำหน้า + ชื่อไทย
    const prefixPattern = /((?:นาย|นางสาว|นาง|ด\.?ญ\.?|ด\.?ช\.?)\s*[\u0E00-\u0E7F][\u0E00-\u0E7F\s]{2,30})/;
    const pm = full.match(prefixPattern);
    if (pm) nameTh = pm[1].trim().replace(/\s+/g, ' ').substring(0, 40);

    // 2) fallback: หาบรรทัดที่มี "ชื่อ" แล้วเก็บ cluster คำไทยที่ยาวที่สุด
    if (!nameTh) {
        for (const line of lines) {
            if (/ชื่อ/.test(line)) {
                // ลบ noise ออก เก็บเฉพาะคำไทย
                const cleaned = line.replace(/[^\u0E00-\u0E7F\s]/g, ' ').trim();
                const clusters = cleaned.match(/[\u0E00-\u0E7F]{2,}(?:\s+[\u0E00-\u0E7F]{2,})*/g) || [];
                const skip = /^(ชื่อ|บัตร|ประจำ|ตัว|ประชาชน|และ|เลข)$/;
                const valid = clusters.filter(c => !skip.test(c.trim()) && c.trim().length > 2);
                if (valid.length > 0) {
                    nameTh = valid.sort((a, b) => b.length - a.length)[0].trim();
                }
                break;
            }
        }
    }

    // 3) fallback: บรรทัดที่ขึ้นต้นด้วยคำนำหน้า
    if (!nameTh) {
        for (const line of lines) {
            if (/^(นาย|นางสาว|นาง|ด\.ญ\.|ด\.ช\.)/.test(line) && line.length > 4) {
                nameTh = line.replace(/\s+/g, ' ').substring(0, 40);
                break;
            }
        }
    }

    // ── ชื่อภาษาอังกฤษ (ชื่อ + นามสกุล) ──
    let firstName = null;
    let lastName  = null;

    // 1) บัตรประชาชน: "Mr. Firstname" / "Mrs." / "Miss"
    for (let i = 0; i < lines.length; i++) {
        const mFirstInLine = lines[i].match(/((?:Mr\.?|Mrs\.?|Miss|Ms\.?)\s+[A-Za-z][a-zA-Z\s]*)/i);
        if (mFirstInLine) {
            firstName = mFirstInLine[1].trim();
            for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                const mLast = lines[j].match(/^(?:Last\s*name|Lastname)[:\s]+([A-Za-z]+(?:\s+[A-Za-z]+)*)/i);
                if (mLast) { lastName = mLast[1].trim(); break; }
                const mPlain = lines[j].match(/^([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})*)$/);
                const skip = /^(Last|Name|Date|Birth|Religion|Address|Thai|National|Meme|Ref)/i;
                if (mPlain && !skip.test(lines[j])) { lastName = mPlain[1].trim(); break; }
            }
            break;
        }
    }

    if (!lastName) {
        for (let i = 0; i < lines.length; i++) {
            const label = lines[i].trim();
            if (/Surname|Family\s*name|Last\s*name|Lastname|นามสกุล|Sum\w*/i.test(label)) {
                const sameLineMatch = label.match(/(?:Surname|Family\s*name|Last\s*name|Lastname|Sum\w*)[:\/]\s*([A-Za-z][A-Za-z\s<-]{2,})/i);
                if (sameLineMatch) {
                    lastName = sameLineMatch[1].replace(/<+/g, ' ').trim();
                    break;
                }
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                    const candidate = lines[j].trim();
                    const upperMatch = candidate.match(/([A-Z][A-Z-]+(?:\s+[A-Z][A-Z-]+)*)/);
                    if (upperMatch) {
                        lastName = upperMatch[1].replace(/<+/g, ' ').trim();
                        break;
                    }
                    if (/^[A-Z][A-Z\s<-]{2,}$/.test(candidate.replace(/<+/g, ' '))) {
                        lastName = candidate.replace(/<+/g, ' ').trim();
                        break;
                    }
                    if (/^[A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+)*$/.test(candidate) && !/^(Name|Date|Birth|Nationality|Sex|Place|Authority)/i.test(candidate)) {
                        lastName = candidate;
                        break;
                    }
                }
                if (lastName) break;
            }
            if (/Title\s*\/\s*Name/i.test(label) && i > 0) {
                const candidate = lines[i - 1].trim();
                if (/^[A-Z][A-Z\s<-]{2,}$/.test(candidate.replace(/<+/g, ' '))) {
                    lastName = candidate.replace(/<+/g, ' ').trim();
                    break;
                }
            }
        }
    }

    if (!lastName) {
        for (const line of lines) {
            if (line.includes('<<')) {
                const candidate = line.split('<<')[0].replace(/<+/g, ' ').trim();
                if (/^[A-Z][A-Z\s]+$/.test(candidate) && candidate.length > 3) {
                    lastName = candidate;
                    break;
                }
            }
        }
    }

    let nameEn = null;
    if (firstName && lastName) {
        nameEn = `${firstName} ${lastName}`;
    } else if (firstName) {
        nameEn = firstName;
    } else {
        // 2) ใบขับขี่/บัตรอื่น: บรรทัดที่ขึ้นต้นด้วย "Name " ตามด้วยตัวอักษรพิมพ์ใหญ่
        for (const line of lines) {
            const mName = line.match(/^Name\s+([A-Z][A-Za-z\s]{2,50})$/i);
            if (mName) { nameEn = mName[1].trim(); break; }
        }
        // 3) fallback: Title Case ธรรมดา
        if (!nameEn) {
            const skip = /^(Thai|National|ID|Card|Date|Birth|Issue|Expiry|Address|Religion|Last|Name|Thal|Kingdom|Private|Driving|Licence|Temporary)/i;
            for (const line of lines) {
                const m = line.match(/^([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15}){1,3})$/);
                if (m && !skip.test(m[1])) { nameEn = m[1]; break; }
            }
        }
    }

    if (!lastName && nameEn && nameEn.trim().includes(' ') && !/^(Mr\.?|Mrs\.?|Miss|Ms\.?)/i.test(nameEn.trim())) {
        const parts = nameEn.trim().split(/\s+/);
        lastName = parts[parts.length - 1];
    }

    // ── ประเภทบัตร ──
    let cardType = 'ไม่ระบุประเภท';
    if (/passport|หนังสือเดินทาง/i.test(full)) {
        cardType = 'หนังสือเดินทาง';
    } else if (/ใบอนุญาตขับร|driving licen/i.test(full)) {
        cardType = 'ใบอนุญาตขับขี่';
    } else if (/ประจำตัวประชาชน|national id|thai national/i.test(full)) {
        cardType = 'บัตรประจำตัวประชาชน';
    } else if (idNumber && idNumber.length === 13) {
        cardType = 'บัตรประจำตัวประชาชน';
    }

    // ── วันเกิด ──
    let birthDate = null;
    const bdPatterns = [
        /เกิดวันที่[^\d]*(\d{1,2}\s+\S+\.?\s+\d{4})/,
        /Date of Birth[^\d]*(\d{1,2}\s+\w+\.?\s+\d{4})/i,
        /(\d{1,2}\s+(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{4})/,
        /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4})/i,
        /(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{4})/,
    ];
    for (const p of bdPatterns) {
        const m = full.match(p);
        if (m) { birthDate = m[1].trim(); break; }
    }

    // ── วันหมดอายุ ──
    let expDate = null;
    const expPatterns = [
        /(?:หมดอายุ|วันหมดอายุ)[^\d]*(\d{1,2}\s+\S+\.?\s+\d{4})/,
        /(?:Expiry|Expired)[^\d]*(\d{1,2}\s+\w+\.?\s+\d{4})/i,
    ];
    for (const p of expPatterns) {
        const m = full.match(p);
        if (m) { expDate = m[1].trim(); break; }
    }

    return { idNumber, nameTh, nameEn, lastName, birthDate, expDate, cardType, rawText: text };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// PostgreSQL
// ==========================================
const pool = new Pool({
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
});

const waitForDb = async (retries = 10, delay = 3000) => {
    for (let i = 1; i <= retries; i++) {
        try {
            const client = await pool.connect();
            console.log('✅ PostgreSQL connected');
            client.release();
            return true;
        } catch (err) {
            console.log(`⏳ DB ยังไม่พร้อม รอ... (${i}/${retries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    console.error('❌ เชื่อมต่อ DB ไม่ได้');
    process.exit(1);
};

const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS houses (
                house_number VARCHAR(10) PRIMARY KEY,
                house_name VARCHAR(100)
            );
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id VARCHAR(20) PRIMARY KEY,
                house_number VARCHAR(10),
                numeric_room_id INTEGER NOT NULL,
                camera_user_id VARCHAR(50),
                resident_user_id VARCHAR(50),
                sdk_app_id VARCHAR(20),
                resident_sig TEXT,
                camera_sig TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // เพิ่มคอลัมน์ใหม่ถ้ายังไม่มี (migrate จาก schema เก่า)
        const newCols = ['camera_user_id VARCHAR(50)', 'resident_user_id VARCHAR(50)', 'sdk_app_id VARCHAR(20)', 'resident_sig TEXT', 'camera_sig TEXT'];
        for (const col of newCols) {
            const [colName] = col.split(' ');
            await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS ${col};`).catch(() => {});
        }
        await pool.query(`
            CREATE TABLE IF NOT EXISTS house_tokens (
                token VARCHAR(64) PRIMARY KEY,
                house_number VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // migrate columns
        await pool.query(`ALTER TABLE house_tokens ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(50);`);
        await pool.query(`ALTER TABLE visitor_logs ADD COLUMN IF NOT EXISTS card_type VARCHAR(50);`);
        await pool.query(`ALTER TABLE visitor_logs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;`);
        // ตาราง visitor_logs สำหรับเก็บประวัติการเข้า-ออก + ข้อมูล OCR
        await pool.query(`
            CREATE TABLE IF NOT EXISTS visitor_logs (
                id SERIAL PRIMARY KEY,
                house_number VARCHAR(10),
                room_code VARCHAR(20),
                id_number VARCHAR(20),
                name_th TEXT,
                name_en TEXT,
                birth_date VARCHAR(30),
                exp_date VARCHAR(30),
                ocr_raw TEXT,
                photo_url TEXT,
                card_type VARCHAR(50),
                status VARCHAR(20) DEFAULT 'pending',
                completed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // เพิ่ม unique constraint บน house_number เพื่อรองรับ UPSERT
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS house_tokens_house_number_idx
            ON house_tokens (house_number);
        `);
        await pool.query(`
            INSERT INTO houses (house_number, house_name) VALUES
            ('101', 'บ้านเลขที่ 101'),
            ('102', 'บ้านเลขที่ 102'),
            ('103', 'บ้านเลขที่ 103')
            ON CONFLICT DO NOTHING;
        `);
        console.log('✅ Tables ready');
    } catch (err) {
        console.error('initDb error:', err);
    }
};

waitForDb().then(() => initDb());

// ==========================================
// TRTC
// ==========================================
const USERSIG_VALIDITY = 86400;
const generateUserSig = (userId) => {
    const api = new TLSSigAPIv2.Api(parseInt(process.env.TRTC_SDKAPPID), process.env.TRTC_SECRETKEY);
    return api.genUserSig(userId, USERSIG_VALIDITY);
};
const generateNumericRoomId = () => Math.floor(100000 + Math.random() * 900000);
const generateRoomCode = () => {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};
const generateToken = () => require('crypto').randomBytes(24).toString('hex');

// ==========================================
// REST API — Admin Token
// ==========================================
app.get('/api/admin/tokens', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ht.token, ht.house_number, h.house_name, ht.created_at
             FROM house_tokens ht
             JOIN houses h ON h.house_number = ht.house_number
             ORDER BY ht.house_number`
        );
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// REST API — CRUD บ้าน
// ==========================================

// GET /api/houses — ดึงรายชื่อบ้านทั้งหมด (ใช้จาก camera.html)
app.get('/api/houses', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT house_number, house_name FROM houses ORDER BY house_number'
        );
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/admin/houses — เพิ่มบ้านใหม่
app.post('/api/admin/houses', async (req, res) => {
    const { houseNumber, houseName } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    const name = houseName || `บ้านเลขที่ ${houseNumber}`;
    try {
        await pool.query(
            'INSERT INTO houses (house_number, house_name) VALUES ($1, $2)',
            [houseNumber, name]
        );
        console.log(`🏠 เพิ่มบ้าน ${houseNumber}`);
        res.json({ status: 'success', data: { houseNumber, houseName: name } });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ status: 'error', message: `บ้าน ${houseNumber} มีอยู่แล้ว` });
        }
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// DELETE /api/admin/houses/:id — ลบบ้าน
app.delete('/api/admin/houses/:id', async (req, res) => {
    const houseNumber = req.params.id;
    try {
        await pool.query('DELETE FROM house_tokens WHERE house_number = $1', [houseNumber]);
        await pool.query('DELETE FROM rooms WHERE house_number = $1', [houseNumber]);
        const result = await pool.query('DELETE FROM houses WHERE house_number = $1', [houseNumber]);
        if (result.rowCount === 0)
            return res.status(404).json({ status: 'error', message: 'ไม่พบบ้านนี้' });
        console.log(`ลบบ้าน ${houseNumber}`);
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});


app.post('/api/admin/tokens/generate', async (req, res) => {
    const { houseNumber } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    try {
        await pool.query('DELETE FROM house_tokens WHERE house_number = $1', [houseNumber]);
        const token = generateToken();
        await pool.query('INSERT INTO house_tokens (token, house_number) VALUES ($1, $2)', [token, houseNumber]);
        const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
        res.json({
            status: 'success',
            data: { houseNumber, token, url: `${baseUrl}/resident.html?house=${houseNumber}&token=${token}` }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/verify-token', async (req, res) => {
    const { house, token } = req.query;
    if (!house || !token) return res.status(400).json({ status: 'error', message: 'missing params' });
    try {
        const result = await pool.query(
            'SELECT house_number FROM house_tokens WHERE token = $1 AND house_number = $2',
            [token, house]
        );
        if (result.rows.length === 0)
            return res.status(403).json({ status: 'error', message: 'token ไม่ถูกต้อง' });
        const houseResult = await pool.query('SELECT house_name FROM houses WHERE house_number = $1', [house]);
        res.json({
            status: 'success',
            data: { houseNumber: house, houseName: houseResult.rows[0]?.house_name || `บ้านเลขที่ ${house}` }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/pending-call — resident โหลด pending call หลังเปิดหน้าจาก push notification
app.get('/api/pending-call', async (req, res) => {
    const { house, token, room } = req.query;
    if (!house || !token || !room)
        return res.status(400).json({ status: 'error', message: 'missing params' });
    try {
        // ตรวจ token
        const tokenResult = await pool.query(
            'SELECT house_number FROM house_tokens WHERE token = $1 AND house_number = $2',
            [token, house]
        );
        if (tokenResult.rows.length === 0)
            return res.status(403).json({ status: 'error', message: 'token ไม่ถูกต้อง' });

        // ดึง room ที่ยังมีอยู่
        const roomResult = await pool.query(
            `SELECT id, house_number, numeric_room_id, resident_user_id, sdk_app_id, resident_sig
             FROM rooms WHERE id = $1 AND house_number = $2`,
            [room, house]
        );
        if (roomResult.rows.length === 0)
            return res.status(404).json({ status: 'notfound', message: 'ไม่พบสายที่รอรับ (อาจถูกยกเลิกแล้ว)' });

        const r = roomResult.rows[0];
        // ดึง visitor info ถ้ามี
        const visitorResult = await pool.query(
            'SELECT id_number, name_th, name_en, birth_date, card_type FROM visitor_logs WHERE room_code = $1 ORDER BY created_at DESC LIMIT 1',
            [room]
        );
        const vRow = visitorResult.rows[0];
        const visitorInfo = vRow ? {
            idNumber:  vRow.id_number  || null,
            nameTh:    vRow.name_th    || null,
            nameEn:    vRow.name_en    || null,
            birthDate: vRow.birth_date || null,
            cardType:  vRow.card_type  || null,
        } : null;
        res.json({
            status: 'success',
            data: {
                roomCode: r.id,
                houseNumber: r.house_number,
                roomId: r.numeric_room_id,
                userId: r.resident_user_id,
                sdkAppId: r.sdk_app_id,
                userSig: r.resident_sig,
                visitorInfo
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});



// ==========================================
// REST API — TRTC / Status
// ==========================================
app.post('/api/get-credentials', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ status: 'error', message: 'userId required' });
    try {
        res.json({ status: 'success', data: { userId, sdkAppId: process.env.TRTC_SDKAPPID, userSig: generateUserSig(userId) } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW() as t');
        res.json({ status: 'success', db_time: result.rows[0].t });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// OCR — ถ่ายบัตรประชาชน
// ==========================================

// POST /api/ocr — รับรูปบัตร → Google Vision documentTextDetection → return ข้อมูล
// documentTextDetection เข้าใจ layout 2 คอลัมน์ได้ดีกว่า textDetection ทั่วไป
app.post('/api/ocr', upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'ไม่พบรูปภาพ' });
    try {
        const [result] = await visionClient.documentTextDetection({
            image: { content: req.file.buffer },
            imageContext: { languageHints: ['th', 'en'] }
        });
        const rawText = result.fullTextAnnotation?.text || '';
        if (!rawText.trim()) return res.json({ status: 'success', data: { idNumber: null, nameTh: null, nameEn: null, rawText: '' } });
        const parsed = parseThaiIdCard(rawText);
        console.log('\n🔍 OCR result:', JSON.stringify(parsed));
        res.json({ status: 'success', data: parsed });
    } catch (err) {
        console.error('OCR error:', err.message);
        res.status(500).json({ status: 'error', message: 'OCR ล้มเหลว: ' + err.message });
    }
});

app.post('/api/speech-to-text', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ status: 'error', message: 'ไม่พบไฟล์เสียง' });
    try {
        const audioBytes = req.file.buffer.toString('base64');
        const [response] = await speechClient.recognize({
            config: {
                encoding: 'WEBM_OPUS',
                sampleRateHertz: 48000,
                languageCode: 'th-TH',
                enableAutomaticPunctuation: false,
            },
            audio: { content: audioBytes }
        });
        const transcript = response.results.map(r => r.alternatives[0]?.transcript || '').join(' ').trim();
        const houseNumber = parseHouseNumber(transcript);
        res.json({ status: 'success', data: { transcript, houseNumber } });
    } catch (err) {
        console.error('Speech-to-text error:', err.message);
        res.status(500).json({ status: 'error', message: 'Speech-to-text ล้มเหลว: ' + err.message });
    }
});

app.post('/api/exit-scan', async (req, res) => {
    const { idNumber } = req.body;
    if (!idNumber) return res.status(400).json({ status: 'error', message: 'idNumber required' });
    try {
        const result = await pool.query(
            `SELECT id, house_number FROM visitor_logs
             WHERE id_number = $1 AND status = 'pending'
             ORDER BY created_at DESC LIMIT 1`,
            [idNumber]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'คุณสแกนออกเรียบร้อยแล้ว' });
        }
        const log = result.rows[0];
        await pool.query(
            `UPDATE visitor_logs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [log.id]
        );
        res.json({ status: 'success', data: { logId: log.id, houseNumber: log.house_number } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/visitor-log — บันทึก visitor หลัง OCR สำเร็จ
app.post('/api/visitor-log', async (req, res) => {
    const { houseNumber, roomCode, idNumber, nameTh, nameEn, birthDate, expDate, ocrRaw } = req.body;
    try {
        const r = await pool.query(
            `INSERT INTO visitor_logs (house_number, room_code, id_number, name_th, name_en, birth_date, exp_date, ocr_raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [houseNumber, roomCode, idNumber, nameTh, nameEn, birthDate, expDate, ocrRaw]
        );
        res.json({ status: 'success', data: { logId: r.rows[0].id } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/visitor-logs — ดูประวัติผู้มาติดต่อ (Admin)
app.get('/api/visitor-logs', async (req, res) => {
    const { house, limit = 50 } = req.query;
    try {
        const q = house
            ? `SELECT * FROM visitor_logs WHERE house_number = $1 ORDER BY created_at DESC LIMIT $2`
            : `SELECT * FROM visitor_logs ORDER BY created_at DESC LIMIT $1`;
        const params = house ? [house, limit] : [limit];
        const result = await pool.query(q, params);
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// LINE Webhook
// ==========================================

// Verify LINE signature middleware
const lineWebhookMiddleware = (req, res, next) => {
    const signature = req.headers['x-line-signature'];
    if (!validateSignature(JSON.stringify(req.body), lineConfig.channelSecret, signature)) {
        return res.status(403).send('Invalid signature');
    }
    next();
};

app.post('/webhook/line', lineWebhookMiddleware, async (req, res) => {
    res.sendStatus(200); // ตอบ LINE ก่อนเสมอ ไม่งั้น timeout

    const events = req.body.events || [];
    for (const event of events) {
        if (event.type !== 'message' || event.message.type !== 'text') continue;

        const lineUserId = event.source.userId;
        const text = event.message.text.trim();

        // ลูกบ้านพิมพ์เลขบ้าน เช่น "101"
        const houseMatch = text.match(/^(\d{2,4})$/);
        if (!houseMatch) {
            await lineClient.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: '📌 กรุณาพิมพ์เลขที่บ้านของคุณ เช่น 101' }]
            });
            continue;
        }

        const houseNumber = houseMatch[1];

        // ตรวจว่าบ้านนี้มีในระบบไหม
        const houseResult = await pool.query(
            'SELECT house_name FROM houses WHERE house_number = $1',
            [houseNumber]
        );
        if (houseResult.rows.length === 0) {
            await lineClient.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: `❌ ไม่พบบ้านเลขที่ ${houseNumber} ในระบบ` }]
            });
            continue;
        }

        // บันทึก LINE User ID — ใช้ UPSERT รองรับทั้งบ้านที่มี/ไม่มี token
        await pool.query(
            `INSERT INTO house_tokens (token, house_number, line_user_id)
             VALUES (gen_random_uuid()::text, $2, $1)
             ON CONFLICT (house_number)
             DO UPDATE SET line_user_id = $1`,
            [lineUserId, houseNumber]
        );

        const houseName = houseResult.rows[0].house_name;
        console.log(`💬 LINE registered: ${lineUserId} → บ้าน ${houseNumber}`);

        await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `✅ ลงทะเบียน ${houseName} สำเร็จแล้ว!

เมื่อมีไรเดอร์กดกริ่ง คุณจะได้รับข้อความพร้อมลิ้งรับสายในแชทนี้ครับ 🔔` }]
        });
    }
});

// POST /api/admin/line/reset — ล้าง LINE User ID ของบ้านนั้น
app.post('/api/admin/line/reset', async (req, res) => {
    const { houseNumber } = req.body;
    if (!houseNumber) return res.status(400).json({ status: 'error', message: 'houseNumber required' });
    try {
        await pool.query(
            'UPDATE house_tokens SET line_user_id = NULL WHERE house_number = $1',
            [houseNumber]
        );
        console.log(`🔄 Reset LINE user บ้าน ${houseNumber}`);
        res.json({ status: 'success', message: `ล้าง LINE บ้าน ${houseNumber} แล้ว` });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/admin/line/status — ดูสถานะ LINE ทุกบ้าน (สำหรับ Admin UI)
// ใช้ LEFT JOIN เพื่อให้บ้านที่ยังไม่มี token ก็แสดงด้วย
app.get('/api/admin/line/status', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT h.house_number, h.house_name,
                    ht.line_user_id IS NOT NULL as has_line
             FROM houses h
             LEFT JOIN house_tokens ht ON ht.house_number = h.house_number
             ORDER BY h.house_number`
        );
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ==========================================
// Socket.io Signaling
// ==========================================
const residentSockets = {};
const cameraSockets = {};
const autoCloseTimers = {};
const AUTO_CLOSE_MS = 2 * 60 * 1000;   // 2 นาที หลังรับสายแล้ว
const PUSH_WAIT_MS  = 90 * 1000;        // 90 วิ รอลูกบ้านกดรับ push notification

function startAutoCloseTimer(roomCode) {
    if (autoCloseTimers[roomCode]) clearTimeout(autoCloseTimers[roomCode]);
    autoCloseTimers[roomCode] = setTimeout(async () => {
        console.log(`⏱️ Auto-close room ${roomCode}`);
        io.emit('call_ended', { roomCode, reason: 'timeout' });
        await cleanupRoom(roomCode);
    }, AUTO_CLOSE_MS);
}

// เริ่ม timer รอ push notification — ถ้าลูกบ้านไม่รับใน 90 วิ ตัดสาย
function startPushWaitTimer(roomCode, cameraSocketId) {
    if (autoCloseTimers[roomCode]) clearTimeout(autoCloseTimers[roomCode]);
    autoCloseTimers[roomCode] = setTimeout(async () => {
        console.log(`⏱️ Push wait timeout room ${roomCode} — ลูกบ้านไม่รับ`);
        // แจ้ง camera ว่าหมดเวลา
        if (cameraSocketId) {
            io.to(cameraSocketId).emit('call_ended', { roomCode, reason: 'timeout' });
        }
        await cleanupRoom(roomCode);
    }, PUSH_WAIT_MS);
}

async function cleanupRoom(roomCode) {
    if (autoCloseTimers[roomCode]) { clearTimeout(autoCloseTimers[roomCode]); delete autoCloseTimers[roomCode]; }
    try { await pool.query('DELETE FROM rooms WHERE id = $1', [roomCode]); } catch (e) {}
}

io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    socket.on('register_camera', () => {
        cameraSockets[socket.id] = { role: 'camera' };
        console.log(`📷 Camera registered: ${socket.id}`);
    });

    socket.on('register_resident', ({ houseNumber }) => {
        residentSockets[houseNumber] = socket.id;
        console.log(`🏠 Resident ${houseNumber} registered: ${socket.id}`);
    });

    socket.on('ring', async ({ houseNumber, visitorInfo }) => {
        const numericRoomId  = generateNumericRoomId();
        const roomCode       = generateRoomCode();
        const cameraUserId   = `camera_${houseNumber}`;
        const residentUserId = `resident_${houseNumber}`;
        const sdkAppId       = process.env.TRTC_SDKAPPID;
        const cameraSig      = generateUserSig(cameraUserId);
        const residentSig    = generateUserSig(residentUserId);
        const roomPayload    = { houseNumber, roomCode, roomId: numericRoomId, sdkAppId };

        // ── ดึงข้อมูล token + LINE ของบ้านนี้ก่อนเสมอ ──
        let houseUrlToken, lineUserId;
        try {
            const [, tokenResult] = await Promise.all([
                pool.query(
                    `INSERT INTO rooms (id, house_number, numeric_room_id, camera_user_id, resident_user_id, sdk_app_id, resident_sig, camera_sig)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [roomCode, houseNumber, numericRoomId, cameraUserId, residentUserId, sdkAppId, residentSig, cameraSig]
                ),
                pool.query(
                    'SELECT token, line_user_id FROM house_tokens WHERE house_number = $1',
                    [houseNumber]
                )
            ]);
            houseUrlToken = tokenResult.rows[0]?.token;
            lineUserId    = tokenResult.rows[0]?.line_user_id;
        } catch (err) {
            socket.emit('ring_error', { message: 'สร้างห้องไม่สำเร็จ' });
            return;
        }

        if (!houseUrlToken) {
            await cleanupRoom(roomCode);
            socket.emit('ring_error', { message: `ไม่พบลูกบ้าน ${houseNumber} ในระบบ` });
            return;
        }

        const baseUrl     = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
        const residentUrl = `${baseUrl}/resident.html?house=${houseNumber}&token=${houseUrlToken}&room=${roomCode}`;

        // ── save visitor_log พร้อม roomCode ทันที ก่อนส่ง LINE ──
        if (visitorInfo?.idNumber || visitorInfo?.nameTh || visitorInfo?.nameEn) {
            pool.query(
                `INSERT INTO visitor_logs (house_number, room_code, id_number, name_th, name_en, birth_date, card_type, ocr_raw)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [houseNumber, roomCode,
                 visitorInfo.idNumber  || null,
                 visitorInfo.nameTh    || null,
                 visitorInfo.nameEn    || null,
                 visitorInfo.birthDate || null,
                 visitorInfo.cardType  || null,
                 visitorInfo.rawText   || null]
            ).catch(e => console.warn('visitor_log insert failed:', e.message));
        }

        // ── ส่ง LINE ทุกครั้ง (ไม่ว่าจะ online/offline) ──
        // เพราะลูกบ้านอาจเปิดไลน์อยู่แทนที่จะเปิดหน้าเว็บ
        if (lineUserId) {
            sendLineMessage(lineUserId, houseNumber, residentUrl, visitorInfo || null); // fire-and-forget
            console.log(`💬 LINE message fired → บ้าน ${houseNumber}`);
        }

        // ── ถ้าลูกบ้านเปิดหน้าเว็บอยู่ด้วย → ส่ง socket ควบคู่ไปเลย ──
        const residentSocketId = residentSockets[houseNumber];
        if (residentSocketId) {
            io.to(residentSocketId).emit('incoming_call', {
                ...roomPayload,
                userId: residentUserId,
                userSig: residentSig,
                visitorInfo: visitorInfo || null
            });
            console.log(`📞 Ring via socket → บ้าน ${houseNumber}`);
        }

        // แจ้ง camera + เริ่ม timer
        startPushWaitTimer(roomCode, socket.id);
        socket.emit('room_created', { ...roomPayload, userId: cameraUserId, userSig: cameraSig });
        if (!residentSockets[houseNumber]) {
            socket.emit('ring_offline', {
                message: `บ้าน ${houseNumber} ออฟไลน์ — ส่งแจ้งเตือนแล้ว กำลังรอลูกบ้านรับสาย...`
            });
        }
    });

    socket.on('accept_call', ({ roomCode, houseNumber, startAt }) => {
        console.log(`✅ House ${houseNumber} accepted call in room ${roomCode}`);
        // ใช้ startAt จากลูกบ้าน (บันทึก ณ ขณะกดรับ) เพื่อให้ timer ตรงกันทุกฝั่ง
        const resolvedStartAt = startAt || Date.now();
        io.emit('call_accepted', { roomCode, houseNumber, startAt: resolvedStartAt });
        startAutoCloseTimer(roomCode);
    });

    socket.on('reject_call', ({ roomCode, houseNumber }) => {
        console.log(`❌ House ${houseNumber} rejected`);
        io.emit('call_ended', { roomCode, reason: 'rejected' });
        cleanupRoom(roomCode);
    });

    socket.on('end_call', ({ roomCode }) => {
        console.log(`📵 end_call room ${roomCode}`);
        io.emit('call_ended', { roomCode, reason: 'hangup' });
        cleanupRoom(roomCode);
    });

    socket.on('disconnect', () => {
        for (const [house, sid] of Object.entries(residentSockets)) {
            if (sid === socket.id) { delete residentSockets[house]; console.log(`🏠 Resident ${house} disconnected`); }
        }
        delete cameraSockets[socket.id];
        console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
});

// ==========================================
// Start Server
// ==========================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`   📷 Camera  : http://localhost:${PORT}/camera.html`);
    console.log(`   🏠 Resident: http://localhost:${PORT}/resident.html`);
    console.log(`   🔑 Admin   : http://localhost:${PORT}/admin.html`);
});