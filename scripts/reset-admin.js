// ═══════════════════════════════════════════════
//  scripts/reset-admin.js
//  إعادة تعيين كلمة مرور admin
// ═══════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/db');

const EMAIL = 'admin@qemma.local';
const NEW_PASSWORD = 'Admin123';

async function reset() {
  try {
    const hash = await bcrypt.hash(NEW_PASSWORD, 10);
    const { rowCount } = await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2',
      [hash, EMAIL]
    );

    if (rowCount === 0) {
      console.error(`❌ المستخدم ${EMAIL} غير موجود`);
      process.exit(1);
    }

    console.log(`✅ تم تحديث كلمة مرور ${EMAIL}`);
    console.log(`   كلمة المرور الجديدة: ${NEW_PASSWORD}`);

    // عرض كل المستخدمين
    const { rows } = await pool.query('SELECT email, role FROM users ORDER BY email');
    console.log('\n📋 المستخدمون:');
    rows.forEach((u) => console.log(`   ${u.email} (${u.role})`));

    process.exit(0);
  } catch (err) {
    console.error('❌ خطأ:', err.message);
    process.exit(1);
  }
}

reset();