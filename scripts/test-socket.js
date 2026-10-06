// ═══════════════════════════════════════════════
//  scripts/test-socket.js
//  اختبار Socket.io
// ═══════════════════════════════════════════════

const { io } = require('socket.io-client');
const http = require('http');

// ─── 1. Login ───
async function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      email: 'admin@qemma.local',
      password: 'Admin123',
    });

    const req = http.request(
      {
        hostname: 'localhost',
        port: 4000,
        path: '/auth/v1/token?grant_type=password',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.access_token);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ───
(async () => {
  console.log('\n🔌 Testing Socket.io...\n');

  // 1. Login
  console.log('1️⃣ Logging in...');
  const token = await login();
  console.log(`✅ Token: ${token.substring(0, 30)}...\n`);

  // 2. Connect
  console.log('2️⃣ Connecting socket...');
  const socket = io('http://localhost:4000', {
    auth: { token },
  });

  socket.on('connect', () => {
    console.log(`✅ Connected (ID: ${socket.id})\n`);
  });

  socket.on('connect_error', (err) => {
    console.error(`❌ Connection error: ${err.message}`);
    process.exit(1);
  });

  // 3. Audit events
  socket.on('audit:new', (data) => {
    console.log('🔔 AUDIT EVENT RECEIVED:');
    console.log(JSON.stringify(data, null, 2));
    console.log('');
  });

  // 4. Ping test
  socket.on('pong', (data) => {
    console.log(`🏓 Pong received: ${data.time}\n`);
  });

  setTimeout(() => {
    console.log('📡 Sending ping...');
    socket.emit('ping');
  }, 2000);

  // 5. Keep alive
  console.log('⏳ Listening for events (60 seconds)...\n');
  console.log('👉 الآن، افتح React وأضف عميلاً أو منتجاً.\n');

  setTimeout(() => {
    console.log('🔌 Disconnecting...');
    socket.disconnect();
    process.exit(0);
  }, 60000);
})();