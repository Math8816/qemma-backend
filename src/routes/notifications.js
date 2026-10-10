// ═══════════════════════════════════════════════
//  src/routes/notifications.js
//  إشعارات المستخدم — قراءة + تحديث + حذف
// ═══════════════════════════════════════════════

const express = require('express');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/notifications/rls/list
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { unread, limit: limitParam } = req.query;
    const limit = Math.min(parseInt(limitParam) || 100, 500);

    let whereClause = 'WHERE user_id = $1';
    const params = [user.sub];

    if (unread === 'true') {
      whereClause += ' AND is_read = false';
    }

    params.push(limit);

    const result = await queryAsUser(
      user,
      `SELECT 
         id, user_id, tenant_id,
         title, message, type, link, is_read, created_at
       FROM notifications
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /notifications/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/notifications/rls/count
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.get('/rls/count', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `SELECT COUNT(*)::int AS count 
       FROM notifications 
       WHERE user_id = $1 AND is_read = false`,
      [user.sub]
    );

    res.json({ ok: true, count: result.rows[0]?.count || 0 });
  } catch (err) {
    console.error('GET /notifications/rls/count error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/notifications/rls/mark-all-read
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.put('/rls/mark-all-read', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `UPDATE notifications
       SET is_read = true
       WHERE user_id = $1 AND is_read = false
       RETURNING id`,
      [user.sub]
    );

    res.json({ ok: true, updated: result.rows.length });
  } catch (err) {
    console.error('PUT /notifications/rls/mark-all-read error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/notifications/rls/:id — تبديل حالة
// ═══════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { is_read } = req.body;

    const result = await queryAsUser(
      user,
      `UPDATE notifications
       SET is_read = $1
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [is_read === true, req.params.id, user.sub]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Notification not found' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /notifications/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/notifications/rls/all — حذف الكل
//  ⚠️ قبل /:id
// ═══════════════════════════════════════════════
router.delete('/rls/all', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM notifications WHERE user_id = $1 RETURNING id`,
      [user.sub]
    );

    res.json({ ok: true, deleted: result.rows.length });
  } catch (err) {
    console.error('DELETE /notifications/rls/all error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/notifications/rls/:id
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const result = await queryAsUser(
      user,
      `DELETE FROM notifications
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, user.sub]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Notification not found' });
    }

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /notifications/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;