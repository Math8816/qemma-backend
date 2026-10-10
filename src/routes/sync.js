// ═══════════════════════════════════════════════
//  src/routes/sync.js
//  مزامنة البيانات للـ Offline
//  ✅ 5 endpoints: full, invoices, returns, transactions, batch
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  🔐 Helper: التحقق من الجلسة
// ═══════════════════════════════════════════════
function requireTenant(req, res) {
  if (!req.user?.sub) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return null;
  }
  if (!req.user.tenant_id) {
    res.status(400).json({ ok: false, error: 'tenant_id required' });
    return null;
  }
  return req.user;
}

// ═══════════════════════════════════════════════
//  GET /api/sync/full
//  ✅ كل البيانات الأساسية دفعة واحدة
// ═══════════════════════════════════════════════
router.get('/full', optionalAuth, async (req, res) => {
  try {
    const user = requireTenant(req, res);
    if (!user) return;

    const tenantId = user.tenant_id;

    const [
      productsRes,
      productUnitsRes,
      unitsRes,
      categoriesRes,
      companiesRes,
      customersRes,
      suppliersRes,
      salesRepsRes,
      stockRes,
    ] = await Promise.all([
      queryAsUser(
        user,
        `SELECT * FROM products WHERE tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT pu.*, u.name AS unit_name, u.symbol AS unit_symbol
         FROM product_units pu
         LEFT JOIN units u ON u.id = pu.unit_id
         WHERE pu.tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM units WHERE tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM categories WHERE tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM companies WHERE tenant_id = $1`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM customers WHERE tenant_id = $1 ORDER BY full_name`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM suppliers WHERE tenant_id = $1 ORDER BY name`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT id, full_name, phone, email, is_active, tenant_id
         FROM sales_reps
         WHERE tenant_id = $1
         ORDER BY full_name`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT s.*, p.name AS product_name
         FROM stock s
         LEFT JOIN products p ON p.id = s.product_id
         WHERE s.tenant_id = $1`,
        [tenantId]
      ),
    ]);

    res.json({
      ok: true,
      tenant_id: tenantId,
      synced_at: new Date().toISOString(),
      products: productsRes.rows || [],
      product_units: productUnitsRes.rows || [],
      units: unitsRes.rows || [],
      categories: categoriesRes.rows || [],
      companies: companiesRes.rows || [],
      customers: customersRes.rows || [],
      suppliers: suppliersRes.rows || [],
      sales_reps: salesRepsRes.rows || [],
      stock: stockRes.rows || [],
    });
  } catch (err) {
    console.error('GET /api/sync/full error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sync/invoices?type=sales|purchase
//  ✅ الفواتير + أصنافها
// ═══════════════════════════════════════════════
router.get('/invoices', optionalAuth, async (req, res) => {
  try {
    const user = requireTenant(req, res);
    if (!user) return;

    const { type = 'sales' } = req.query;
    const tenantId = user.tenant_id;

    if (type === 'sales') {
      const [invoicesRes, itemsRes] = await Promise.all([
        queryAsUser(
          user,
          `SELECT * FROM sales_invoices
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 500`,
          [tenantId]
        ),
        queryAsUser(
          user,
          `SELECT * FROM sales_invoice_items
           WHERE tenant_id = $1
           LIMIT 2000`,
          [tenantId]
        ),
      ]);

      return res.json({
        ok: true,
        type: 'sales',
        invoices: invoicesRes.rows || [],
        items: itemsRes.rows || [],
      });
    }

    if (type === 'purchase') {
      const [invoicesRes, itemsRes] = await Promise.all([
        queryAsUser(
          user,
          `SELECT * FROM purchase_invoices
           WHERE tenant_id = $1
           ORDER BY created_at DESC
           LIMIT 500`,
          [tenantId]
        ),
        queryAsUser(
          user,
          `SELECT * FROM purchase_invoice_items
           WHERE tenant_id = $1
           LIMIT 2000`,
          [tenantId]
        ),
      ]);

      return res.json({
        ok: true,
        type: 'purchase',
        invoices: invoicesRes.rows || [],
        items: itemsRes.rows || [],
      });
    }

    return res.status(400).json({
      ok: false,
      error: 'Invalid type (sales|purchase)',
    });
  } catch (err) {
    console.error('GET /api/sync/invoices error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sync/returns?type=sales_return|purchase_return
//  ✅ المرتجعات + أصنافها
// ═══════════════════════════════════════════════
router.get('/returns', optionalAuth, async (req, res) => {
  try {
    const user = requireTenant(req, res);
    if (!user) return;

    const { type } = req.query;
    const tenantId = user.tenant_id;

    let where = 'WHERE tenant_id = $1';
    const params = [tenantId];

    if (type) {
      params.push(type);
      where += ` AND type = $${params.length}`;
    }

    const [returnsRes, itemsRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT * FROM returns ${where}
         ORDER BY created_at DESC
         LIMIT 500`,
        params
      ),
      queryAsUser(
        user,
        `SELECT * FROM return_items
         WHERE tenant_id = $1
         LIMIT 2000`,
        [tenantId]
      ),
    ]);

    res.json({
      ok: true,
      type: type || 'all',
      returns: returnsRes.rows || [],
      items: itemsRes.rows || [],
    });
  } catch (err) {
    console.error('GET /api/sync/returns error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/sync/transactions
//  ✅ المعاملات المالية + القيود المحاسبية
// ═══════════════════════════════════════════════
router.get('/transactions', optionalAuth, async (req, res) => {
  try {
    const user = requireTenant(req, res);
    if (!user) return;

    const tenantId = user.tenant_id;

    const [txRes, ledgerRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT * FROM transactions
         WHERE tenant_id = $1
         ORDER BY created_at DESC
         LIMIT 500`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM ledger_entries
         WHERE tenant_id = $1
         ORDER BY entry_date DESC, created_at DESC
         LIMIT 500`,
        [tenantId]
      ),
    ]);

    res.json({
      ok: true,
      transactions: txRes.rows || [],
      ledger_entries: ledgerRes.rows || [],
    });
  } catch (err) {
    console.error('GET /api/sync/transactions error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/sync/batch
//  ✅ استقبال دفعة عمليات offline
// ═══════════════════════════════════════════════
router.post('/batch', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { operations } = req.body;
    if (!Array.isArray(operations)) {
      return res.status(400).json({
        ok: false,
        error: 'operations must be an array',
      });
    }

    const results = [];

    for (const op of operations) {
      try {
        const result = await processOperation(user, op);
        results.push({ id: op.id, status: 'success', result });
      } catch (err) {
        results.push({ id: op.id, status: 'failed', error: err.message });
      }
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error('POST /api/sync/batch error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  Helper: تنفيذ عملية واحدة
// ═══════════════════════════════════════════════
async function processOperation(user, op) {
  const { table, operation, recordId, data } = op;

  const ALLOWED = [
    'products',
    'customers',
    'suppliers',
    'categories',
    'companies',
    'sales_invoices',
    'sales_invoice_items',
    'purchase_invoices',
    'purchase_invoice_items',
    'transactions',
    'returns',
    'return_items',
  ];

  if (!ALLOWED.includes(table)) {
    throw new Error(`Table "${table}" not allowed for sync`);
  }

  if (operation === 'create') {
    const enrichedData = {
      ...data,
      tenant_id: user.tenant_id,
      organization_id: user.organization_id || null,
    };

    const keys = Object.keys(enrichedData);
    const values = Object.values(enrichedData);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const result = await queryAsUser(
      user,
      `INSERT INTO ${table} (${keys.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      values
    );
    return result.rows[0];
  }

  if (operation === 'update') {
    const keys = Object.keys(data).filter(
      (k) => k !== 'id' && k !== 'created_at' && k !== 'tenant_id'
    );

    if (keys.length === 0) {
      throw new Error('No fields to update');
    }

    const values = keys.map((k) => data[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    values.push(recordId);

    const result = await queryAsUser(
      user,
      `UPDATE ${table}
       SET ${setClause}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Record not found');
    }

    return result.rows[0];
  }

  if (operation === 'delete') {
    const result = await queryAsUser(
      user,
      `DELETE FROM ${table} WHERE id = $1 RETURNING id`,
      [recordId]
    );

    if (result.rows.length === 0) {
      throw new Error('Record not found');
    }

    return { deleted: true, id: recordId };
  }

  throw new Error(`Unknown operation: ${operation}`);
}

module.exports = router;