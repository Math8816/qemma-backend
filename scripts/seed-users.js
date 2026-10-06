// ═══════════════════════════════════════════════
//  scripts/seed-users.js
//  إنشاء 2 مستخدمين جدد
// ═══════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../src/db');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const USERS = [
  {
    email: 'admin@qemma.local',
    full_name: 'مدير النظام',
    role: 'store_admin',
    password: 'Admin123',
    tenant_id: TENANT_A,
    organization_id: ORG_A,
  },
  {
    email: 'user@qemma.local',
    full_name: 'مستخدم تجريبي',
    role: 'store_admin',
    password: 'Admin123',
    tenant_id: TENANT_B,
    organization_id: ORG_B,
  },
];

async function seed() {
  try {
    console.log('\n🌱 Seeding users...\n');

    for (const u of USERS) {
      // تحقق من وجود المستخدم
      const { rows: existing } = await pool.query(
        'SELECT id FROM users WHERE email = $1',
        [u.email]
      );

      if (existing.length > 0) {
        console.log(`⏭️  ${u.email} — موجود مسبقاً`);
        continue;
      }

      const id = crypto.randomUUID();
      const hash = await bcrypt.hash(u.password, 10);

      await pool.query(
        `INSERT INTO users 
         (id, email, full_name, role, password_hash, tenant_id, organization_id, is_active, invite_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'accepted')`,
        [id, u.email, u.full_name, u.role, hash, u.tenant_id, u.organization_id]
      );

      console.log(`✅ ${u.email}`);
      console.log(`   الاسم: ${u.full_name}`);
      console.log(`   الدور: ${u.role}`);
      console.log(`   كلمة المرور: ${u.password}`);
      console.log('');
    }

    const { rows } = await pool.query(
      'SELECT email, full_name, role FROM users ORDER BY email'
    );

    console.log('═══════════════════════════════════');
    console.log('📋 المستخدمون الحاليون:');
    console.log('═══════════════════════════════════');
    rows.forEach(u => {
      console.log(`   ${u.email.padEnd(30)} | ${u.role.padEnd(15)} | ${u.full_name}`);
    });
    console.log('═══════════════════════════════════\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

seed();