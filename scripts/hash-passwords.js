// ═══════════════════════════════════════════════
//  scripts/hash-passwords.js
//  توليد password_hash للمستخدمين الحاليين
// ═══════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/db');

const PASSWORD = 'Admin123';  // كلمة مرور موحدة للاختبار

async function hashAll() {
  try {
    console.log('🔐 Hashing passwords...');
    const hash = await bcrypt.hash(PASSWORD, 10);
    console.log('✅ Hash:', hash);

    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE password_hash IS NULL',
      [hash]
    );

    console.log(`✅ Updated ${rowCount} users`);

    const { rows } = await pool.query(
      'SELECT id, email, full_name, role FROM users WHERE password_hash IS NOT NULL'
    );

    console.log('\n📋 Users with passwords:');
    rows.forEach(u => console.log(`   ${u.email} (${u.role})`));

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

hashAll();