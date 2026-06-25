// ==========================================
// VIGI Camera — Persistent ffmpeg MJPEG stream  (เวอร์ชันแก้ดีเลย์)
// ==========================================
// แทนที่บล็อก VIGI เดิมทั้งหมด (ตั้งแต่ const { spawn } ... จนถึงก่อน server.listen)
const { spawn } = require('child_process');

// ใช้ stream2 (sub-stream) เป็นค่าเริ่มต้น — decode เร็วกว่า main มาก สำหรับ preview
const VIGI_RTSP = process.env.VIGI_RTSP_URL || 'rtsp://admin:P@ssw0rd1@172.25.11.210:554/stream2';

let latestFrame      = null;
let vigiProcess      = null;
let vigiRestartTimer = null;
// ตัวรับรู้ frame ใหม่ — ใช้ push ให้ client ทันทีที่ frame มา (ไม่ poll)
const frameSubscribers = new Set();
const SOI = Buffer.from([0xFF, 0xD8]);
const EOI = Buffer.from([0xFF, 0xD9]);

function startVigiStream() {
    if (vigiProcess) return;

    // *** จุดแก้ดีเลย์หลัก ***
    // - ตัด '-vf fps=15' ออก: filter fps เป็นตัว resample ที่ "อม" เฟรมไว้ใน queue
    //   เพื่อจัด timestamp ให้ตรง 15fps พอดี → เพิ่ม latency และสวนทางกับ low_delay
    //   ปล่อยให้กล้องส่ง framerate ของมันเองตรง ๆ จะสดกว่า
    // - ตัด '-s 640x360' ออก: ถ้าใช้ stream2 อยู่แล้วภาพเล็กพอ ไม่ต้อง scale ซ้ำ
    //   (การ scale สร้าง filtergraph ที่ buffer เพิ่ม) ถ้าอยากย่อ ให้ไปตั้งที่กล้องแทน
    const args = [
        '-rtsp_transport', 'tcp',
        '-flags', 'low_delay',
        '-fflags', 'nobuffer+discardcorrupt+flush_packets',
        '-avioflags', 'direct',
        '-analyzeduration', '0',
        '-probesize', '32',
        '-i', VIGI_RTSP,
        '-an',
        '-c:v', 'mjpeg',
        '-q:v', '8',
        '-f', 'mpjpeg',          // ให้ ffmpeg คายเป็น multipart พร้อม boundary เอง
        '-boundary_tag', 'mjpegframe',
        'pipe:1'
    ];

    console.log('📷 Starting VIGI ffmpeg stream...');
    vigiProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    let buf = Buffer.alloc(0);

    vigiProcess.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let start = 0;
        let newest = null;
        // ดึงเฉพาะ "เฟรมล่าสุด" ที่สมบูรณ์ในก้อนนี้ — เฟรมเก่ากว่าทิ้งได้เลย (กันสะสม)
        while (true) {
            const sIdx = buf.indexOf(SOI, start);
            if (sIdx === -1) break;
            const eIdx = buf.indexOf(EOI, sIdx + 2);
            if (eIdx === -1) break;
            newest = buf.slice(sIdx, eIdx + 2);
            start = eIdx + 2;
        }
        if (newest) {
            latestFrame = newest;
            // push ให้ทุก client ที่กำลังดู stream อยู่ ทันทีที่มีเฟรมใหม่จริง ๆ
            for (const write of frameSubscribers) write(newest);
        }
        buf = buf.slice(start);
        if (buf.length > 2 * 1024 * 1024) buf = Buffer.alloc(0);
    });

    vigiProcess.on('close', (code) => {
        console.warn(`⚠️  VIGI ffmpeg exited (${code}) — restart in 3s`);
        vigiProcess = null;
        vigiRestartTimer = setTimeout(startVigiStream, 3000);
    });

    vigiProcess.on('error', (err) => {
        console.error('VIGI ffmpeg error:', err.message);
        vigiProcess = null;
        vigiRestartTimer = setTimeout(startVigiStream, 3000);
    });
}

startVigiStream();

process.on('SIGTERM', () => { vigiProcess?.kill(); });
process.on('SIGINT',  () => { vigiProcess?.kill(); });

// snapshot — ส่ง frame ล่าสุดทันที (ใช้ตอนกดถ่ายเข้า OCR)
app.get('/api/vigi-snapshot', (req, res) => {
    if (!latestFrame) {
        return res.status(503).json({ status: 'error', message: 'กล้องยังไม่พร้อม กรุณารอสักครู่' });
    }
    res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
        'Content-Length': latestFrame.length,
    });
    res.send(latestFrame);
});

// MJPEG stream — *** แก้ double-sampling ***
// เดิม: setInterval(pushFrame, 66) re-sample buffer เองอีกชั้น → คนละ clock กับ ffmpeg → เฟรมค้าง
// ใหม่: push ทันทีที่ ffmpeg มีเฟรมใหม่ (event-driven) ไม่มี interval ไม่มี phase lag
app.get('/api/vigi-stream', (req, res) => {
    res.set({
        'Content-Type': 'multipart/x-mixed-replace; boundary=--mjpegframe',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let alive = true;
    const write = (frame) => {
        if (!alive) return;
        try {
            res.write('----mjpegframe\r\n');
            res.write('Content-Type: image/jpeg\r\n');
            res.write(`Content-Length: ${frame.length}\r\n\r\n`);
            res.write(frame);
            res.write('\r\n');
        } catch (e) {
            alive = false;
        }
    };

    // ส่งเฟรมล่าสุดทันที 1 เฟรม แล้วรอ push จาก ffmpeg ต่อ
    if (latestFrame) write(latestFrame);
    frameSubscribers.add(write);

    req.on('close', () => {
        alive = false;
        frameSubscribers.delete(write);
    });
});
