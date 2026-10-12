// ═══════════════════════════════════════════════════════════
//  src/routes/twoFactor.js
//  2FA — TOTP حقيقي (RFC 6238) + Backup Codes
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';
const APP_NAME = 'Qemma';

// ═══════════════════════════════════════════════════════════
//  ⚙️ إعدادات TOTP
// ═══════════════════════════════════════════════════════════
authenticator.options = {
  window: 1,       // قبول ±30 ثانية
  step: 30,        // كل 30 ثانية
  digits: 6,       // 6 أرقام
};

// ═══════════════════════════════════════════════════════════
//  Helper — توليد backup codes
// ═══════════════════════════════════════════════════════════
function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto
    .createHash('sha256')
    .update(code.toUpperCase().replace(/\s/g, ''))
    .digest('hex');
}

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/2fa/enable — بدء تفعيل 2FA
// ═══════════════════════════════════════════════════════════
router.post('/enable', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // جلب email
    const { rows: userRows } = await pool.query(
      `SELECT email FROM users WHERE id = $1`,
      [user.sub]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const email = userRows[0].email;

    // فحص إذا مُفعّل مسبقاً
    const { rows: existing } = await pool.query(
      `SELECT enabled FROM two_factor_auth WHERE user_id = $1`,
      [user.sub]
    );

    if (existing.length > 0 && existing[0].enabled) {
      return res.status(409).json({
        ok: false,
        error: '2FA already enabled',
      });
    }

    // ═══ توليد TOTP secret ═══
    const secret = authenticator.generateSecret();
    // مثال: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

    // ═══ otpauth URL ═══
    const otpauthUrl = authenticator.keyuri(email, APP_NAME, secret);

    // ═══ QR Code كـ Data URL ═══
    const qrCode = await QRCode.toDataURL(otpauthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 200,
    });

    // ═══ حفظ في DB ═══
    await pool.query(
      `INSERT INTO two_factor_auth (user_id, secret, enabled, created_at, updated_at)
       VALUES ($1, $2, false, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET secret = $2, enabled = false, updated_at = NOW()`,
      [user.sub, secret]
    );

    console.log(`🔐 2FA enable initiated for ${email}`);

    res.json({
      ok: true,
      secret,
      otpauthUrl,
      qrCode,
      message: 'Scan QR code with Google Authenticator',
    });
  } catch (err) {
    console.error('❌ 2FA enable error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/2fa/verify — التحقق لتفعيل 2FA
// ═══════════════════════════════════════════════════════════
router.post('/verify', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { code } = req.body || {};

    // Validation
    if (!code || !/^\d{6}$/.test(String(code).trim())) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid code format (6 digits required)',
      });
    }

    // جلب secret
    const { rows } = await pool.query(
      `SELECT secret, enabled FROM two_factor_auth WHERE user_id = $1`,
      [user.sub]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: '2FA not initialized. Call /enable first.',
      });
    }

    if (rows[0].enabled) {
      return res.status(409).json({
        ok: false,
        error: '2FA already enabled',
      });
    }

    // ═══ التحقق بـ TOTP ═══
    const isValid = authenticator.verify({
      token: String(code).trim(),
      secret: rows[0].secret,
    });

    if (!isValid) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid code. Please try again.',
      });
    }

    // ═══ توليد backup codes ═══
    const backupCodes = generateBackupCodes(10);
    const hashedCodes = backupCodes.map(hashBackupCode);

    // ═══ تفعيل ═══
    await pool.query(
      `UPDATE two_factor_auth
       SET enabled = true,
           enabled_at = NOW(),
           disabled_at = NULL,
           backup_codes = $1,
           updated_at = NOW()
       WHERE user_id = $2`,
      [JSON.stringify(hashedCodes), user.sub]
    );

    console.log(`✅ 2FA enabled for user ${user.email}`);

    res.json({
      ok: true,
      message: '2FA enabled successfully',
      backupCodes,
      warning: 'احفظ هذه الرموز في مكان آمن. لن تُعرض مرة أخرى.',
    });
  } catch (err) {
    console.error('❌ 2FA verify error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/2fa/disable — تعطيل 2FA
// ═══════════════════════════════════════════════════════════
router.post('/disable', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { code } = req.body || {};

    if (!code || !/^\d{6}$/.test(String(code).trim())) {
      return res.status(400).json({
        ok: false,
        error: 'Code required to disable 2FA',
      });
    }

    // جلب secret
    const { rows } = await pool.query(
      `SELECT secret, enabled FROM two_factor_auth WHERE user_id = $1`,
      [user.sub]
    );

    if (rows.length === 0 || !rows[0].enabled) {
      return res.status(400).json({
        ok: false,
        error: '2FA not enabled',
      });
    }

    // التحقق
    const isValid = authenticator.verify({
      token: String(code).trim(),
      secret: rows[0].secret,
    });

    if (!isValid) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid code',
      });
    }

    // تعطيل
    await pool.query(
      `UPDATE two_factor_auth
       SET enabled = false,
           disabled_at = NOW(),
           backup_codes = '[]'::jsonb,
           updated_at = NOW()
       WHERE user_id = $1`,
      [user.sub]
    );

    console.log(`🔓 2FA disabled for user ${user.email}`);

    res.json({ ok: true, message: '2FA disabled successfully' });
  } catch (err) {
    console.error('❌ 2FA disable error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /auth/v1/2fa/status — حالة 2FA
// ═══════════════════════════════════════════════════════════
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT enabled, created_at, enabled_at, disabled_at,
              jsonb_array_length(COALESCE(backup_codes, '[]'::jsonb)) AS backup_codes_count
       FROM two_factor_auth WHERE user_id = $1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return res.json({
        ok: true,
        enabled: false,
        initialized: false,
        backup_codes_count: 0,
      });
    }

    res.json({
      ok: true,
      enabled: rows[0].enabled,
      initialized: true,
      enabled_at: rows[0].enabled_at,
      disabled_at: rows[0].disabled_at,
      backup_codes_count: rows[0].backup_codes_count,
    });
  } catch (err) {
    console.error('❌ 2FA status error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/2fa/verify-backup — استخدام backup code
// ═══════════════════════════════════════════════════════════
router.post('/verify-backup', async (req, res) => {
  try {
    const { temp_token, backup_code } = req.body || {};

    if (!temp_token || !backup_code) {
      return res.status(400).json({
        ok: false,
        error: 'temp_token and backup_code required',
      });
    }

    // فك temp_token
    let payload;
    try {
      payload = jwt.verify(temp_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or expired token',
      });
    }

    if (payload.purpose !== '2fa_pending') {
      return res.status(403).json({
        ok: false,
        error: 'Invalid token purpose',
      });
    }

    // جلب backup codes
    const { rows } = await pool.query(
      `SELECT backup_codes FROM two_factor_auth
       WHERE user_id = $1 AND enabled = true`,
      [payload.sub]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: '2FA not enabled' });
    }

    const hashedInput = hashBackupCode(backup_code);
    const storedCodes = Array.isArray(rows[0].backup_codes)
      ? rows[0].backup_codes
      : [];

    const index = storedCodes.indexOf(hashedInput);
    if (index === -1) {
      return res.status(400).json({ ok: false, error: 'Invalid backup code' });
    }

    // إزالة الرمز المُستخدم
    const newCodes = storedCodes.filter((_, i) => i !== index);
    await pool.query(
      `UPDATE two_factor_auth SET backup_codes = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [JSON.stringify(newCodes), payload.sub]
    );

    // جلب user
    const { rows: userRows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id,
              is_active, invite_status
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const user = userRows[0];

    // تحديث last_login
    await pool.query(
      `UPDATE users
       SET last_login = NOW(),
           invite_status = CASE
             WHEN invite_status = 'pending' THEN 'accepted'
             ELSE invite_status
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // إصدار JWT + context
    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id || null,
        organization_id: user.organization_id || null,
      },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
    );

    // استدعاء buildAuthResponse من auth.js
    // ⚠️ مؤقتاً نُعيد استجابة مبسطة — سنُحدّثها لاحقاً
    const authRouter = require('./auth');
    // أو نُعيد الرد مباشرة

    res.json({
      ok: true,
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token: null,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        tenant_id: user.tenant_id,
        organization_id: user.organization_id,
        is_active: user.is_active,
        invite_status: user.invite_status,
      },
      used_backup_code: true,
      remaining_backup_codes: newCodes.length,
    });
  } catch (err) {
    console.error('❌ 2FA verify-backup error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;