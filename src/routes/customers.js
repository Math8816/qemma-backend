// ═══════════════════════════════════════════════
//  src/routes/customers.js
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
//  GET /api/customers — كل العملاء (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, phone, email, address, balance,
              opening_balance, total_purchases, total_paid,
              sales_rep_id, tenant_id, organization_id, created_at
       FROM customers
       ORDER BY full_name
       LIMIT 500`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/customers/rls/list — كل العملاء (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         c.id,
         c.full_name,
         c.phone,
         c.email,
         c.address,
         c.balance,
         c.opening_balance,
         c.total_purchases,
         c.total_paid,
         c.sales_rep_id,
         c.tenant_id,
         c.organization_id,
         c.created_at,
         c.updated_at,
         sr.full_name AS sales_rep_name,
         sr.phone AS sales_rep_phone
       FROM customers c
       LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
       ORDER BY c.full_name
       LIMIT 500`
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /customers/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/customers/rls/:id — عميل واحد (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         c.*,
         sr.full_name AS sales_rep_name,
         sr.phone AS sales_rep_phone
       FROM customers c
       LEFT JOIN sales_reps sr ON sr.id = c.sales_rep_id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /customers/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/customers/:id — عميل واحد (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/customers/rls — إنشاء (مع RLS)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      full_name, phone, email, address,
      opening_balance, sales_rep_id,
    } = req.body;

    if (!full_name || full_name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'full_name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const openingBal = Number(opening_balance) || 0;

    const result = await queryAsUser(
      user,
      `INSERT INTO customers
         (full_name, phone, email, address,
          opening_balance, balance, total_purchases,
          sales_rep_id, tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        full_name.trim(),
        phone || null,
        email || null,
        address || null,
        openingBal,
        openingBal,
        0,
        sales_rep_id || null,
        tenantId,
        organizationId,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'customers',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /customers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/customers/rls/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { full_name, phone, email, address, sales_rep_id } = req.body;

    if (!full_name || full_name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'full_name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM customers WHERE id = $1',
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found or access denied' });
    }

    const result = await queryAsUser(
      user,
      `UPDATE customers
       SET full_name = $1,
           phone = $2,
           email = $3,
           address = $4,
           sales_rep_id = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        full_name.trim(),
        phone || null,
        email || null,
        address || null,
        sales_rep_id || null,
        req.params.id,
      ]
    );

    await req.audit({
      action: 'update',
      tableName: 'customers',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /customers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/customers/rls/:id — حذف (مع RLS)
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM customers WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'customers',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /customers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;