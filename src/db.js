// ═══════════════════════════════════════════════
//  src/db.js
//  اتصال قاعدة البيانات — PostgreSQL Pool
// ═══════════════════════════════════════════════

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ─── سجل الأخطاء ───
pool.on('error', (err) => {
  console.error('❌ DB Pool Error:', err.message);
});

// ─── اختبار الاتصال ───
pool.query('SELECT NOW()')
  .then(({ rows }) => {
    console.log('✅ DB Connected:', rows[0].now);
  })
  .catch((err) => {
    console.error('❌ DB Connection Failed:', err.message);
  });

module.exports = pool;