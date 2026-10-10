// ═══════════════════════════════════════════════
//  src/routes/purchaseInvoices.js
//  فواتير المشتريات + الأصناف + Ledger + Stock
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/purchase-invoices/rls/list
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const { supplier_id, status, start_date, end_date, limit = 200 } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (supplier_id) {
      params.push(supplier_id);
      where += ` AND pi.supplier_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND pi.status = $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      where += ` AND pi.date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      where += ` AND pi.date <= $${params.length}`;
    }

    params.push(Math.min(parseInt(limit) || 200, 500));

    const result = await queryAsUser(
      user,
      `SELECT 
         pi.*,
         COALESCE(
           (SELECT json_agg(pii ORDER BY pii.created_at)
            FROM purchase_invoice_items pii
            WHERE pii.invoice_id = pi.id),
           '[]'::json
         ) AS purchase_invoice_items
       FROM purchase_invoices pi
       ${where}
       ORDER BY pi.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /purchase-invoices/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/purchase-invoices/rls/:id
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT 
         pi.*,
         COALESCE(
           (SELECT json_agg(pii ORDER BY pii.created_at)
            FROM purchase_invoice_items pii
            WHERE pii.invoice_id = pi.id),
           '[]'::json
         ) AS purchase_invoice_items
       FROM purchase_invoices pi
       WHERE pi.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Invoice not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /purchase-invoices/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/purchase-invoices/rls
//  إنشاء فاتورة: invoice + items + stock (+) + ledger (credit)
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const {
      invoice_number,
      supplier_id, supplier_name, supplier_phone,
      previous_balance,
      subtotal, discount = 0, tax = 0, total,
      paid = 0, remaining,
      date, notes,
      items = [],
    } = req.body;

    if (!invoice_number) {
      return res.status(400).json({ ok: false, error: 'invoice_number is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items are required' });
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    if (tenantId) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }

    // ─── 1. purchase_invoices ───
    const invResult = await client.query(
      `INSERT INTO purchase_invoices
        (invoice_number, supplier_id, supplier_name, supplier_phone,
         previous_balance, subtotal, discount, tax, total, paid, remaining,
         date, notes, tenant_id, organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        invoice_number,
        supplier_id || null,
        supplier_name || null,
        supplier_phone || null,
        Number(previous_balance) || 0,
        Number(subtotal) || 0,
        Number(discount) || 0,
        Number(tax) || 0,
        Number(total) || 0,
        Number(paid) || 0,
        Number(remaining) || 0,
        date || new Date().toISOString().split('T')[0],
        notes || null,
        tenantId,
        user.organization_id || null,
      ]
    );
    const invoice = invResult.rows[0];
    const invoiceId = invoice.id;

    // ─── 2. items ───
    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_invoice_items
          (invoice_id, product_id, product_name, quantity, cost, total,
           unit_id, tenant_id, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          invoiceId,
          item.product_id || null,
          item.product_name || null,
          Number(item.quantity) || 0,
          Number(item.cost || item.price || 0),
          Number(item.quantity || 0) * Number(item.cost || item.price || 0),
          item.unit_id || null,
          tenantId,
          user.organization_id || null,
        ]
      );
    }

    // ─── 3. stock (إضافة للمخزون) ───
    for (const item of items) {
      if (!item.product_id || !item.unit_id) continue;

      const stockRow = await client.query(
        `SELECT id, quantity FROM stock
         WHERE tenant_id = $1 AND product_id = $2 AND unit_id = $3`,
        [tenantId, item.product_id, item.unit_id]
      );

      let prevQty = 0;
      let newQty = 0;

      if (stockRow.rows.length > 0) {
        prevQty = Number(stockRow.rows[0].quantity) || 0;
        newQty = prevQty + Number(item.quantity || 0);
        await client.query(
          `UPDATE stock SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [newQty, stockRow.rows[0].id]
        );
      } else {
        newQty = Number(item.quantity || 0);
        await client.query(
          `INSERT INTO stock (tenant_id, organization_id, product_id, unit_id, quantity, min_quantity)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [tenantId, user.organization_id || null, item.product_id, item.unit_id, newQty]
        );
      }

      await client.query(
        `INSERT INTO inventory_log
          (tenant_id, organization_id, product_id, product_name, unit_id,
           change_amount, previous_qty, new_qty, entry_type, reason,
           reference_id, reference_number, unit_cost, total_value,
           created_by, date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'purchase','فاتورة مشتريات',$9,$10,$11,$12,$13,$14)`,
        [
          tenantId,
          user.organization_id || null,
          item.product_id,
          item.product_name || null,
          item.unit_id,
          Number(item.quantity || 0),
          prevQty,
          newQty,
          invoiceId,
          invoice_number,
          Number(item.cost || item.price || 0),
          Number(item.quantity || 0) * Number(item.cost || item.price || 0),
          user.sub,
          date || new Date().toISOString().split('T')[0],
        ]
      );
    }

    // ─── 4. Ledger (دائن على المورد) ───
    if (supplier_id && Number(total) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
          (tenant_id, organization_id, account_id, account_type,
           entry_type, reference_id, reference_number,
           debit, credit, description, entry_date, metadata)
         VALUES ($1,$2,$3,'supplier','invoice',$4,$5,0,$6,$7,$8,$9)`,
        [
          tenantId,
          user.organization_id || null,
          supplier_id,
          invoiceId,
          invoice_number,
          Number(total),
          `فاتورة مشتريات ${invoice_number}`,
          date || new Date().toISOString().split('T')[0],
          JSON.stringify({ invoice_number }),
        ]
      );

      await client.query(
        `UPDATE suppliers s
         SET balance = COALESCE(
           (SELECT COALESCE(SUM(credit),0) - COALESCE(SUM(debit),0)
            FROM ledger_entries
            WHERE tenant_id = $1 AND account_id = $2 AND account_type = 'supplier'),
           0
         ), updated_at = NOW()
         WHERE id = $2 AND tenant_id = $1`,
        [tenantId, supplier_id]
      );
    }

    await client.query('COMMIT');

    await req.audit({
      action: 'create',
      tableName: 'purchase_invoices',
      recordId: invoiceId,
      newData: invoice,
    });

    res.status(201).json({ ok: true, data: invoice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /purchase-invoices/rls error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Invoice number already exists' });
    }
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/purchase-invoices/rls/:id
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const allowed = ['status', 'paid', 'remaining', 'notes'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ ok: false, error: 'No valid fields to update' });
    }

    const setClause = Object.keys(updates)
      .map((k, i) => `${k} = $${i + 1}`)
      .join(', ');
    const values = Object.values(updates);
    values.push(req.params.id);

    const result = await queryAsUser(
      user,
      `UPDATE purchase_invoices
       SET ${setClause}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Invoice not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /purchase-invoices/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/purchase-invoices/rls/:id
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    if (user.tenant_id) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [user.tenant_id]);
    }

    await client.query(`DELETE FROM purchase_invoice_items WHERE invoice_id = $1`, [req.params.id]);

    const result = await client.query(
      `DELETE FROM purchase_invoices WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Invoice not found or access denied' });
    }

    await client.query('COMMIT');

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /purchase-invoices/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;