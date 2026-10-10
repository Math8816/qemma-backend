// ═══════════════════════════════════════════════
//  src/routes/products.js
//  CRUD كامل مع RLS + Audit + Joins
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();

// تفعيل Audit لكل routes هذا الملف
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/products — كل المنتجات (بدون RLS) — للاختبار
// ═══════════════════════════════════════════════
router.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, category_id, company_id, tenant_id, organization_id, created_at
       FROM products ORDER BY name LIMIT 100`
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/products/rls/list — قائمة كاملة (مع RLS + Joins)
//  ✅ يجلب: التصنيف + الشركة + الوحدات + الأسعار
//  ⚠️ يجب أن يكون قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         p.id,
         p.name,
         p.category_id,
         p.company_id,
         p.tenant_id,
         p.organization_id,
         p.created_at,
         p.updated_at,

         -- التصنيف
         c.name AS category_name,
         c.color AS category_color,

         -- الشركة
         co.name AS company_name,

         -- الوحدات (JSON array)
         COALESCE(
           (
             SELECT json_agg(
               json_build_object(
                 'id', pu.id,
                 'product_id', pu.product_id,
                 'unit_id', pu.unit_id,
                 'quantity', pu.quantity,
                 'min_quantity', pu.min_quantity,
                 'barcode', pu.barcode,
                 'cost', pu.cost,
                 'wholesale_price', pu.wholesale_price,
                 'retail_price', pu.retail_price,
                 'unit_name', u.name,
                 'unit_symbol', u.symbol
               )
               ORDER BY pu.created_at
             )
             FROM product_units pu
             LEFT JOIN units u ON u.id = pu.unit_id
             WHERE pu.product_id = p.id
           ),
           '[]'::json
         ) AS product_units

       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN companies co ON co.id = p.company_id
       ORDER BY p.name
       LIMIT 200`
    );

    // ─── إضافة حقول مسطحة من أول وحدة (للتوافق مع Frontend القديم) ───
    const enriched = result.rows.map((row) => {
      const firstUnit = row.product_units?.[0] || {};
      return {
        ...row,
        cost: firstUnit.cost || 0,
        price: firstUnit.retail_price || 0,
        retail_price: firstUnit.retail_price || 0,
        wholesale_price: firstUnit.wholesale_price || 0,
        quantity: firstUnit.quantity || 0,
        min_quantity: firstUnit.min_quantity || 5,
        barcode: firstUnit.barcode || null,
        unit_id: firstUnit.unit_id || null,
      };
    });

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: enriched.length,
      data: enriched,
    });
  } catch (err) {
    console.error('GET /products/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/products/rls/:id — منتج واحد مع العلاقات (مع RLS)
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         p.*,
         c.name AS category_name,
         c.color AS category_color,
         co.name AS company_name,
         COALESCE(
           (
             SELECT json_agg(
               json_build_object(
                 'id', pu.id,
                 'product_id', pu.product_id,
                 'unit_id', pu.unit_id,
                 'quantity', pu.quantity,
                 'min_quantity', pu.min_quantity,
                 'barcode', pu.barcode,
                 'cost', pu.cost,
                 'wholesale_price', pu.wholesale_price,
                 'retail_price', pu.retail_price,
                 'unit_name', u.name,
                 'unit_symbol', u.symbol
               )
               ORDER BY pu.created_at
             )
             FROM product_units pu
             LEFT JOIN units u ON u.id = pu.unit_id
             WHERE pu.product_id = p.id
           ),
           '[]'::json
         ) AS product_units
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN companies co ON co.id = p.company_id
       WHERE p.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /products/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/products/:id — منتج واحد (بدون RLS)
//  ⚠️ يجب أن يكون بعد /rls/list و /rls/:id
// ═══════════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/products — إنشاء منتج (بدون RLS)
// ═══════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const { name, category_id, company_id, tenant_id, organization_id } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }
    if (!tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id is required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO products (name, category_id, company_id, tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), category_id || null, company_id || null, tenant_id, organization_id || null]
    );

    await req.audit({
      action: 'create',
      tableName: 'products',
      recordId: rows[0].id,
      newData: rows[0],
    });

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /products error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/products/rls — إنشاء منتج (مع RLS)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { name, category_id, company_id } = req.body;

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
      `INSERT INTO products (name, category_id, company_id, tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name.trim(), category_id || null, company_id || null, tenantId, organizationId]
    );

    await req.audit({
      action: 'create',
      tableName: 'products',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /products/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/products/:id — تحديث منتج (بدون RLS)
// ═══════════════════════════════════════════════
router.put('/:id', async (req, res) => {
  try {
    const { name, category_id, company_id } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const { rows: oldRows } = await pool.query(
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );

    const { rows } = await pool.query(
      `UPDATE products
       SET name = $1, category_id = $2, company_id = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name.trim(), category_id || null, company_id || null, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    await req.audit({
      action: 'update',
      tableName: 'products',
      recordId: rows[0].id,
      oldData: oldRows[0] || null,
      newData: rows[0],
    });

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PUT /products error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/products/rls/:id — تحديث منتج (مع RLS)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { name, category_id, company_id } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM products WHERE id = $1',
      [req.params.id]
    );

    const result = await queryAsUser(
      user,
      `UPDATE products
       SET name = $1, category_id = $2, company_id = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [name.trim(), category_id || null, company_id || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found or access denied' });
    }

    await req.audit({
      action: 'update',
      tableName: 'products',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0] || null,
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /products/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/products/:id — حذف منتج (بدون RLS)
// ═══════════════════════════════════════════════
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM products WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'products',
      recordId: rows[0].id,
      oldData: rows[0],
    });

    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('DELETE /products error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/products/rls/:id — حذف منتج (مع RLS)
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM products WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Product not found or access denied' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'products',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /products/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;