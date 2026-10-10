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
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      name, phone, email, address,
      category_id, opening_balance,
    } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const openingBal = Number(opening_balance) || 0;

    const result = await queryAsUser(
      user,
      `INSERT INTO suppliers
         (name, phone, email, address, category_id,
          opening_balance, balance, total_paid,
          tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

    await req.audit({
      action: 'create',
      tableName: 'suppliers',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /suppliers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
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

    const result = await queryAsUser(
      user,
      `DELETE FROM suppliers WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Supplier not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'suppliers',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /suppliers/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;