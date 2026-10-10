// ═══════════════════════════════════════════════
//  src/routes/generic.js
//  Generic CRUD — يدعم صيغتي الفلترة
//  ✅ مباشر: ?tenant_id=xxx
//  ✅ QueryBuilder: ?filter[0][op]=eq&filter[0][col]=tenant_id&filter[0][val]=xxx
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  Whitelist — كما في النسخة الحالية (آمن)
// ═══════════════════════════════════════════════
const ALLOWED_TABLES = [
  // ─── تعاريف أساسية ───
  'products',
  'customers',
  'suppliers',
  'categories',
  'companies',
  'units',
  'sales_reps',
  'branches',

  // ─── فواتير ───
  'sales_invoices',
  'sales_invoice_items',
  'purchase_invoices',
  'purchase_invoice_items',
  'returns',
  'return_items',

  // ─── حسابات ───
  'transactions',
  'ledger_entries',
  'accounting_periods',
  'period_closing_log',

  // ═══ جديدة — كانت مفقودة ═══
  'loyalty_transactions',
  'loyalty_points',
  'loyalty_tiers',
  'expense_entries',
  'operating_expenses',
  'operating_expense_categories',

  // ─── مخزون ───
  'stock',
  'product_units',
  'inventory_log',

  // ─── نظام ───
  'notifications',
  'admin_settings',
  'settings',
  'tenants',
  'organizations',
  'users',
  'trial_signups',
];

// ─── حقول الفلترة المباشرة (للتوافق) ───
const DIRECT_FILTERS = [
  'tenant_id', 'organization_id', 'category_id', 'company_id',
  'unit_id', 'product_id', 'customer_id', 'supplier_id',
  'branch_id', 'sales_rep_id', 'invoice_id', 'return_id',
];

// ─── حقول الفلترة المسموحة عبر filter[i][op] ───
const ALLOWED_FILTER_COLS = new Set([
  ...DIRECT_FILTERS,
  'id', 'user_id', 'account_id', 'period_id',
  'email', 'is_active', 'is_hq', 'status', 'role',
  'entry_type', 'account_type', 'type', 'key',
]);

// ─── حقول الترتيب المسموحة ───
const ALLOWED_SORT_FIELDS = new Set([
  'id', 'name', 'full_name', 'created_at', 'updated_at',
  'email', 'balance', 'date', 'entry_date', 'total', 'quantity',
]);

// ─── Helper: التحقق من الجدول ───
function isTableAllowed(table) {
  return ALLOWED_TABLES.includes(table);
}

// ─── Helper: تحليل الفلاتر ───
function parseFilters(query) {
  const where = [];
  const params = [];

  // 1. الفلاتر المباشرة
  DIRECT_FILTERS.forEach((f) => {
    if (query[f]) {
      params.push(query[f]);
      where.push(`${f} = $${params.length}`);
    }
  });

  // 2. صيغة filter[i][op] (من QueryBuilder)
  const groups = {};
  Object.keys(query).forEach((k) => {
    const m = k.match(/^filter\[(\d+)\]\[(.+)\]$/);
    if (m) {
      if (!groups[m[1]]) groups[m[1]] = {};
      groups[m[1]][m[2]] = query[k];
    }
  });

  Object.values(groups).forEach((g) => {
    const { op, col, val } = g;
    if (!col || !ALLOWED_FILTER_COLS.has(col)) return;

    let parsed = val;
    try { parsed = JSON.parse(val); } catch { /* keep string */ }

    switch (op) {
      case 'eq':
        params.push(parsed);
        where.push(`${col} = $${params.length}`);
        break;
      case 'neq':
        params.push(parsed);
        where.push(`${col} != $${params.length}`);
        break;
      case 'gt':
        params.push(parsed);
        where.push(`${col} > $${params.length}`);
        break;
      case 'gte':
        params.push(parsed);
        where.push(`${col} >= $${params.length}`);
        break;
      case 'lt':
        params.push(parsed);
        where.push(`${col} < $${params.length}`);
        break;
      case 'lte':
        params.push(parsed);
        where.push(`${col} <= $${params.length}`);
        break;
      case 'in':
        if (Array.isArray(parsed) && parsed.length > 0) {
          const ph = parsed.map((v) => { params.push(v); return `$${params.length}`; });
          where.push(`${col} IN (${ph.join(',')})`);
        }
        break;
      case 'is':
        if (parsed === null) where.push(`${col} IS NULL`);
        else if (parsed === true) where.push(`${col} = true`);
        else if (parsed === false) where.push(`${col} = false`);
        break;
      case 'not.eq':
        params.push(parsed);
        where.push(`${col} != $${params.length}`);
        break;
      case 'not.in':
        if (Array.isArray(parsed) && parsed.length > 0) {
          const ph = parsed.map((v) => { params.push(v); return `$${params.length}`; });
          where.push(`${col} NOT IN (${ph.join(',')})`);
        }
        break;
      case 'not.is':
        if (parsed === null) where.push(`${col} IS NOT NULL`);
        break;
    }
  });

  return { where, params };
}

// ─── Helper: تحليل الترتيب (صيغتان) ───
function parseOrder(query) {
  // صيغة QueryBuilder: order=col.desc
  if (query.order && typeof query.order === 'string' && query.order.includes('.')) {
    const [col, dir] = query.order.split('.');
    if (ALLOWED_SORT_FIELDS.has(col)) {
      return {
        col,
        dir: dir?.toLowerCase() === 'desc' ? 'DESC' : 'ASC',
      };
    }
  }

  // الصيغة القديمة: sort=col&order=asc/desc
  const sortField = query.sort || 'created_at';
  const sortOrder = String(query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  return {
    col: ALLOWED_SORT_FIELDS.has(sortField) ? sortField : 'created_at',
    dir: sortOrder,
  };
}

// ═══════════════════════════════════════════════
//  GET /api/generic/:table
// ═══════════════════════════════════════════════
router.get('/:table', optionalAuth, async (req, res) => {
  try {
    const { table } = req.params;
    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user || { sub: null };

    // ─── Pagination ───
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;

    // ─── Search ───
    const search = req.query.search ? String(req.query.search).trim() : null;

    // ─── Filters ───
    const { where, params } = parseFilters(req.query);

    // ─── Search ───
    if (search) {
      const SEARCHABLE_FIELDS = {
        products: ['name'],
        customers: ['full_name', 'phone', 'email'],
        suppliers: ['name', 'phone', 'email'],
        categories: ['name'],
        companies: ['name', 'email'],
        units: ['name', 'symbol'],
        sales_reps: ['full_name', 'phone', 'email'],
        branches: ['name', 'code'],
        sales_invoices: ['invoice_number', 'customer_name'],
        purchase_invoices: ['invoice_number', 'supplier_name'],
        returns: ['return_number', 'customer_name', 'supplier_name'],
        notifications: ['title', 'message'],
        settings: ['key', 'value'],
        transactions: ['account_name', 'notes'],
        loyalty_tiers: ['name'],
      };

      const searchFields = SEARCHABLE_FIELDS[table] || ['name'];
      const conditions = searchFields.map((f) => {
        params.push(`%${search}%`);
        return `${f} ILIKE $${params.length}`;
      });
      where.push(`(${conditions.join(' OR ')})`);
    }

    const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';

    // ─── Order ───
    const { col: sortCol, dir: sortDir } = parseOrder(req.query);

    // ─── Count ───
    const countRes = await queryAsUser(
      user,
      `SELECT COUNT(*)::int AS total FROM ${table}${whereClause}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    // ─── Data ───
    const dataParams = [...params, limit, offset];
    const dataRes = await queryAsUser(
      user,
      `SELECT * FROM ${table}
       ${whereClause}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      ok: true,
      table,
      count: dataRes.rows.length,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      filters: {
        search,
        sort: sortCol,
        order: sortDir.toLowerCase(),
      },
      data: dataRes.rows,
    });
  } catch (err) {
    console.error(`GET /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/generic/:table/:id
// ═══════════════════════════════════════════════
router.get('/:table/:id', optionalAuth, async (req, res) => {
  try {
    const { table, id } = req.params;
    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT * FROM ${table} WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found' });
    }

    res.json({ ok: true, table, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/generic/:table
//  ✅ يدعم كائن واحد أو مصفوفة (لـ QueryBuilder.insert)
// ═══════════════════════════════════════════════
router.post('/:table', optionalAuth, async (req, res) => {
  try {
    const { table } = req.params;
    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // ✅ يقبل مصفوفة أو كائن
    const rows = Array.isArray(req.body) ? req.body : [req.body];

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'No data provided' });
    }

    const inserted = [];
    for (const rawRow of rows) {
      const data = { ...rawRow };
      if (user.tenant_id && !data.tenant_id) data.tenant_id = user.tenant_id;
      if (user.organization_id && !data.organization_id) {
        data.organization_id = user.organization_id;
      }

      const fields = Object.keys(data);
      if (fields.length === 0) {
        return res.status(400).json({ ok: false, error: 'Empty row' });
      }

      const values = Object.values(data);
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');

      const result = await queryAsUser(
        user,
        `INSERT INTO ${table} (${fields.join(', ')})
         VALUES (${placeholders})
         RETURNING *`,
        values
      );
      inserted.push(result.rows[0]);
    }

    await req.audit({
      action: 'create',
      tableName: table,
      recordId: inserted[0]?.id,
      newData: inserted,
    });

    // ✅ إذا كان المُدخل كائنًا، أعِد كائنًا
    const responseData = Array.isArray(req.body) ? inserted : inserted[0];
    res.status(201).json({ ok: true, table, data: responseData });
  } catch (err) {
    console.error(`POST /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/generic/:table/:id
// ═══════════════════════════════════════════════
router.put('/:table/:id', optionalAuth, async (req, res) => {
  try {
    const { table, id } = req.params;
    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const data = { ...req.body };
    delete data.id;
    delete data.created_at;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields provided' });
    }

    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');

    values.push(id);

    const result = await queryAsUser(
      user,
      `UPDATE ${table}
       SET ${setClause}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found' });
    }

    await req.audit({
      action: 'update',
      tableName: table,
      recordId: id,
      newData: result.rows[0],
    });

    res.json({ ok: true, table, data: result.rows[0] });
  } catch (err) {
    console.error(`PUT /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/generic/:table/:id
// ═══════════════════════════════════════════════
router.delete('/:table/:id', optionalAuth, async (req, res) => {
  try {
    const { table, id } = req.params;
    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM ${table} WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found' });
    }

    await req.audit({
      action: 'delete',
      tableName: table,
      recordId: id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, table, deleted: result.rows[0] });
  } catch (err) {
    console.error(`DELETE /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/generic
// ═══════════════════════════════════════════════
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    allowed_tables: ALLOWED_TABLES,
    count: ALLOWED_TABLES.length,
  });
});

module.exports = router;