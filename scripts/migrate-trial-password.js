// ═══════════════════════════════════════════════════════════
//  scripts/migrate-trial-password.js
//  إضافة password_hash لـ trial_signups
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/db');

async function migrate() {
  console.log('\n🔧 Migrating trial_signups...\n');

  try {
    // ═══ 1. فحص وجود العمود ═══
    const { rows: cols } = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns
      WHERE table_name = 'trial_signups' 
        AND column_name = 'password_hash'
    `);

    if (cols.length === 0) {
      console.log('➕ Adding password_hash column...');
      await pool.query(`
        ALTER TABLE trial_signups
        ADD COLUMN password_hash TEXT
      `);
      console.log('✅ Column added');
    } else {
      console.log('ℹ️  Column already exists');
    }

    // ═══ 2. تعيين كلمة المرور الافتراضية للمستخدمين الحاليين ═══
    const defaultHash = await bcrypt.hash('Trial123!', 10);

    const { rowCount } = await pool.query(
      `UPDATE trial_signups 
       SET password_hash = $1 
       WHERE password_hash IS NULL`,
      [defaultHash]
    );

    console.log(`✅ Updated ${rowCount} existing trial users with default password`);

    // ═══ 3. التحقق ═══
    const { rows } = await pool.query(`
      SELECT id, email, password_hash IS NOT NULL AS has_password
      FROM trial_signups
      LIMIT 5
    `);

    console.log('\n📋 Sample trials:');
    rows.forEach((r) => {
      console.log(`   ${r.email} → ${r.has_password ? '✅' : '❌'}`);
    });

    console.log('\n✅ Migration complete!\n');
    console.log('🔑 Default password for existing trials: Trial123!\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Migration error:', err.message);
    process.exit(1);
  }
}

migrate();