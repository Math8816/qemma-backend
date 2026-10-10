// ═══════════════════════════════════════════════
//  src/routes/sales-reps.js
//  CRUD كامل مع RLS + Audit
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/sales-reps — كل المندوبين (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, is_active,
              tenant_id, organization_id, created_at
       FROM sales_reps
       ORDER BY full_name
       LIMIT 500`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sales-reps/rls/list — كل المندوبين (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         sr.id,
         sr.full_name,
         sr.phone,
         sr.email,
         sr.is_active,
         sr.tenant_id,
         sr.organization_id,
         sr.created_at,
         sr.updated_at,
         (SELECT COUNT(*)::int FROM customers c 
          WHERE c.sales_rep_id = sr.id) AS customers_count
       FROM sales_reps sr
       ORDER BY sr.full_name
       LIMIT 500`
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /sales-reps/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sales-reps/rls/active — النشطين فقط (مع RLS)
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/active', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, full_name, phone, email, is_active,
              tenant_id, organization_id
       FROM sales_reps
       WHERE is_active = true
       ORDER BY full_name`
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /sales-reps/rls/active error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sales-reps/rls/:id — مندوب واحد (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         sr.*,
         (SELECT COUNT(*)::int FROM customers c 
          WHERE c.sales_rep_id = sr.id) AS customers_count
       FROM sales_reps sr
       WHERE sr.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Sales rep not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /sales-reps/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sales-reps/:id — مندوب واحد (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sales_reps WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Sales rep not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/sales-reps/rls — إنشاء (مع RLS)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { full_name, phone, email, is_active } = req.body;

    if (!full_name || full_name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'full_name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const result = await queryAsUser(
      user,
      `INSERT INTO sales_reps
         (full_name, phone, email, is_active, tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        full_name.trim(),
        phone || null,
        email || null,
        is_active !== false,
        tenantId,
        organizationId,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'sales_reps',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /sales-reps/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/sales-reps/rls/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { full_name, phone, email, is_active } = req.body;

    if (!full_name || full_name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'full_name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM sales_reps WHERE id = $1',
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Sales rep not found or access denied' });
    }

    const result = await queryAsUser(
      user,
      `UPDATE sales_reps
       SET full_name = $1,
           phone = $2,
           email = $3,
           is_active = $4,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        full_name.trim(),
        phone || null,
        email || null,
        is_active !== false,
        req.params.id,
      ]
    );

    await req.audit({
      action: 'update',
      tableName: 'sales_reps',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /sales-reps/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/sales-reps/rls/:id — حذف (مع RLS)
//  ⚠️ منع الحذف إن كان هناك عملاء مرتبطون
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const countResult = await queryAsUser(
      user,
      `SELECT COUNT(*)::int AS count FROM customers WHERE sales_rep_id = $1`,
      [req.params.id]
    );

    const customerCount = countResult.rows[0]?.count || 0;

    if (customerCount > 0) {
      return res.status(409).json({
        ok: false,
        error: `لا يمكن حذف هذا المندوب لأنه مرتبط بـ ${customerCount} عميل`,
      });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM sales_reps WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Sales rep not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'sales_reps',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /sales-reps/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;