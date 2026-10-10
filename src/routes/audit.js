// ═══════════════════════════════════════════════
//  src/routes/audit.js
//  قراءة Audit Log — مع RLS للفرع
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  GET /api/audit — كل السجل (Developer فقط)
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
//  GET /api/audit/stats — إحصائيات عامة
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
      `SELECT COUNT(*)::int AS count 
       FROM audit_log 
       WHERE created_at > NOW() - INTERVAL '24 hours'`
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

// ═══════════════════════════════════════════════
//  GET /api/audit/rls/list — سجلات الفرع فقط
//  ⚠️ يجب أن يكون قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    if (!user.tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const { table, action, limit = 100, offset = 0 } = req.query;

    // ✅ فلترة إجبارية بـ tenant_id
    let query = 'SELECT * FROM audit_log WHERE tenant_id = $1';
    const params = [user.tenant_id];

    if (table) {
      params.push(table);
      query += ` AND table_name = $${params.length}`;
    }

    if (action) {
      params.push(action);
      query += ` AND action = $${params.length}`;
    }

    params.push(Math.min(parseInt(limit) || 100, 500));
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    params.push(parseInt(offset) || 0);
    query += ` OFFSET $${params.length}`;

    const result = await queryAsUser(user, query, params);

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /audit/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/audit/rls/stats — إحصائيات الفرع
// ═══════════════════════════════════════════════
router.get('/rls/stats', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    if (!user.tenant_id) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const [byAction, byTable, recent] = await Promise.all([
      queryAsUser(
        user,
        `SELECT action, COUNT(*)::int AS count 
         FROM audit_log 
         WHERE tenant_id = $1 
         GROUP BY action`,
        [user.tenant_id]
      ),
      queryAsUser(
        user,
        `SELECT table_name, COUNT(*)::int AS count 
         FROM audit_log 
         WHERE tenant_id = $1 
         GROUP BY table_name`,
        [user.tenant_id]
      ),
      queryAsUser(
        user,
        `SELECT COUNT(*)::int AS count 
         FROM audit_log 
         WHERE tenant_id = $1 
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [user.tenant_id]
      ),
    ]);

    res.json({
      ok: true,
      by_action: byAction.rows,
      by_table: byTable.rows,
      last_24h: recent.rows[0]?.count || 0,
    });
  } catch (err) {
    console.error('GET /audit/rls/stats error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;