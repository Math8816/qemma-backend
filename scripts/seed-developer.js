// ═══════════════════════════════════════════════════════════
//  scripts/seed-developer.js
//  إنشاء حساب Developer
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../src/db');

// ─── عدّل هنا ───
const DEVELOPER = {
  email: 'developer@qemma.com',
  password: 'Admin123',
  full_name: 'Developer',
};

async function seed() {
  try {
    console.log('\n🔧 Creating developer account...\n');

    // ─── 1. فحص وجود المستخدم ───
    const { rows: existing } = await pool.query(
      `SELECT id, email, role FROM users WHERE email = $1`,
      [DEVELOPER.email.toLowerCase().trim()]
    );

    if (existing.length > 0) {
      console.log('⚠️  User already exists:');
      console.log(`   Email: ${existing[0].email}`);
      console.log(`   Role: ${existing[0].role}`);
      console.log(`   ID: ${existing[0].id}`);
      console.log('\n💡 To reset password, run:');
      console.log(`   node scripts/reset-developer.js ${DEVELOPER.email}\n`);
      process.exit(0);
    }

    // ─── 2. تشفير كلمة المرور ───
    const passwordHash = await bcrypt.hash(DEVELOPER.password, 10);

    // ─── 3. إدراج المستخدم ───
    const id = crypto.randomUUID();

    const { rows } = await pool.query(
      `INSERT INTO users
        (id, email, full_name, role, password_hash, is_active, invite_status,
         tenant_id, organization_id)
       VALUES ($1, $2, $3, 'developer', $4, true, 'accepted', NULL, NULL)
       RETURNING id, email, full_name, role, is_active, created_at`,
      [id, DEVELOPER.email.toLowerCase().trim(), DEVELOPER.full_name, passwordHash]
    );

    console.log('✅ Developer created successfully!\n');
    console.log('═══════════════════════════════════════');
    console.log('  📧 Email:    ', rows[0].email);
    console.log('  🔑 Password: ', DEVELOPER.password);
    console.log('  🆔 ID:       ', rows[0].id);
    console.log('  👤 Role:     ', rows[0].role);
    console.log('═══════════════════════════════════════\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

seed();