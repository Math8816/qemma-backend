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
       WHERE c.is_active = true
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
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user || !user.sub) {
      client.release();
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      full_name, phone, email, address,
      opening_balance, sales_rep_id,
    } = req.body;

    if (!full_name || full_name.trim() === '') {
      client.release();
      return res.status(400).json({ ok: false, error: 'full_name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      client.release();
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const openingBal = Number(opening_balance) || 0;

    // ═══════════════════════════════════════════════════════════
    //  🔐 Transaction: عميل + قيد افتتاحي
    // ═══════════════════════════════════════════════════════════
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // ─── 1. إنشاء العميل ───
    const custResult = await client.query(
      `INSERT INTO customers
         (full_name, phone, email, address,
          opening_balance, balance, total_purchases,
          sales_rep_id, tenant_id, organization_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
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

    const customer = custResult.rows[0];

    // ─── 2. إنشاء قيد الرصيد الافتتاحي (إن > 0) ───
    if (openingBal !== 0) {
      let debit = 0;
      let credit = 0;
      const numAmount = Math.abs(openingBal);

      // customer: موجب = مدين لنا (debit)
      if (openingBal > 0) debit = numAmount;
      else credit = numAmount;

      await client.query(
        `INSERT INTO ledger_entries
          (tenant_id, organization_id, account_id, account_type,
           entry_type, reference_id, reference_number,
           debit, credit, description, entry_date, metadata)
         VALUES ($1, $2, $3, 'customer', 'opening', NULL, NULL,
                 $4, $5, $6, $7, $8)`,
        [
          tenantId,
          organizationId,
          customer.id,
          debit,
          credit,
          `رصيد افتتاحي - ${customer.full_name}`,
          new Date().toISOString().split('T')[0],
          JSON.stringify({ source: 'opening_balance' }),
        ]
      );
    }

    await client.query('COMMIT');

    await req.audit({
      action: 'create',
      tableName: 'customers',
      recordId: customer.id,
      newData: customer,
    });

    res.status(201).json({ ok: true, data: customer });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /customers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
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

    // ─── 1. تحقق من وجود العميل + الرصيد ───
    const checkRes = await queryAsUser(
      user,
      `SELECT id, balance, full_name 
       FROM customers 
       WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Customer not found' });
    }

    const customer = checkRes.rows[0];
    const balance = Number(customer.balance) || 0;

    // ─── 2. منع الحذف إذا فيه رصيد ───
    if (Math.abs(balance) > 0.01) {
      return res.status(409).json({
        ok: false,
        error: 'CUSTOMER_HAS_BALANCE',
        error_description: `لا يمكن حذف "${customer.full_name}" — رصيده ${balance.toFixed(2)}. سوّ الرصيد أولاً.`,
      });
    }

    // ─── 3. Soft Delete ───
    const result = await queryAsUser(
      user,
      `UPDATE customers
       SET is_active = false,
           deleted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    await req.audit({
      action: 'soft_delete',
      tableName: 'customers',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0], soft: true });
  } catch (err) {
    console.error('DELETE /customers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;