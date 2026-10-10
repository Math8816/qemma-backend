// ═══════════════════════════════════════════════
//  src/routes/returns.js
//  المرتجعات + الأصناف — CRUD مع RLS
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/returns/rls/list — كل المرتجعات (مع الأصناف)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const { type, status, limit = 200 } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (type) {
      params.push(type);
      whereClause += ` AND r.type = $${params.length}`;
    }

    if (status) {
      params.push(status);
      whereClause += ` AND r.status = $${params.length}`;
    }

    params.push(Math.min(parseInt(limit) || 200, 500));

    const result = await queryAsUser(
      user,
      `SELECT 
         r.*,
         COALESCE(
           (
             SELECT json_agg(ri ORDER BY ri.created_at)
             FROM return_items ri
             WHERE ri.return_id = r.id
           ),
           '[]'::json
         ) AS return_items
       FROM returns r
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /returns/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/returns/rls/:id — مرتجع واحد
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT 
         r.*,
         COALESCE(
           (
             SELECT json_agg(ri ORDER BY ri.created_at)
             FROM return_items ri
             WHERE ri.return_id = r.id
           ),
           '[]'::json
         ) AS return_items
       FROM returns r
       WHERE r.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Return not found' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /returns/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/returns/rls — إنشاء مرتجع (مع الأصناف)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      return_number,
      type,
      invoice_id,
      purchase_invoice_id,
      customer_id,
      supplier_id,
      customer_name,
      supplier_name,
      subtotal,
      discount,
      tax,
      total,
      reason,
      status,
      date,
      notes,
      items,
    } = req.body;

    if (!return_number) {
      return res.status(400).json({ ok: false, error: 'return_number is required' });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    // 1. إدراج المرتجع
    const result = await queryAsUser(
      user,
      `INSERT INTO returns
        (return_number, type, invoice_id, purchase_invoice_id,
         customer_id, supplier_id, customer_name, supplier_name,
         subtotal, discount, tax, total, reason, status, date, notes,
         tenant_id, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        return_number,
        type || 'sales_return',
        invoice_id || null,
        purchase_invoice_id || null,
        customer_id || null,
        supplier_id || null,
        customer_name || null,
        supplier_name || null,
        subtotal || 0,
        discount || 0,
        tax || 0,
        total || 0,
        reason || null,
        status || 'pending',
        date || new Date().toISOString().split('T')[0],
        notes || null,
        tenantId,
        organizationId,
      ]
    );

    const returnId = result.rows[0].id;

    // 2. إدراج الأصناف
    if (items && items.length > 0) {
      for (const item of items) {
        await queryAsUser(
          user,
          `INSERT INTO return_items
            (return_id, product_id, product_name, quantity, price, total, reason,
             unit_id, tenant_id, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            returnId,
            item.product_id || null,
            item.product_name || null,
            item.quantity || 0,
            item.price || 0,
            item.total || (item.price || 0) * (item.quantity || 0),
            item.reason || null,
            item.unit_id || null,
            tenantId,
            organizationId,
          ]
        );
      }
    }

    await req.audit({
      action: 'create',
      tableName: 'returns',
      recordId: returnId,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /returns/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/returns/rls/:id — تحديث (مع الأصناف)
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      type, invoice_id, purchase_invoice_id,
      customer_id, supplier_id, customer_name, supplier_name,
      subtotal, discount, tax, total, reason, status, date, notes,
      items,
    } = req.body;

    // 1. جلب القديم
    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM returns WHERE id = $1',
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Return not found' });
    }

    // 2. تحديث المرتجع
    const result = await queryAsUser(
      user,
      `UPDATE returns
       SET type = COALESCE($1, type),
           invoice_id = COALESCE($2, invoice_id),
           purchase_invoice_id = COALESCE($3, purchase_invoice_id),
           customer_id = COALESCE($4, customer_id),
           supplier_id = COALESCE($5, supplier_id),
           customer_name = COALESCE($6, customer_name),
           supplier_name = COALESCE($7, supplier_name),
           subtotal = COALESCE($8, subtotal),
           discount = COALESCE($9, discount),
           tax = COALESCE($10, tax),
           total = COALESCE($11, total),
           reason = COALESCE($12, reason),
           status = COALESCE($13, status),
           date = COALESCE($14, date),
           notes = COALESCE($15, notes),
           updated_at = NOW()
       WHERE id = $16
       RETURNING *`,
      [
        type || null, invoice_id || null, purchase_invoice_id || null,
        customer_id || null, supplier_id || null, customer_name || null,
        supplier_name || null, subtotal ?? null, discount ?? null, tax ?? null,
        total ?? null, reason || null, status || null, date || null, notes || null,
        req.params.id,
      ]
    );

    // 3. تحديث الأصناف (إذا مُرِّرت)
    if (items && Array.isArray(items)) {
      // حذف القديم
      await queryAsUser(
        user,
        'DELETE FROM return_items WHERE return_id = $1',
        [req.params.id]
      );

      // إدراج الجديد
      for (const item of items) {
        await queryAsUser(
          user,
          `INSERT INTO return_items
            (return_id, product_id, product_name, quantity, price, total, reason,
             unit_id, tenant_id, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            req.params.id,
            item.product_id || null,
            item.product_name || null,
            item.quantity || 0,
            item.price || 0,
            item.total || (item.price || 0) * (item.quantity || 0),
            item.reason || null,
            item.unit_id || null,
            user.tenant_id,
            user.organization_id || null,
          ]
        );
      }
    }

    await req.audit({
      action: 'update',
      tableName: 'returns',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /returns/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/returns/rls/:id/status — تغيير الحالة فقط
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.put('/rls/:id/status', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { status } = req.body;
    const allowed = ['pending', 'approved', 'rejected'];

    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status' });
    }

    const oldResult = await queryAsUser(
      user,
      'SELECT * FROM returns WHERE id = $1',
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Return not found' });
    }

    const result = await queryAsUser(
      user,
      `UPDATE returns
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, req.params.id]
    );

    await req.audit({
      action: 'update-status',
      tableName: 'returns',
      recordId: req.params.id,
      oldData: { status: oldResult.rows[0].status },
      newData: { status },
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /returns/rls/:id/status error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/returns/rls/:id — حذف (CASCADE للأصناف)
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM returns WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Return not found' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'returns',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /returns/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;