// ═══════════════════════════════════════════════
//  src/routes/generic.js
//  Generic CRUD لأي جدول (مع RLS + Audit)
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();

// ═══════════════════════════════════════════════
//  Whitelist — الجداول المسموح بها
//  ⚠️ لا تُضف جداول حساسة (users, tenants, audit_log)
// ═══════════════════════════════════════════════
const ALLOWED_TABLES = [
  'products',
  'customers',
  'suppliers',
  'categories',
  'companies',
  'units',
  'sales_reps',
  'branches',
  'sales_invoices',
  'purchase_invoices',
  'returns',
  'transactions',
  'loyalty_points',
  'loyalty_tiers',
  'notifications',
  'settings',
  'stock',
  'product_units',
];

// ═══════════════════════════════════════════════
//  الحقول المسموح بفلترتها (WHERE)
// ═══════════════════════════════════════════════
const ALLOWED_FILTERS = ['tenant_id', 'organization_id', 'category_id', 'company_id', 'unit_id'];

// تفعيل Audit
router.use(auditMiddleware);

// ─── Helper: التحقق من الجدول ───
function isTableAllowed(table) {
  return ALLOWED_TABLES.includes(table);
}

// ─── Helper: تنظيف الحقول (يحمي من SQL Injection) ───
function sanitizeFields(obj) {
  const clean = {};
  const ALLOWED_FIELDS = [
    'name', 'email', 'phone', 'address', 'full_name',
    'category_id', 'company_id', 'tenant_id', 'organization_id',
    'unit_id', 'supplier_id', 'customer_id', 'branch_id',
    'price', 'cost', 'quantity', 'stock', 'min_quantity',
    'description', 'notes', 'color', 'is_active', 'is_hq',
    'balance', 'opening_balance', 'status',
  ];

  Object.keys(obj).forEach((key) => {
    if (ALLOWED_FIELDS.includes(key)) {
      clean[key] = obj[key];
    }
  });

  return clean;
}

// ═══════════════════════════════════════════════
//  GET /api/generic/:table — كل السجلات (مع RLS + Pagination + Search + Sort)
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
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    // ─── Search ───
    const search = req.query.search ? String(req.query.search).trim() : null;

    // ─── Sort ───
    const sortField = req.query.sort || 'created_at';
    const sortOrder = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // ⚠️ حماية من SQL Injection في sort
    const ALLOWED_SORT_FIELDS = ['id', 'name', 'created_at', 'updated_at', 'email', 'full_name', 'balance'];
    const safeSortField = ALLOWED_SORT_FIELDS.includes(sortField) ? sortField : 'created_at';

    // ─── بناء WHERE ───
    const where = [];
    const params = [];

    // فلترة على الحقول المسموحة
    ALLOWED_FILTERS.forEach((filter) => {
      if (req.query[filter]) {
        params.push(req.query[filter]);
        where.push(`${filter} = $${params.length}`);
      }
    });

    // الحقول القابلة للبحث (حسب الجدول)
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

if (search) {
  const searchFields = SEARCHABLE_FIELDS[table] || ['name'];
  const searchConditions = searchFields.map((field) => {
    params.push(`%${search}%`);
    return `${field} ILIKE $${params.length}`;
  });
  where.push(`(${searchConditions.join(' OR ')})`);
}

    const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';

    // ─── عدد الإجمالي ───
    const countQuery = `SELECT COUNT(*)::int AS total FROM ${table}${whereClause}`;
    const countResult = await queryAsUser(user, countQuery, params);
    const total = countResult.rows[0]?.total || 0;

    // ─── الصفحة الحالية ───
    params.push(limit);
    params.push(offset);

    const query = `
      SELECT * FROM ${table}
      ${whereClause}
      ORDER BY ${safeSortField} ${sortOrder}
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const result = await queryAsUser(user, query, params);

    res.json({
      ok: true,
      table,
      count: result.rows.length,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      filters: {
        search,
        sort: safeSortField,
        order: sortOrder.toLowerCase(),
      },
      data: result.rows,
    });
  } catch (err) {
    console.error(`GET /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/generic/:table/:id — سجل واحد (مع RLS)
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
//  POST /api/generic/:table — إنشاء سجل (مع RLS)
// ═══════════════════════════════════════════════
router.post('/:table', optionalAuth, async (req, res) => {
  try {
    const { table } = req.params;

    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // تنظيف الحقول
    const data = sanitizeFields(req.body);

    // إضافة tenant_id و organization_id من JWT تلقائياً
    if (user.tenant_id) data.tenant_id = user.tenant_id;
    if (user.organization_id) data.organization_id = user.organization_id;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields provided' });
    }

    // بناء INSERT ديناميكياً
    const fields = Object.keys(data);
    const values = Object.values(data);
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');

    const query = `
      INSERT INTO ${table} (${fields.join(', ')})
      VALUES (${placeholders})
      RETURNING *
    `;

    const result = await queryAsUser(user, query, values);

    // Audit
    await req.audit({
      action: 'create',
      tableName: table,
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, table, data: result.rows[0] });
  } catch (err) {
    console.error(`POST /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/generic/:table/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/:table/:id', optionalAuth, async (req, res) => {
  try {
    const { table, id } = req.params;

    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const data = sanitizeFields(req.body);

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields provided' });
    }

    // جلب البيانات القديمة
    const oldResult = await queryAsUser(
      user,
      `SELECT * FROM ${table} WHERE id = $1`,
      [id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found or access denied' });
    }

    // بناء UPDATE ديناميكياً
    const fields = Object.keys(data);
    const values = Object.values(data);
    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');

    values.push(id);

    const query = `
      UPDATE ${table}
      SET ${setClause}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `;

    const result = await queryAsUser(user, query, values);

    // Audit
    await req.audit({
      action: 'update',
      tableName: table,
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, table, data: result.rows[0] });
  } catch (err) {
    console.error(`PUT /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/generic/:table/:id — حذف (مع RLS)
// ═══════════════════════════════════════════════
router.delete('/:table/:id', optionalAuth, async (req, res) => {
  try {
    const { table, id } = req.params;

    if (!isTableAllowed(table)) {
      return res.status(403).json({ ok: false, error: 'Table not allowed' });
    }

    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM ${table} WHERE id = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Record not found or access denied' });
    }

    // Audit
    await req.audit({
      action: 'delete',
      tableName: table,
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, table, deleted: result.rows[0] });
  } catch (err) {
    console.error(`DELETE /generic/${req.params.table} error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/generic — قائمة الجداول المسموح بها
// ═══════════════════════════════════════════════
router.get('/', (_req, res) => {
  res.json({
    ok: true,
    allowed_tables: ALLOWED_TABLES,
    count: ALLOWED_TABLES.length,
  });
});

module.exports = router;