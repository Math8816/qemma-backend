// ═══════════════════════════════════════════════
//  src/routes/backup.js
//  النسخ الاحتياطي والاستعادة — كل شيء server-side
//  ✅ نداء واحد ينشئ النسخة
//  ✅ نداء واحد يستعيدها
// ═══════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  📋 قائمة الجداول (نفس ترتيب Frontend)
// ═══════════════════════════════════════════════
const TENANT_TABLES = [
  'users',
  'branches',
  'units',
  'categories',
  'companies',
  'sales_reps',
  'products',
  'product_units',
  'stock',
  'inventory_log',
  'customers',
  'suppliers',
  'ledger_entries',
  'accounting_periods',
  'period_closing_log',
  'sales_invoices',
  'sales_invoice_items',
  'purchase_invoices',
  'purchase_invoice_items',
  'returns',
  'return_items',
  'transactions',
  'operating_expenses',
  'operating_expense_entries',
  'loyalty_points',
  'loyalty_transactions',
  'employee_achievements',
  'employee_activity',
  'settings',
  'notifications',
];

// جداول لها organization_id بدل tenant_id
const ORG_SCOPED_TABLES = ['branches'];

const BACKUP_VERSION = '2.1';
const BACKUP_DIR = path.join(__dirname, '..', '..', 'storage', 'backups');

// ═══════════════════════════════════════════════
//  🔧 Helpers
// ═══════════════════════════════════════════════
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function requireAuth(req, res) {
  if (!req.user?.sub) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return false;
  }
  if (!req.user.tenant_id && !req.user.organization_id) {
    res.status(400).json({ ok: false, error: 'tenant_id or organization_id required' });
    return false;
  }
  return true;
}

function getScope(req) {
  const user = req.user;
  // Owner Premium+ → organization
  if (
    ['owner', 'org_admin'].includes(user.role) &&
    user.organization_id
  ) {
    return { id: user.organization_id, type: 'organization' };
  }
  return { id: user.tenant_id, type: 'tenant' };
}

// ═══════════════════════════════════════════════
//  🎯 جلب tenant_ids للسلسلة (إن scope = organization)
// ═══════════════════════════════════════════════
async function getTenantIds(user, scopeId, scopeType) {
  if (scopeType === 'tenant') return [scopeId];

  const r = await queryAsUser(
    user,
    `SELECT id FROM tenants WHERE organization_id = $1`,
    [scopeId]
  );
  return (r.rows || []).map((t) => t.id);
}

// ═══════════════════════════════════════════════
//  📥 جلب صفوف جدول معين (مع فلترة tenant/organization)
// ═══════════════════════════════════════════════
async function fetchTable(user, table, scopeId, scopeType, tenantIds) {
  try {
    let sql;
    let params;

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

    // استثناء developer من users
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

// ═══════════════════════════════════════════════
//  🗑️ حذف كل صفوف جدول (مع فلترة tenant/organization)
// ═══════════════════════════════════════════════
async function deleteTable(user, table, scopeId, scopeType, tenantIds) {
  try {
    // ⚠️ users لا تُحذف
    if (table === 'users') return { skipped: true };

    let sql;
    let params;

    if (ORG_SCOPED_TABLES.includes(table) && scopeType === 'organization') {
      sql = `DELETE FROM ${table} WHERE organization_id = $1`;
      params = [scopeId];
    } else if (scopeType === 'organization') {
      if (tenantIds.length === 0) return { deleted: 0 };
      sql = `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`;
      params = [tenantIds];
    } else {
      sql = `DELETE FROM ${table} WHERE tenant_id = $1`;
      params = [scopeId];
    }

    const result = await queryAsUser(user, sql, params);
    return { deleted: result.rowCount };
  } catch (err) {
    console.warn(`⚠️ delete ${table}:`, err.message);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════
//  📥 إدراج صفوف جدول — INSERT bulk
// ═══════════════════════════════════════════════
async function insertTable(user, table, rows) {
  if (!rows || rows.length === 0) return { inserted: 0 };

  try {
    // ─── users: UPSERT (لا حذف) ───
    if (table === 'users') {
      const fields = Object.keys(rows[0]);
      let inserted = 0;

      for (const row of rows) {
        const values = fields.map((f) => row[f]);
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const updates = fields
          .filter((f) => f !== 'id')
          .map((f) => `${f} = EXCLUDED.${f}`)
          .join(', ');

        try {
          await queryAsUser(
            user,
            `INSERT INTO users (${fields.join(', ')})
             VALUES (${placeholders})
             ON CONFLICT (id) DO UPDATE SET ${updates}`,
            values
          );
          inserted++;
        } catch (e) {
          console.warn(`⚠️ upsert user ${row.id}:`, e.message);
        }
      }
      return { inserted };
    }

    // ─── جداول عادية: INSERT بسيط ───
    // (بعد الحذف، لا يوجد تعارض)
    const fields = Object.keys(rows[0]);
    let inserted = 0;
    const errors = [];

    // إدراج دفعة بدفعة (chunks) — أسرع من صف بصف
    const CHUNK_SIZE = 100;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);

      try {
        // بناء query متعدد الصفوف
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
        inserted += chunk.length;
      } catch (err) {
        // fallback: صف بصف
        console.warn(`⚠️ bulk insert ${table} chunk failed, trying row-by-row`);
        for (const row of chunk) {
          try {
            const values = fields.map((f) => row[f]);
            const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(', ');
            await queryAsUser(
              user,
              `INSERT INTO ${table} (${fields.join(', ')})
               VALUES (${placeholders})
               ON CONFLICT (id) DO NOTHING`,
              values
            );
            inserted++;
          } catch (e) {
            errors.push(e.message);
          }
        }
      }
    }

    return { inserted, errors: errors.length > 0 ? errors : undefined };
  } catch (err) {
    console.error(`❌ insert ${table}:`, err.message);
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════
//  POST /api/backup/create
//  إنشاء نسخة احتياطية
// ═══════════════════════════════════════════════
router.post('/create', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const user = req.user;
    const { id: scopeId, type: scopeType } = getScope(req);

    ensureBackupDir();

    const tenantIds = await getTenantIds(user, scopeId, scopeType);

    // ─── جلب كل الجداول بالتوازي ───
    const tables = {};
    const counts = {};

    // نجلب كل جدول بالتوازي — أسرع بكثير
    const results = await Promise.all(
      TENANT_TABLES.map(async (table) => {
        const rows = await fetchTable(user, table, scopeId, scopeType, tenantIds);
        return { table, rows };
      })
    );

    for (const { table, rows } of results) {
      tables[table] = rows;
      counts[table] = rows.length;
    }

    const totalRecords = Object.values(counts).reduce((s, c) => s + c, 0);

    // ─── بناء كائن النسخة ───
    const backupData = {
      scope_id: scopeId,
      scope_type: scopeType,
      tenant_id: user.tenant_id || null,
      organization_id: user.organization_id || null,
      backup_date: new Date().toISOString(),
      version: BACKUP_VERSION,
      created_by: user.sub,
      tables,
      counts,
    };

    const jsonString = JSON.stringify(backupData, null, 2);
    const fileName = `backup-${scopeId}-${Date.now()}.json`;
    const filePath = path.join(BACKUP_DIR, fileName);

    fs.writeFileSync(filePath, jsonString, 'utf8');

    const size = Buffer.byteLength(jsonString, 'utf8');

    res.json({
      ok: true,
      fileName,
      scopeId,
      scopeType,
      totalRecords,
      totalTables: TENANT_TABLES.length,
      size,
      counts,
      backupDate: backupData.backup_date,
    });
  } catch (err) {
    console.error('POST /api/backup/create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/backup/list
//  قائمة النسخ الاحتياطية للمستخدم
// ═══════════════════════════════════════════════
router.get('/list', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    ensureBackupDir();

    const { id: scopeId } = getScope(req);
    const prefix = `backup-${scopeId}-`;

    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          name: f,
          size: stat.size,
          created_at: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ ok: true, files, count: files.length });
  } catch (err) {
    console.error('GET /api/backup/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/backup/restore/:fileName
//  استعادة من نسخة احتياطية
// ═══════════════════════════════════════════════
router.post('/restore/:fileName', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const user = req.user;
    const { id: scopeId, type: scopeType } = getScope(req);
    const { fileName } = req.params;

    // ─── فحص أمني: الملف يجب أن يكون داخل scope ───
    if (!fileName.startsWith(`backup-${scopeId}-`)) {
      return res.status(403).json({
        ok: false,
        error: 'Backup does not belong to your scope',
      });
    }

    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'Backup file not found' });
    }

    const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // ─── التحقق من النسخة ───
    if (backupData.scope_id !== scopeId) {
      return res.status(403).json({
        ok: false,
        error: 'Backup scope mismatch',
      });
    }

    if (!backupData.tables || typeof backupData.tables !== 'object') {
      return res.status(400).json({
        ok: false,
        error: 'Corrupted backup file',
      });
    }

    const tenantIds = await getTenantIds(user, scopeId, scopeType);

    // ═══════════════════════════════════════════════
    //  PHASE 1: حذف (بترتيب معكوس)
    // ═══════════════════════════════════════════════
    const reverseTables = [...TENANT_TABLES].reverse();
    const deleteErrors = [];

    for (const table of reverseTables) {
      const result = await deleteTable(user, table, scopeId, scopeType, tenantIds);
      if (result?.error) {
        deleteErrors.push({ table, error: result.error });
      }
    }

    // ═══════════════════════════════════════════════
    //  PHASE 2: إدراج (بترتيب صحيح)
    // ═══════════════════════════════════════════════
    const insertErrors = [];
    let totalInserted = 0;

    for (const table of TENANT_TABLES) {
      const rows = backupData.tables[table] || [];
      if (rows.length === 0) continue;

      const result = await insertTable(user, table, rows);
      if (result?.inserted) totalInserted += result.inserted;
      if (result?.error || result?.errors) {
        insertErrors.push({
          table,
          error: result.error || result.errors?.join('; '),
        });
      }
    }

    const allErrors = [...deleteErrors, ...insertErrors];

    res.json({
      ok: true,
      totalInserted,
      totalTables: TENANT_TABLES.length,
      errors: allErrors.length > 0 ? allErrors : undefined,
      message: allErrors.length === 0
        ? 'تمت الاستعادة بنجاح'
        : `تمت الاستعادة مع ${allErrors.length} تحذير`,
    });
  } catch (err) {
    console.error('POST /api/backup/restore error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/backup/download/:fileName
//  تنزيل ملف النسخة
// ═══════════════════════════════════════════════
router.get('/download/:fileName', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { id: scopeId } = getScope(req);
    const { fileName } = req.params;

    if (!fileName.startsWith(`backup-${scopeId}-`)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }

    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('GET /api/backup/download error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/backup/:fileName
// ═══════════════════════════════════════════════
router.delete('/:fileName', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { id: scopeId } = getScope(req);
    const { fileName } = req.params;

    if (!fileName.startsWith(`backup-${scopeId}-`)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const filePath = path.join(BACKUP_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }

    fs.unlinkSync(filePath);
    res.json({ ok: true, deleted: fileName });
  } catch (err) {
    console.error('DELETE /api/backup error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;