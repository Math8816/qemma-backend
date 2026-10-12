// scripts/migrate-backups.js
require('dotenv').config();
const pool = require('../src/db');

async function migrate() {
  console.log('\n🔧 Migrating backups table...\n');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('1️⃣ Creating table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'organization')),
        scope_id UUID NOT NULL,
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
        data_compressed TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        size_compressed_bytes INTEGER NOT NULL DEFAULT 0,
        tables_count INTEGER DEFAULT 0,
        records_count INTEGER DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_by_email TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        notes TEXT,
        version TEXT DEFAULT '2.1'
      )
    `);

    console.log('2️⃣ Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backups_scope 
      ON backups(scope_type, scope_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backups_tenant 
      ON backups(tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backups_org 
      ON backups(organization_id, created_at DESC) WHERE organization_id IS NOT NULL
    `);

    await client.query('COMMIT');

    // Verify
    const { rows } = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'backups'
      ORDER BY ordinal_position
    `);

    console.log('\n✅ Migration complete!\n');
    console.log('📋 Columns:');
    rows.forEach((c) => {
      console.log(`   ${c.column_name.padEnd(25)} ${c.data_type}`);
    });

    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

migrate();