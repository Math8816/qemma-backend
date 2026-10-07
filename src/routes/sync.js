// ═══════════════════════════════════════════════
//  src/routes/sync.js
//  Sync Endpoint — استقبال دفعة العمليات
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, async (req, res) => {
  const { operations } = req.body;

  if (!Array.isArray(operations)) {
    return res.status(400).json({ error: 'operations must be an array' });
  }

  const results = [];

  for (const op of operations) {
    try {
      const result = await processOperation(op);
      results.push({ id: op.id, status: 'success', result });
    } catch (err) {
      results.push({ id: op.id, status: 'failed', error: err.message });
    }
  }

  res.json({ results });
});

async function processOperation(op) {
  const { table, operation, recordId, data } = op;

  // Whitelist
  const ALLOWED = [
    'products', 'customers', 'suppliers', 'categories', 'companies',
    'sales_invoices', 'sales_invoice_items', 'purchase_invoices',
    'purchase_invoice_items', 'transactions', 'returns', 'return_items',
  ];

  if (!ALLOWED.includes(table)) {
    throw new Error(`Table "${table}" not allowed for sync`);
  }

  if (operation === 'create') {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    return rows[0];
  }

  if (operation === 'update') {
    const keys = Object.keys(data).filter(k => k !== 'id' && k !== 'created_at');
    const values = keys.map(k => data[k]);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

    values.push(recordId);
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${setClause}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0];
  }

  if (operation === 'delete') {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [recordId]);
    return { deleted: true };
  }

  throw new Error(`Unknown operation: ${operation}`);
}

module.exports = router;