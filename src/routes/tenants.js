// ═══════════════════════════════════════════════
//  src/routes/tenants.js
//  بيانات المحلات — قراءة آمنة
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  ⚠️ مهم: /rls/list يجب أن يأتي قبل /rls/:id
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
//  GET /api/tenants/rls/list — قائمة كل tenants
//  ✅ يدعم فلترة ids (مفصولة بفاصلة)
//  ✅ يستخدم pool مباشرة (للمطور — بدون RLS)
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { ids } = req.query;

    let query = `
      SELECT 
        id, name, email, is_active,
        subscription_plan, subscription_status, created_at
      FROM tenants
      WHERE 1=1
    `;
    const params = [];

    if (ids) {
      const idList = ids.split(',').filter(Boolean);
      if (idList.length > 0) {
        params.push(idList);
        query += ` AND id = ANY($${params.length}::uuid[])`;
      }
    }

    query += ` ORDER BY name LIMIT 200`;

    // ✅ pool مباشرة (بدون RLS) — للمطور
    const result = await pool.query(query, params);

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /tenants/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/tenants/rls/:id — tenant واحد (آمن)
//  ⚠️ يجب أن يأتي AFTER /rls/list
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // حماية: لا يرى إلا tenant نفسه (إلا المطور)
    if (user.role !== 'developer' && user.tenant_id !== req.params.id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const result = await queryAsUser(
      user,
      `SELECT 
         id, name, email, phone, address, logo, subdomain,
         is_active, subscription_plan, subscription_status,
         subscription_started_at, subscription_expires_at,
         organization_id, created_at, updated_at
       FROM tenants
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Tenant not found' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /tenants/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;