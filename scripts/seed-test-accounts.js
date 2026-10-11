// ═══════════════════════════════════════════════════════════
//  scripts/seed-test-accounts.js
//  إنشاء حسابات اختبار: owner, store_admin, employee
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../src/db');

async function seed() {
  console.log('\n🌱 Creating test accounts...\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ═══════════════════════════════════════════════════════
    //  1. إنشاء Organization
    // ═══════════════════════════════════════════════════════
    const orgId = crypto.randomUUID();
    await client.query(
      `INSERT INTO organizations
        (id, name, plan, max_branches, current_branches, is_active,
         subscription_status, subscription_started_at, subscription_expires_at)
       VALUES ($1, 'سلسلة الاختبار', 'premium', 3, 1, true,
               'active', NOW(), NOW() + INTERVAL '365 days')
       ON CONFLICT (id) DO NOTHING`,
      [orgId]
    );
    console.log(`✅ Organization: ${orgId}`);

    // ═══════════════════════════════════════════════════════
    //  2. إنشاء Tenant (فرع HQ)
    // ═══════════════════════════════════════════════════════
    const tenantId = crypto.randomUUID();
    await client.query(
      `INSERT INTO tenants
        (id, name, email, organization_id, subscription_plan,
         subscription_status, subscription_started_at,
         subscription_expires_at, is_active)
       VALUES ($1, 'فرع الاختبار', 'test@example.com', $2, 'standard_plus',
               'active', NOW(), NOW() + INTERVAL '365 days', true)
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, orgId]
    );
    console.log(`✅ Tenant: ${tenantId}`);

    // ═══════════════════════════════════════════════════════
    //  3. إنشاء Branch
    // ═══════════════════════════════════════════════════════
    const branchId = crypto.randomUUID();
    await client.query(
      `INSERT INTO branches
        (id, organization_id, tenant_id, name, code, is_hq, is_active)
       VALUES ($1, $2, $3, 'الفرع الرئيسي', 'HQ', true, true)
       ON CONFLICT (id) DO NOTHING`,
      [branchId, orgId, tenantId]
    );
    console.log(`✅ Branch: ${branchId}`);

    // ═══════════════════════════════════════════════════════
    //  4. الحسابات
    // ═══════════════════════════════════════════════════════
    const passwordHash = await bcrypt.hash('Admin123', 10);

    const accounts = [
      {
        email: 'owner@qemma.com',
        full_name: 'Test Owner',
        role: 'owner',
        tenant_id: null,
        organization_id: orgId,
      },
      {
        email: 'org_admin@qemma.com',
        full_name: 'Test Org Admin',
        role: 'org_admin',
        tenant_id: null,
        organization_id: orgId,
      },
      {
        email: 'store_admin@qemma.com',
        full_name: 'Test Store Admin',
        role: 'store_admin',
        tenant_id: tenantId,
        organization_id: orgId,
      },
      {
        email: 'employee@qemma.com',
        full_name: 'Test Employee',
        role: 'employee',
        tenant_id: tenantId,
        organization_id: orgId,
      },
    ];

    for (const acc of accounts) {
      const userId = crypto.randomUUID();
      await client.query(
        `INSERT INTO users
          (id, email, full_name, role, password_hash, tenant_id, organization_id,
           is_active, invite_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'accepted')
         ON CONFLICT (email) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           tenant_id = EXCLUDED.tenant_id,
           organization_id = EXCLUDED.organization_id`,
        [
          userId,
          acc.email,
          acc.full_name,
          acc.role,
          passwordHash,
          acc.tenant_id,
          acc.organization_id,
        ]
      );
      console.log(`✅ User: ${acc.email} (${acc.role})`);
    }

    await client.query('COMMIT');

    console.log('\n═══════════════════════════════════════');
    console.log('📋 Test Accounts (Password: Admin123)');
    console.log('═══════════════════════════════════════');
    console.log(`  owner@qemma.com         → Owner`);
    console.log(`  org_admin@qemma.com     → Org Admin`);
    console.log(`  store_admin@qemma.com   → Store Admin`);
    console.log(`  employee@qemma.com      → Employee`);
    console.log('\n═══════════════════════════════════════');
    console.log(`  Organization ID: ${orgId}`);
    console.log(`  Tenant ID:       ${tenantId}`);
    console.log('═══════════════════════════════════════\n');

    // ─── احفظ الـ IDs في ملف (للاختبارات) ───
    const fs = require('fs');
    const path = require('path');
    const idsPath = path.join(__dirname, '..', 'test-ids.json');
    fs.writeFileSync(
      idsPath,
      JSON.stringify(
        {
          organizationId: orgId,
          tenantId: tenantId,
          branchId: branchId,
          accounts: accounts.map((a) => a.email),
        },
        null,
        2
      )
    );
    console.log(`📁 IDs saved to: ${idsPath}\n`);

    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Seed error:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

seed();