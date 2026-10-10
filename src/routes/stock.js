// ═══════════════════════════════════════════════
//  src/routes/stock.js
//  المخزون — stock + inventory_log + product_units
//  ✅ متوافق مع stockService.js و storeApi.js
//  ✅ يدعم الوحدات المتعددة (product_id + unit_id)
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ─── Helper: صف stock ───
async function getStockRow(user, tenantId, productId, unitId) {
  const result = await queryAsUser(
    user,
    `SELECT id, quantity, min_quantity FROM stock
     WHERE tenant_id = $1 AND product_id = $2 AND unit_id = $3 LIMIT 1`,
    [tenantId, productId, unitId]
  );
  return result.rows[0] || null;
}

// ─── Helper: تعديل stock + log ───
async function adjustStock(user, opts) {
  const {
    tenantId, organizationId,
    productId, productName, unitId,
    changeAmount, entryType, reason,
    referenceId, referenceNumber,
    unitCost = 0, createdBy, createdByName, date,
  } = opts;

  const existing = await getStockRow(user, tenantId, productId, unitId);
  let previousQty = 0;
  let newQty = 0;

  if (existing) {
    previousQty = Number(existing.quantity) || 0;
    newQty = previousQty + Number(changeAmount);
    await queryAsUser(
      user,
      `UPDATE stock SET quantity = $1, updated_at = NOW() WHERE id = $2`,
      [newQty, existing.id]
    );
  } else {
    newQty = Number(changeAmount);
    await queryAsUser(
      user,
      `INSERT INTO stock
        (tenant_id, organization_id, product_id, unit_id, quantity, min_quantity)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [tenantId, organizationId, productId, unitId, newQty]
    );
  }

  // inventory_log
  await queryAsUser(
    user,
    `INSERT INTO inventory_log
      (tenant_id, organization_id, product_id, product_name, unit_id,
       change_amount, previous_qty, new_qty, entry_type, reason,
       reference_id, reference_number, unit_cost, total_value,
       created_by, created_by_name, date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      tenantId, organizationId,
      productId, productName || null, unitId,
      changeAmount, previousQty, newQty,
      entryType, reason || null,
      referenceId || null, referenceNumber || null,
      unitCost, Number(changeAmount) * unitCost,
      createdBy || null, createdByName || null,
      date || new Date().toISOString().split('T')[0],
    ]
  );

  return { previousQty, newQty, changeAmount };
}

// ═══════════════════════════════════════════════
//  GET /api/stock/rls/list — كل المخزون
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT
         s.id,
         s.product_id,
         s.unit_id,
         s.quantity,
         s.min_quantity,
         s.tenant_id,
         s.organization_id,
         s.updated_at,
         p.name          AS product_name,
         p.name          AS name,
         u.name          AS unit_name,
         u.symbol        AS unit_symbol,
         COALESCE(pu.cost, 0)             AS cost,
         COALESCE(pu.retail_price, 0)     AS retail_price,
         COALESCE(pu.retail_price, 0)     AS price,
         COALESCE(pu.wholesale_price, 0)  AS wholesale_price,
         pu.barcode                       AS barcode
       FROM stock s
       LEFT JOIN products p ON p.id = s.product_id
       LEFT JOIN units u ON u.id = s.unit_id
       LEFT JOIN product_units pu
         ON pu.product_id = s.product_id AND pu.unit_id = s.unit_id
       ORDER BY p.name
       LIMIT 500`
    );
    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /stock/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/stock/rls/detailed
//  ✅ تجميع حسب المنتج مع كل وحداته
// ═══════════════════════════════════════════════
router.get('/rls/detailed', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT
         s.id AS stock_id,
         s.product_id,
         s.unit_id,
         s.quantity,
         s.min_quantity,
         s.updated_at,
         p.name AS product_name,
         u.name AS unit_name,
         u.symbol AS unit_symbol
       FROM stock s
       LEFT JOIN products p ON p.id = s.product_id
       LEFT JOIN units u ON u.id = s.unit_id
       ORDER BY p.name, u.name`
    );

    const grouped = {};
    (result.rows || []).forEach((s) => {
      const key = s.product_id;
      if (!grouped[key]) {
        grouped[key] = {
          product_id: s.product_id,
          product_name: s.product_name || '—',
          units: [],
          total_quantity: 0,
        };
      }
      grouped[key].units.push({
        stock_id: s.stock_id,
        unit_id: s.unit_id,
        unit_name: s.unit_name || '—',
        unit_symbol: s.unit_symbol || '',
        quantity: Number(s.quantity) || 0,
        min_quantity: Number(s.min_quantity) || 0,
        updated_at: s.updated_at,
      });
      grouped[key].total_quantity += Number(s.quantity) || 0;
    });

    res.json({
      ok: true,
      count: Object.keys(grouped).length,
      data: Object.values(grouped),
    });
  } catch (err) {
    console.error('GET /stock/rls/detailed error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/stock/rls/product/:productId
// ═══════════════════════════════════════════════
router.get('/rls/product/:productId', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT
         COALESCE(s.id, pu.id) AS id,
         pu.product_id,
         pu.unit_id,
         COALESCE(s.quantity, pu.quantity, 0) AS quantity,
         COALESCE(s.min_quantity, pu.min_quantity, 0) AS min_quantity,
         pu.barcode, pu.cost, pu.wholesale_price, pu.retail_price,
         u.name AS unit_name, u.symbol AS unit_symbol,
         p.name AS product_name
       FROM product_units pu
       LEFT JOIN stock s
         ON s.product_id = pu.product_id AND s.unit_id = pu.unit_id
       LEFT JOIN units u ON u.id = pu.unit_id
       LEFT JOIN products p ON p.id = pu.product_id
       WHERE pu.product_id = $1
       ORDER BY pu.created_at`,
      [req.params.productId]
    );
    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /stock/rls/product error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/stock/rls/low-stock
// ═══════════════════════════════════════════════
router.get('/rls/low-stock', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const result = await queryAsUser(
      user,
      `SELECT
         s.id, s.product_id, s.unit_id,
         s.quantity, s.min_quantity,
         p.name AS product_name,
         p.name AS name,
         u.name AS unit_name, u.symbol AS unit_symbol,
         COALESCE(pu.cost, 0)         AS cost,
         COALESCE(pu.retail_price, 0) AS retail_price,
         COALESCE(pu.retail_price, 0) AS price
       FROM stock s
       LEFT JOIN products p ON p.id = s.product_id
       LEFT JOIN units u ON u.id = s.unit_id
       LEFT JOIN product_units pu
         ON pu.product_id = s.product_id AND pu.unit_id = s.unit_id
       WHERE s.quantity <= s.min_quantity
       ORDER BY (s.min_quantity - s.quantity) DESC`
    );
    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /stock/rls/low-stock error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/stock/rls/log
//  ✅ يقبل "type" كـ alias لـ "entry_type"
// ═══════════════════════════════════════════════
router.get('/rls/log', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const {
      product_id,
      entry_type,
      type,
      start_date,
      end_date,
      limit = 200,
    } = req.query;

    const finalEntryType = entry_type || type;

    let where = 'WHERE 1=1';
    const params = [];

    if (product_id) {
      params.push(product_id);
      where += ` AND product_id = $${params.length}`;
    }
    if (finalEntryType) {
      params.push(finalEntryType);
      where += ` AND entry_type = $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      where += ` AND date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      where += ` AND date <= $${params.length}`;
    }

    params.push(Math.min(parseInt(limit) || 200, 1000));

    const result = await queryAsUser(
      user,
      `SELECT
         il.*,
         il.entry_type AS type,
         p.name AS product_join_name
       FROM inventory_log il
       LEFT JOIN products p ON p.id = il.product_id
       ${where}
       ORDER BY il.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /stock/rls/log error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/stock/rls/verify-balance
//  ✅ يقارن stock.quantity مع SUM(inventory_log.change_amount)
// ═══════════════════════════════════════════════
router.post('/rls/verify-balance', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const [stocksRes, logsRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT product_id, unit_id, quantity FROM stock WHERE tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT product_id, unit_id, change_amount
         FROM inventory_log WHERE tenant_id = $1`,
        [tenantId]
      ),
    ]);

    const logsMap = {};
    (logsRes.rows || []).forEach((l) => {
      const k = `${l.product_id}_${l.unit_id}`;
      logsMap[k] = (logsMap[k] || 0) + (Number(l.change_amount) || 0);
    });

    const discrepancies = [];
    for (const s of stocksRes.rows || []) {
      const k = `${s.product_id}_${s.unit_id}`;
      const cached = Number(s.quantity) || 0;
      const calculated = logsMap[k] || 0;
      const diff = cached - calculated;

      if (Math.abs(diff) > 0.001) {
        discrepancies.push({
          product_id: s.product_id,
          unit_id: s.unit_id,
          cached,
          calculated,
          difference: diff,
        });
      }
    }

    res.json({
      ok: true,
      total_checked: (stocksRes.rows || []).length,
      discrepancies_count: discrepancies.length,
      discrepancies,
    });
  } catch (err) {
    console.error('POST /stock/rls/verify-balance error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/stock/rls/adjust
//  ✅ يقبل type أو entry_type
// ═══════════════════════════════════════════════
router.post('/rls/adjust', optionalAuth, async (req, res) => {
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
      product_id,
      product_name,
      unit_id,
      change_amount,
      entry_type,
      type,
      reason,
      unit_cost = 0,
    } = req.body;

    const finalEntryType = entry_type || type || 'adjustment';

    if (!product_id || !unit_id || change_amount === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'product_id, unit_id, change_amount are required',
      });
    }

    const result = await adjustStock(user, {
      tenantId,
      organizationId: user.organization_id,
      productId: product_id,
      productName: product_name,
      unitId: unit_id,
      changeAmount: Number(change_amount),
      entryType: finalEntryType,
      reason,
      unitCost: Number(unit_cost) || 0,
      createdBy: user.sub,
      createdByName: user.email,
    });

    await req.audit({
      action: 'adjust',
      tableName: 'stock',
      recordId: product_id,
      newData: result,
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('POST /stock/rls/adjust error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/stock/rls/apply-invoice
// ═══════════════════════════════════════════════
router.post('/rls/apply-invoice', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const { invoiceId, invoiceNumber, invoiceType, items = [], date } = req.body;

    if (!['sale', 'purchase'].includes(invoiceType)) {
      return res.status(400).json({ ok: false, error: 'invalid invoiceType' });
    }

    const results = [];
    const errors = [];
    const direction = invoiceType === 'sale' ? -1 : 1;

    for (const item of items) {
      try {
        const r = await adjustStock(user, {
          tenantId,
          organizationId: user.organization_id,
          productId: item.product_id,
          productName: item.product_name,
          unitId: item.unit_id,
          changeAmount: direction * (Number(item.quantity) || 0),
          entryType: invoiceType === 'sale' ? 'sale' : 'purchase',
          reason: invoiceType === 'sale' ? 'فاتورة مبيعات' : 'فاتورة مشتريات',
          referenceId: invoiceId,
          referenceNumber: invoiceNumber,
          unitCost: Number(item.cost || item.price || 0),
          createdBy: user.sub,
          createdByName: user.email,
          date,
        });
        results.push({ product_id: item.product_id, ...r });
      } catch (e) {
        errors.push({ product_id: item.product_id, error: e.message });
      }
    }

    await req.audit({
      action: invoiceType === 'sale' ? 'sale-invoice' : 'purchase-invoice',
      tableName: 'stock',
      recordId: invoiceId,
      newData: { results, errors },
    });

    res.json({ ok: errors.length === 0, applied: results.length, errors, results });
  } catch (err) {
    console.error('POST /stock/rls/apply-invoice error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/stock/rls/apply-return
// ═══════════════════════════════════════════════
router.post('/rls/apply-return', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const { returnId, returnNumber, returnType, items = [], date } = req.body;

    if (!['sales_return', 'purchase_return'].includes(returnType)) {
      return res.status(400).json({ ok: false, error: 'invalid returnType' });
    }

    const results = [];
    const errors = [];
    const direction = returnType === 'sales_return' ? 1 : -1;

    for (const item of items) {
      try {
        const r = await adjustStock(user, {
          tenantId,
          organizationId: user.organization_id,
          productId: item.product_id,
          productName: item.product_name,
          unitId: item.unit_id,
          changeAmount: direction * (Number(item.quantity) || 0),
          entryType: returnType,
          reason: returnType === 'sales_return' ? 'مرتجع مبيعات' : 'مرتجع مشتريات',
          referenceId: returnId,
          referenceNumber: returnNumber,
          unitCost: Number(item.price || item.cost || 0),
          createdBy: user.sub,
          createdByName: user.email,
          date,
        });
        results.push({ product_id: item.product_id, ...r });
      } catch (e) {
        errors.push({ product_id: item.product_id, error: e.message });
      }
    }

    await req.audit({
      action: returnType,
      tableName: 'stock',
      recordId: returnId,
      newData: { results, errors },
    });

    res.json({ ok: errors.length === 0, applied: results.length, errors, results });
  } catch (err) {
    console.error('POST /stock/rls/apply-return error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/stock/rls/check-availability
// ═══════════════════════════════════════════════
router.post('/rls/check-availability', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const { items = [] } = req.body;
    const unavailable = [];

    for (const item of items) {
      const stock = await getStockRow(user, user.tenant_id, item.product_id, item.unit_id);
      const available = Number(stock?.quantity || 0);
      if (available < Number(item.quantity || 0)) {
        unavailable.push({
          product_id: item.product_id,
          product_name: item.product_name,
          requested: Number(item.quantity || 0),
          available,
        });
      }
    }

    res.json({ ok: unavailable.length === 0, available: unavailable.length === 0, unavailable });
  } catch (err) {
    console.error('POST /stock/rls/check-availability error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;