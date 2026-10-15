// ═══════════════════════════════════════════════
//  src/routes/suppliers.js
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
//  GET /api/suppliers — كل الموردين (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, phone, email, address, category_id,
              balance, opening_balance, total_paid,
              tenant_id, organization_id, created_at
       FROM suppliers
       ORDER BY name
       LIMIT 500`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/suppliers/rls/list — كل الموردين (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         s.id,
         s.name,
         s.phone,
         s.email,
         s.address,
         s.category_id,
         s.balance,
         s.opening_balance,
         s.total_paid,
         s.tenant_id,
         s.organization_id,
         s.created_at,
         s.updated_at,
         c.name AS category_name,
         c.color AS category_color
       FROM suppliers s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.is_active = true
       ORDER BY s.name
       LIMIT 500`
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /suppliers/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/suppliers/rls/:id — مورد واحد (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         s.*,
         c.name AS category_name,
         c.color AS category_color
       FROM suppliers s
       LEFT JOIN categories c ON c.id = s.category_id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Supplier not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /suppliers/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/suppliers/:id — مورد واحد (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM suppliers WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Supplier not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/suppliers/rls — إنشاء (مع RLS)
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
      name, phone, email, address,
      category_id, opening_balance,
    } = req.body;

    if (!name || name.trim() === '') {
      client.release();
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      client.release();
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const openingBal = Number(opening_balance) || 0;

    // ═══════════════════════════════════════════════════════════
    //  🔐 Transaction: مورد + قيد افتتاحي
    // ═══════════════════════════════════════════════════════════
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // ─── 1. إنشاء المورد ───
    const supResult = await client.query(
      `INSERT INTO suppliers
         (name, phone, email, address, category_id,
          opening_balance, balance, total_paid,
          tenant_id, organization_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       RETURNING *`,
      [
        name.trim(),
        phone || null,
        email || null,
        address || null,
        category_id || null,
        openingBal,
        openingBal,
        0,
        tenantId,
        organizationId,
      ]
    );

    const supplier = supResult.rows[0];

    // ─── 2. قيد الرصيد الافتتاحي ───
    if (openingBal !== 0) {
      let debit = 0;
      let credit = 0;
      const numAmount = Math.abs(openingBal);

      // supplier: موجب = علينا له (credit)
      if (openingBal > 0) credit = numAmount;
      else debit = numAmount;

      await client.query(
        `INSERT INTO ledger_entries
          (tenant_id, organization_id, account_id, account_type,
           entry_type, reference_id, reference_number,
           debit, credit, description, entry_date, metadata)
         VALUES ($1, $2, $3, 'supplier', 'opening', NULL, NULL,
                 $4, $5, $6, $7, $8)`,
        [
          tenantId,
          organizationId,
          supplier.id,
          debit,
          credit,
          `رصيد افتتاحي - ${supplier.name}`,
          new Date().toISOString().split('T')[0],
          JSON.stringify({ source: 'opening_balance' }),
        ]
      );
    }

    await client.query('COMMIT');

    await req.audit({
      action: 'create',
      tableName: 'suppliers',
      recordId: supplier.id,
      newData: supplier,
    });

    res.status(201).json({ ok: true, data: supplier });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /suppliers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/suppliers/rls/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { name, phone, email, address, category_id } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM suppliers WHERE id = $1',
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Supplier not found or access denied' });
    }

    const result = await queryAsUser(
      user,
      `UPDATE suppliers
       SET name = $1,
           phone = $2,
           email = $3,
           address = $4,
           category_id = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        name.trim(),
        phone || null,
        email || null,
        address || null,
        category_id || null,
        req.params.id,
      ]
    );

    await req.audit({
      action: 'update',
      tableName: 'suppliers',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /suppliers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/suppliers/rls/:id — حذف (مع RLS)
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // ─── 1. تحقق من وجود المورد + الرصيد ───
    const checkRes = await queryAsUser(
      user,
      `SELECT id, balance, name 
       FROM suppliers 
       WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );

    if (checkRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Supplier not found' });
    }

    const supplier = checkRes.rows[0];
    const balance = Number(supplier.balance) || 0;

    // ─── 2. منع الحذف إذا فيه رصيد ───
    if (Math.abs(balance) > 0.01) {
      return res.status(409).json({
        ok: false,
        error: 'SUPPLIER_HAS_BALANCE',
        error_description: `لا يمكن حذف "${supplier.name}" — رصيده ${balance.toFixed(2)}. سوّ الرصيد أولاً.`,
      });
    }

    // ─── 3. Soft Delete ───
    const result = await queryAsUser(
      user,
      `UPDATE suppliers
       SET is_active = false,
           deleted_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    await req.audit({
      action: 'soft_delete',
      tableName: 'suppliers',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0], soft: true });
  } catch (err) {
    console.error('DELETE /suppliers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;