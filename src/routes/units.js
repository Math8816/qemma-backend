// ═══════════════════════════════════════════════
//  src/routes/units.js
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
//  GET /api/units — كل الوحدات (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, symbol, type, conversion_factor, is_base,
              is_active, tenant_id, organization_id, created_at
       FROM units
       ORDER BY name
       LIMIT 200`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/units/rls/list — كل الوحدات (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, name, symbol, type, conversion_factor, is_base,
              is_active, tenant_id, organization_id, created_at
       FROM units
       ORDER BY name
       LIMIT 200`
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /units/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/units/rls/active — النشطة فقط
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/active', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, name, symbol, type, conversion_factor, is_base,
              is_active, tenant_id, organization_id
       FROM units
       WHERE is_active = true
       ORDER BY name`
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /units/rls/active error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/units/:id — وحدة واحدة
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM units WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Unit not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/units/rls — إنشاء (مع RLS)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      name, symbol, type, conversion_factor, is_base, is_active,
    } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const result = await queryAsUser(
      user,
      `INSERT INTO units
         (name, symbol, type, conversion_factor, is_base, is_active,
          tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        name.trim(),
        symbol || null,
        type || 'count',
        conversion_factor || 1,
        is_base || false,
        is_active !== false,
        tenantId,
        organizationId,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'units',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /units/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/units/rls/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      name, symbol, type, conversion_factor, is_base, is_active,
    } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM units WHERE id = $1',
      [req.params.id]
    );

    const result = await queryAsUser(
      user,
      `UPDATE units
       SET name = $1, symbol = $2, type = $3,
           conversion_factor = $4, is_base = $5, is_active = $6,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        name.trim(),
        symbol || null,
        type || 'count',
        conversion_factor || 1,
        is_base || false,
        is_active !== false,
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Unit not found or access denied' });
    }

    await req.audit({
      action: 'update',
      tableName: 'units',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0] || null,
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /units/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/units/rls/:id — حذف (مع RLS)
//  ⚠️ منع الحذف إن كانت الوحدة مستخدمة
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // فحص ارتباط بـ product_units
    const countResult = await queryAsUser(
      user,
      `SELECT COUNT(*)::int AS count FROM product_units WHERE unit_id = $1`,
      [req.params.id]
    );

    const usageCount = countResult.rows[0]?.count || 0;

    if (usageCount > 0) {
      return res.status(409).json({
        ok: false,
        error: `لا يمكن حذف هذه الوحدة لأنها مستخدمة في ${usageCount} منتج`,
      });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM units WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Unit not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'units',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /units/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;