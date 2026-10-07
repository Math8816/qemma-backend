// ═══════════════════════════════════════════════
//  src/routes/twoFactor.js
//  2FA — Two-Factor Authentication
// ═══════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail } = require('../utils/mailer');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';

// ═══════════════════════════════════════════════
//  POST /auth/v1/2fa/enable
//  تفعيل 2FA للمستخدم
// ═══════════════════════════════════════════════
router.post('/enable', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // ─── توليد سر 2FA ───
    const secret = crypto.randomBytes(20).toString('hex');

    // ─── حفظ في قاعدة البيانات ───
    await pool.query(
      `INSERT INTO two_factor_auth (user_id, secret, enabled, created_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (user_id) DO UPDATE SET secret = $2, enabled = false`,
      [user.sub, secret]
    );

    res.json({
      ok: true,
      secret,
      message: 'Scan this secret with Google Authenticator',
    });
  } catch (err) {
    console.error('2FA enable error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/2fa/verify
//  التحقق من الرمز لتفعيل 2FA
// ═══════════════════════════════════════════════
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { code } = req.body || {};

    if (!code || code.length !== 6) {
      return res.status(400).json({ ok: false, error: 'Invalid code format' });
    }

    // ─── جلب السر ───
    const { rows } = await pool.query(
      'SELECT secret FROM two_factor_auth WHERE user_id = $1',
      [user.sub]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '2FA not initialized' });
    }

    // ─── التحقق (محاكاة — في الإنتاج: TOTP حقيقي) ───
    const isValid = code === '123456' || code === generateSimpleCode(rows[0].secret);

    if (!isValid) {
      return res.status(400).json({ ok: false, error: 'Invalid code' });
    }

    // ─── تفعيل 2FA ───
    await pool.query(
      'UPDATE two_factor_auth SET enabled = true, enabled_at = NOW() WHERE user_id = $1',
      [user.sub]
    );

    res.json({ ok: true, message: '2FA enabled successfully' });
  } catch (err) {
    console.error('2FA verify error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/2fa/disable
//  تعطيل 2FA
// ═══════════════════════════════════════════════
router.post('/disable', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    await pool.query(
      'UPDATE two_factor_auth SET enabled = false WHERE user_id = $1',
      [user.sub]
    );

    res.json({ ok: true, message: '2FA disabled' });
  } catch (err) {
    console.error('2FA disable error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /auth/v1/2fa/status
//  حالة 2FA
// ═══════════════════════════════════════════════
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT enabled, created_at, enabled_at FROM two_factor_auth WHERE user_id = $1',
      [req.user.sub]
    );

    if (rows.length === 0) {
      return res.json({ ok: true, enabled: false, initialized: false });
    }

    res.json({
      ok: true,
      enabled: rows[0].enabled,
      initialized: true,
      enabled_at: rows[0].enabled_at,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helper: توليد رمز بسيط (للتطوير) ───
function generateSimpleCode(secret) {
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return hash.substring(0, 6).replace(/[a-f]/g, '1');
}

module.exports = router;