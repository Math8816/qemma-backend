// src/services/backup/backupService.js
// ═══════════════════════════════════════════════════════════
//  🎯 Backup Service — منطق النسخ (generic)
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');
const backupStorage = require('./index');
const { queryAsUser } = require('../../db-rls');

const TENANT_TABLES = [
  'users', 'branches', 'units', 'categories', 'companies',
  'sales_reps', 'products', 'product_units', 'stock',
  'inventory_log', 'customers', 'suppliers', 'ledger_entries',
  'accounting_periods', 'period_closing_log', 'sales_invoices',
  'sales_invoice_items', 'purchase_invoices', 'purchase_invoice_items',
  'returns', 'return_items', 'transactions', 'operating_expenses',
  'operating_expense_entries', 'loyalty_points', 'loyalty_transactions',
  'employee_achievements', 'employee_activity', 'settings', 'notifications',
  'audit_log', 'idempotency_keys', 'trial_signups', 'password_resets', 'email_verifications',
];

const ORG_SCOPED_TABLES = ['branches'];

// ═══════════════════════════════════════════════════════════
//  📥 Fetch a table
// ═══════════════════════════════════════════════════════════
async function fetchTable(user, table, scopeId, scopeType, tenantIds) {
  try {
    let sql, params;

    if (ORG_SCOPED_TABLES.includes(table) && scopeType === 'organization') {
      sql = `SELECT * FROM ${table} WHERE organization_id = $1`;
      params = [scopeId];
    } else if (scopeType === 'organization') {
      if (tenantIds.length === 0) return [];
      sql = `SELECT * FROM ${table} WHERE tenant_id = ANY($1::uuid[])`;
      params = [tenantIds];
    } else {
      sql = `SELECT * FROM ${table} WHERE tenant_id = $1`;
      params = [scopeId];
    }

    if (table === 'users') {
      sql += ` AND role != 'developer'`;
    }

    const result = await queryAsUser(user, sql, params);
    return result.rows || [];
  } catch (err) {
    console.warn(`⚠️ fetch ${table}:`, err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
//  💾 Create Backup
// ═══════════════════════════════════════════════════════════
async function createBackup(user, scopeId, scopeType, metadata = {}) {
  // 1. Get tenantIds (للسلاسل)
  let tenantIds = [scopeId];
  if (scopeType === 'organization') {
    const r = await queryAsUser(
      user,
      `SELECT id FROM tenants WHERE organization_id = $1`,
      [scopeId]
    );
    tenantIds = (r.rows || []).map((t) => t.id);
  }

  // 2. Fetch all tables in parallel
  const results = await Promise.all(
    TENANT_TABLES.map(async (table) => {
      const rows = await fetchTable(user, table, scopeId, scopeType, tenantIds);
      return { table, rows };
    })
  );

  // 3. Build backup data
  const tables = {};
  const counts = {};
  for (const { table, rows } of results) {
    tables[table] = rows;
    counts[table] = rows.length;
  }

  const totalRecords = Object.values(counts).reduce((s, c) => s + c, 0);

  const backupData = {
    scope_id: scopeId,
    scope_type: scopeType,
    tenant_id: user.tenant_id || null,
    organization_id: user.organization_id || null,
    backup_date: new Date().toISOString(),
    version: '2.1',
    created_by: user.sub,
    tables,
    counts,
  };

  // 4. Save via Adapter
  const id = crypto.randomUUID();
  const saved = await backupStorage.save(id, scopeType, scopeId, backupData, {
    tenant_id: user.tenant_id || null,
    organization_id: user.organization_id || null,
    tables_count: TENANT_TABLES.length,
    records_count: totalRecords,
    created_by: user.sub,
    created_by_email: user.email,
    version: '2.1',
  });

  // 5. Cleanup old (احتفظ بأحدث 10)
  await backupStorage.cleanup(scopeType, scopeId, backupStorage.config.maxBackupsPerScope);

  return {
    id: saved.id,
    scopeId,
    scopeType,
    totalRecords,
    totalTables: TENANT_TABLES.length,
    size: saved.sizeBytes,
    sizeCompressed: saved.sizeCompressed,
    counts,
    backupDate: backupData.backup_date,
  };
}

// ═══════════════════════════════════════════════════════════
//  📥 Restore Backup
// ═══════════════════════════════════════════════════════════
async function restoreBackup(user, backupId, scopeId, scopeType) {
  // 1. Load
  const { data: backupData, metadata } = await backupStorage.load(backupId);

  if (backupData.scope_id !== scopeId) {
    throw new Error('Backup scope mismatch');
  }

  // 2. Get tenantIds
  let tenantIds = [scopeId];
  if (scopeType === 'organization') {
    const r = await queryAsUser(
      user,
      `SELECT id FROM tenants WHERE organization_id = $1`,
      [scopeId]
    );
    tenantIds = (r.rows || []).map((t) => t.id);
  }

  // 3. Delete (reverse order)
  const reverseTables = [...TENANT_TABLES].reverse();
  for (const table of reverseTables) {
    if (table === 'users') continue;
    try {
      let sql, params;
      if (ORG_SCOPED_TABLES.includes(table) && scopeType === 'organization') {
        sql = `DELETE FROM ${table} WHERE organization_id = $1`;
        params = [scopeId];
      } else if (scopeType === 'organization') {
        if (tenantIds.length === 0) continue;
        sql = `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`;
        params = [tenantIds];
      } else {
        sql = `DELETE FROM ${table} WHERE tenant_id = $1`;
        params = [scopeId];
      }
      await queryAsUser(user, sql, params);
    } catch (err) {
      console.warn(`⚠️ delete ${table}:`, err.message);
    }
  }

  // 4. Insert (normal order)
  let totalInserted = 0;
  for (const table of TENANT_TABLES) {
    const rows = backupData.tables[table] || [];
    if (rows.length === 0) continue;

    // ─── users: UPSERT ───
    if (table === 'users') {
      for (const row of rows) {
        try {
          const fields = Object.keys(row);
          const values = fields.map((f) => row[f]);
          const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
          const updates = fields
            .filter((f) => f !== 'id')
            .map((f) => `${f} = EXCLUDED.${f}`)
            .join(', ');

          await queryAsUser(
            user,
            `INSERT INTO users (${fields.join(', ')})
             VALUES (${placeholders})
             ON CONFLICT (id) DO UPDATE SET ${updates}`,
            values
          );
          totalInserted++;
        } catch (e) {
          console.warn(`⚠️ upsert user:`, e.message);
        }
      }
      continue;
    }

    // ─── جداول أخرى: Bulk INSERT ───
    const CHUNK_SIZE = 100;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      try {
        const fields = Object.keys(chunk[0]);
        const allValues = [];
        const valueGroups = [];

        for (const row of chunk) {
          const rowPlaceholders = fields.map((f) => {
            allValues.push(row[f]);
            return `$${allValues.length}`;
          });
          valueGroups.push(`(${rowPlaceholders.join(', ')})`);
        }

        await queryAsUser(
          user,
          `INSERT INTO ${table} (${fields.join(', ')})
           VALUES ${valueGroups.join(', ')}
           ON CONFLICT (id) DO NOTHING`,
          allValues
        );
        totalInserted += chunk.length;
      } catch (err) {
        console.warn(`⚠️ bulk insert ${table} failed`);
      }
    }
  }

  return {
    totalInserted,
    totalTables: TENANT_TABLES.length,
    metadata,
  };
}

module.exports = {
  createBackup,
  restoreBackup,
  TENANT_TABLES,
};