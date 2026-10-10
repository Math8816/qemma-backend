// ═══════════════════════════════════════════════
//  src/routes/invites.js
//  إدارة الدعوات — 4 endpoints
// ═══════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

const ALLOWED_ROLES = [
  'owner',
  'org_admin',
  'store_admin',
  'store_manager',
  'employee',
  'accountant',
  'inventory_manager',
  'trial_store_manager',
];

function requireRole(user, roles) {
  if (!user?.sub) return { ok: false, code: 401, error: 'Authentication required' };
  if (!roles.includes(user.role)) return { ok: false, code: 403, error: 'Access denied' };
  return { ok: true };
}

// ═══════════════════════════════════════════════
//  POST /api/invites — إنشاء دعوة
// ═══════════════════════════════════════════════
router.post('/', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const {
      email,
      fullName,
      role,
      tenantId = null,
      organizationId = null,
      tempPassword = 'TempPass123!',
    } = req.body;

    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    if (!role) return res.status(400).json({ ok: false, error: 'role required' });
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: 'Invalid role' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // ─── فحص المستخدم الموجود ───
    const existingRes = await pool.query(
      `SELECT id, invite_status, organization_id FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      if (existing.invite_status === 'pending') {
        const now = new Date();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(
          `UPDATE users SET invite_sent_at = $1, invite_expires_at = $2 WHERE id = $3`,
          [now, expiresAt, existing.id]
        );
        return res.json({ ok: true, success: true, userId: existing.id, resent: true });
      }
      return res.status(409).json({
        ok: false,
        error: 'هذا البريد الإلكتروني مستخدم بالفعل',
      });
    }

    // ─── إنشاء المستخدم ───
    const userId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await pool.query(
      `INSERT INTO users
        (id, email, full_name, role, password_hash, tenant_id, organization_id,
         is_active, invite_status, invite_sent_at, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'pending', $8, $9)`,
      [
        userId,
        normalizedEmail,
        fullName || null,
        role,
        passwordHash,
        tenantId,
        organizationId,
        now,
        expiresAt,
      ]
    );

    // ─── ربط Owner بـ Organization ───
    if (role === 'owner' && organizationId) {
      await pool.query(
        `UPDATE organizations SET owner_id = $1, updated_at = NOW() WHERE id = $2`,
        [userId, organizationId]
      );
    }

    await req.audit({
      action: 'invite',
      tableName: 'users',
      recordId: userId,
      newData: { email: normalizedEmail, role, organizationId, tenantId },
    });

    res.status(201).json({
      ok: true,
      success: true,
      userId,
      email: normalizedEmail,
      role,
      organizationId,
      tenantId,
    });
  } catch (err) {
    console.error('POST /api/invites error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/invites/:userId/resend
// ═══════════════════════════════════════════════
router.post('/:userId/resend', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const now = new Date();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `UPDATE users
       SET invite_sent_at = $1, invite_expires_at = $2, invite_status = 'pending'
       WHERE id = $3
       RETURNING id, email, full_name, role, tenant_id, organization_id`,
      [now, expiresAt, req.params.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    res.json({ ok: true, success: true, user: result.rows[0] });
  } catch (err) {
    console.error('POST /api/invites/:id/resend error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/invites/:userId/accept
// ═══════════════════════════════════════════════
router.post('/:userId/accept', optionalAuth, async (req, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // نفس المستخدم فقط أو developer
    if (req.user.role !== 'developer' && req.user.sub !== req.params.userId) {
      return res.status(403).json({
        ok: false,
        error: 'Can only accept your own invitation',
      });
    }

    await pool.query(
      `UPDATE users
       SET invite_status = 'accepted', last_login = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [req.params.userId]
    );

    res.json({ ok: true, success: true });
  } catch (err) {
    console.error('POST /api/invites/:id/accept error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/invites/:userId
// ═══════════════════════════════════════════════
router.delete('/:userId', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const userRes = await pool.query(
      `SELECT role, organization_id FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const user = userRes.rows[0];
    if (user.role === 'owner' && user.organization_id) {
      await pool.query(
        `UPDATE organizations SET owner_id = NULL WHERE id = $1 AND owner_id = $2`,
        [user.organization_id, req.params.userId]
      );
    }

    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.userId]);

    res.json({ ok: true, success: true });
  } catch (err) {
    console.error('DELETE /api/invites/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;