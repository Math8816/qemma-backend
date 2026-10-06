// ═══════════════════════════════════════════════
//  src/routes/audit.js
//  قراءة Audit Log
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  GET /api/audit — كل السجل
// ═══════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { table, action, limit = 100, offset = 0 } = req.query;

    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];

    if (table) {
      params.push(table);
      query += ` AND table_name = $${params.length}`;
    }

    if (action) {
      params.push(action);
      query += ` AND action = $${params.length}`;
    }

    params.push(parseInt(limit));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    params.push(parseInt(offset));
    query += ` OFFSET $${params.length}`;

    const { rows } = await pool.query(query, params);

    res.json({
      ok: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error('GET /audit error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/audit/stats — إحصائيات
// ═══════════════════════════════════════════════
router.get('/stats', async (_req, res) => {
  try {
    const { rows: byAction } = await pool.query(
      'SELECT action, COUNT(*)::int AS count FROM audit_log GROUP BY action'
    );

    const { rows: byTable } = await pool.query(
      'SELECT table_name, COUNT(*)::int AS count FROM audit_log GROUP BY table_name'
    );

    const { rows: recent } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM audit_log WHERE created_at > NOW() - INTERVAL \'24 hours\''
    );

    res.json({
      ok: true,
      by_action: byAction,
      by_table: byTable,
      last_24h: recent[0].count,
    });
  } catch (err) {
    console.error('GET /audit/stats error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;