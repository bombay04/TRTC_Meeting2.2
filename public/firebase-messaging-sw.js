// firebase-messaging-sw.js
// Service Worker สำหรับรับ Push Notification ตอนปิด browser

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyDiOzGY6GDE0qJaDdW5KNE4qSFlg_wHWnE",
    authDomain: "village-guard.firebaseapp.com",
    projectId: "village-guard",
    storageBucket: "village-guard.firebasestorage.app",
    messagingSenderId: "785165712870",
    appId: "1:785165712870:web:ea0b0f8408448fe88e2a27"
});

const messaging = firebase.messaging();

// รับ notification ตอนอยู่ background / ปิด tab
messaging.onBackgroundMessage((payload) => {
    console.log('[SW] Background message:', payload);
    const { title, body } = payload.notification;
    self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        requireInteraction: true,
        vibrate: [200, 100, 200],
        data: payload.fcmOptions?.link || '/'
    });
});

// คลิก notification → เปิดหน้าเว็บ
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // ถ้ามี tab เปิดอยู่แล้ว focus แทน
            for (const client of clientList) {
                if (client.url.includes('resident.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            // ไม่มี tab → เปิดใหม่
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});