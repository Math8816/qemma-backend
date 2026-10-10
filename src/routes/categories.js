// ═══════════════════════════════════════════════
//  src/routes/categories.js
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
//  GET /api/categories — كل التصنيفات (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, description, color, is_active,
              tenant_id, organization_id, created_at
       FROM categories
       ORDER BY name
       LIMIT 200`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/categories/rls/list — كل التصنيفات (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, name, description, color, is_active,
              tenant_id, organization_id, created_at, updated_at
       FROM categories
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
    console.error('GET /categories/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/categories/rls/active — النشطة فقط (مع RLS)
//  ⚠️ يجب أن يكون قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/active', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, name, description, color, is_active,
              tenant_id, organization_id
       FROM categories
       WHERE is_active = true
       ORDER BY name`
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /categories/rls/active error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/categories/:id — تصنيف واحد
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM categories WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Category not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/categories/rls — إنشاء (مع RLS)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { name, description, color, is_active } = req.body;

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
      `INSERT INTO categories
         (name, description, color, is_active, tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        name.trim(),
        description || null,
        color || '#3498db',
        is_active !== false,
        tenantId,
        organizationId,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'categories',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /categories/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/categories/rls/:id — تحديث (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { name, description, color, is_active } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM categories WHERE id = $1',
      [req.params.id]
    );

    const result = await queryAsUser(
      user,
      `UPDATE categories
       SET name = $1, description = $2, color = $3,
           is_active = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [
        name.trim(),
        description || null,
        color || '#3498db',
        is_active !== false,
        req.params.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Category not found or access denied' });
    }

    await req.audit({
      action: 'update',
      tableName: 'categories',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0] || null,
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /categories/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/categories/rls/:id — حذف (مع RLS)
//  ⚠️ منع الحذف إن كان هناك منتجات مرتبطة
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // ─── فحص ارتباط بمنتجات ───
    const countResult = await queryAsUser(
      user,
      `SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1`,
      [req.params.id]
    );

    const productCount = countResult.rows[0]?.count || 0;

    if (productCount > 0) {
      return res.status(409).json({
        ok: false,
        error: `لا يمكن حذف هذا التصنيف لأنه مرتبط بـ ${productCount} منتج`,
      });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM categories WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Category not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'categories',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /categories/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;