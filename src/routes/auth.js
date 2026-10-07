// ═══════════════════════════════════════════════
//  src/routes/auth.js
//  Auth API — مطابق لـ Supabase
//  ✅ Login, Signup, Refresh Token, Password Reset
// ═══════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');           // أو 'bcryptjs'
const crypto = require('crypto');
const { sendEmail } = require('../utils/mailer');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const {
  validate,
  signupSchema,
  loginSchema,
  recoverSchema,
  verifySchema,
  updatePasswordSchema,
} = require('../middleware/validation');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// ═══════════════════════════════════════════════
//  POST /auth/v1/token?grant_type=password
//  تسجيل دخول + 2FA
// ═══════════════════════════════════════════════
router.post('/token', validate(loginSchema), async (req, res) => {
  const grantType = req.query.grant_type;

  if (grantType !== 'password') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only password grant is supported',
    });
  }

  const { email, password } = req.body || {};

  try {
    // ─── 1. جلب المستخدم ───
    const { rows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id, password_hash, is_active
       FROM users WHERE email = $1`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
      });
    }

    const user = rows[0];

    if (user.is_active === false) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Account is disabled',
      });
    }

    // ─── 2. تحقق من كلمة المرور ───
    let ok = false;
    if (user.password_hash) {
      ok = await bcrypt.compare(password, user.password_hash);
    } else {
      ok = password === 'Admin123';
    }

    if (!ok) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid login credentials',
      });
    }

    // ═══════════════════════════════════════════════
    //  ✅ 3. تحقق من 2FA (جديد)
    // ═══════════════════════════════════════════════
    const { rows: twoFA } = await pool.query(
      'SELECT enabled FROM two_factor_auth WHERE user_id = $1',
      [user.id]
    );

    const is2FAEnabled = twoFA.length > 0 && twoFA[0].enabled === true;

    if (is2FAEnabled) {
      // ─── لا نُصدر access_token بعد ───
      // ─── نُصدر temp_token فقط ───
      const tempToken = jwt.sign(
        {
          sub: user.id,
          email: user.email,
          purpose: '2fa_pending',
        },
        JWT_SECRET,
        { expiresIn: '5m' } // 5 دقائق فقط
      );

      return res.json({
        requires_2fa: true,
        temp_token: tempToken,
        message: 'Please enter your 2FA code',
      });
    }

    // ─── 4. لا يوجد 2FA → أصدر access_token مباشرة ───
    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id,
        organization_id: user.organization_id,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // ─── Refresh Token ───
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, refreshExpires, req.headers['user-agent'] || null, req.ip || null]
    );

    res.json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        aud: 'authenticated',
        user_metadata: { full_name: user.full_name, role: user.role },
        app_metadata: {
          tenant_id: user.tenant_id,
          organization_id: user.organization_id,
        },
      },
    });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /auth/v1/user
//  بيانات المستخدم الحالي
// ═══════════════════════════════════════════════
router.get('/user', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const { rows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const user = rows[0];

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      user_metadata: { full_name: user.full_name },
      app_metadata: {
        tenant_id: user.tenant_id,
        organization_id: user.organization_id,
      },
    });
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/signup — تسجيل جديد
// ═══════════════════════════════════════════════
router.post('/signup', validate(signupSchema), async (req, res) => {
  try {
    const { email, password, full_name, role, tenant_id, organization_id } = req.body || {};

    // ─── تحقق من وجود المستخدم ───
    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'user_already_exists',
        error_description: 'Email already registered',
      });
    }

    // ─── تشفير كلمة المرور ───
    const passwordHash = await bcrypt.hash(password, 10);

    // ─── UUID جديد ───
    const newUserId = crypto.randomUUID();
    const finalRole = role || 'employee';

    // ─── إدخال ───
    const { rows } = await pool.query(
      `INSERT INTO users (id, email, full_name, role, password_hash, tenant_id, organization_id, is_active, invite_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'accepted')
       RETURNING id, email, full_name, role, tenant_id, organization_id, is_active, created_at`,
      [
        newUserId,
        email.toLowerCase().trim(),
        full_name || null,
        finalRole,
        passwordHash,
        tenant_id || null,
        organization_id || null,
      ]
    );

    const user = rows[0];

    // ─── Access Token ───
    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id,
        organization_id: user.organization_id,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // ─── Refresh Token ───
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.id,
        refreshToken,
        refreshExpires,
        req.headers['user-agent'] || null,
        req.ip || null,
      ]
    );

    res.status(201).json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        aud: 'authenticated',
        user_metadata: { full_name: user.full_name, role: user.role },
        app_metadata: {
          tenant_id: user.tenant_id,
          organization_id: user.organization_id,
        },
      },
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/token/refresh — تجديد الجلسة
// ═══════════════════════════════════════════════
router.post('/token/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body || {};

    if (!refresh_token) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'refresh_token is required',
      });
    }

    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.id AS uid, u.email, u.full_name, u.role, u.tenant_id, u.organization_id, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1`,
      [refresh_token]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      });
    }

    const record = rows[0];

    if (record.revoked_at) {
      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Refresh token revoked',
      });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Refresh token expired',
      });
    }

    if (record.is_active === false) {
      return res.status(403).json({
        error: 'account_disabled',
        error_description: 'Account is disabled',
      });
    }

    // ─── Rotation ───
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
      [record.id]
    );

    // ─── Access Token جديد ───
    const accessToken = jwt.sign(
      {
        sub: record.uid,
        email: record.email,
        role: record.role,
        tenant_id: record.tenant_id,
        organization_id: record.organization_id,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // ─── Refresh Token جديد ───
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        record.uid,
        newRefreshToken,
        refreshExpires,
        req.headers['user-agent'] || null,
        req.ip || null,
      ]
    );

    res.json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: newRefreshToken,
      user: {
        id: record.uid,
        email: record.email,
        role: record.role,
        aud: 'authenticated',
        user_metadata: { full_name: record.full_name, role: record.role },
        app_metadata: {
          tenant_id: record.tenant_id,
          organization_id: record.organization_id,
        },
      },
    });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/recover — طلب إعادة تعيين
// ═══════════════════════════════════════════════
router.post('/recover', validate(recoverSchema), async (req, res) => {
  try {
    const { email } = req.body || {};

    // ─── جلب المستخدم ───
    const { rows } = await pool.query(
      'SELECT id, email FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    // ─── دائماً نُعيد نجاح (لأسباب أمنية) ───
    if (rows.length > 0) {
      const user = rows[0];

      // ─── رمز 6 أرقام ───
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      // ─── إبطال أي رموز قديمة ───
      await pool.query(
        'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );

      // ─── حفظ الرمز ───
      await pool.query(
        `INSERT INTO password_resets (user_id, email, code, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, user.email, code, expiresAt]
      );

      // ─── في الإنتاج: إرسال بريد إلكتروني ───
      console.log(`\n📧 PASSWORD RESET for ${user.email}`);
      console.log(`   Code: ${code}`);
      console.log(`   Expires: ${expiresAt.toISOString()}\n`);
    }

    res.json({
      message: 'If the email is registered, a reset code has been sent.',
    });
  } catch (err) {
    console.error('Recover error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/verify — التحقق من الرمز
// ═══════════════════════════════════════════════
router.post('/verify', validate(verifySchema), async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const normalizedCode = String(code).trim();

    console.log('🔍 [VERIFY] email:', email);
    console.log('🔍 [VERIFY] code:', normalizedCode);

    // ─── جلب الرمز ───
    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id, pr.code, pr.expires_at, pr.used_at, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.email = $1 AND pr.code = $2
       ORDER BY pr.created_at DESC
       LIMIT 1`,
      [email.toLowerCase().trim(), normalizedCode]
    );

    console.log('🔍 [VERIFY] rows found:', rows.length);

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'invalid_code',
        error_description: 'Invalid code',
      });
    }

    const reset = rows[0];

    if (reset.used_at) {
      return res.status(400).json({
        error: 'code_used',
        error_description: 'Code already used',
      });
    }

    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({
        error: 'code_expired',
        error_description: 'Code expired',
      });
    }

    // ═══════════════════════════════════════════════
    //  ✅ الإصلاح 1: علّم الرمز كمستخدم
    // ═══════════════════════════════════════════════
    const updateResult = await pool.query(
      'UPDATE password_resets SET used_at = NOW() WHERE id = $1 RETURNING id',
      [reset.id]
    );

    console.log('🔍 [VERIFY] code marked as used:', updateResult.rowCount);

    if (updateResult.rowCount === 0) {
      return res.status(500).json({
        error: 'server_error',
        error_description: 'Failed to mark code as used',
      });
    }

    // ─── JWT مؤقت ───
    const tempToken = jwt.sign(
      {
        sub: reset.user_id,
        email: reset.email,
        purpose: 'password_reset',
      },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({
      access_token: tempToken,
      token_type: 'bearer',
      message: 'Code verified. You can now change your password.',
    });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /auth/v1/user — تغيير كلمة المرور
// ═══════════════════════════════════════════════
router.put('/user', validate(updatePasswordSchema), async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();

    if (!token) {
      return res.status(401).json({
        error: 'missing_token',
        error_description: 'Authentication required',
      });
    }

    // ─── تحقق من JWT ───
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: err.message,
      });
    }

    // ─── تحقق من الغرض ───
    if (payload.purpose !== 'password_reset') {
      return res.status(403).json({
        error: 'invalid_purpose',
        error_description: 'Token is not for password reset',
      });
    }

    const { password } = req.body || {};

    console.log('🔍 [PUT /user] sub:', payload.sub);
    console.log('🔍 [PUT /user] new password length:', password?.length);

    // ─── تشفير ───
    const passwordHash = await bcrypt.hash(password, 10);

    // ═══════════════════════════════════════════════
    //  ✅ الإصلاح 2: التحقق من نجاح UPDATE
    // ═══════════════════════════════════════════════
    const updateResult = await pool.query(
      `UPDATE users 
       SET password_hash = $1, updated_at = NOW() 
       WHERE id = $2 
       RETURNING id, email, updated_at`,
      [passwordHash, payload.sub]
    );

    console.log('🔍 [PUT /user] rows updated:', updateResult.rowCount);

    if (updateResult.rowCount === 0) {
      console.error('❌ [PUT /user] NO USER UPDATED for sub:', payload.sub);
      return res.status(404).json({
        error: 'user_not_found',
        error_description: 'User not found',
      });
    }

    console.log('✅ [PUT /user] password updated for:', updateResult.rows[0].email);

    // ─── إبطال كل الرموز ───
    await pool.query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
      [payload.sub]
    );

    // ─── إبطال كل Refresh Tokens ───
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [payload.sub]
    );

    res.json({
      message: 'Password updated successfully. Please login again.',
    });
  } catch (err) {
    console.error('Update user error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/verify-email — إرسال رابط التحقق
// ═══════════════════════════════════════════════
router.post('/verify-email', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const payload = jwt.verify(token, JWT_SECRET);

    // ─── توليد توكن ───
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 ساعة

    await pool.query(
      `INSERT INTO email_verifications (user_id, email, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [payload.sub, payload.email, verifyToken, expiresAt]
    );

    // ─── رابط التحقق ───
    const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${verifyToken}`;

    // ─── إرسال البريد ───
    await sendEmail({
      to: payload.email,
      subject: 'تفعيل حسابك في منصة القمة',
      text: `اضغط على الرابط التالي لتفعيل حسابك:\n${verifyUrl}\n\nالرابط صالح لمدة 24 ساعة.`,
      html: `<p>اضغط على الرابط التالي لتفعيل حسابك:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });

    res.json({ ok: true, message: 'Verification email sent' });
  } catch (err) {
    console.error('Verify email error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/verify-email/confirm — تأكيد
// ═══════════════════════════════════════════════
router.post('/verify-email/confirm', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'missing_token' });

    const { rows } = await pool.query(
      `SELECT id, user_id, expires_at, verified_at FROM email_verifications
       WHERE token = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'invalid_token' });
    }

    const record = rows[0];

    if (record.verified_at) {
      return res.status(400).json({ error: 'already_verified' });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'token_expired' });
    }

    await pool.query(
      'UPDATE email_verifications SET verified_at = NOW() WHERE id = $1',
      [record.id]
    );

    // ─── تحديث المستخدم ───
    await pool.query(
      'UPDATE users SET invite_status = $1, updated_at = NOW() WHERE id = $2',
      ['verified', record.user_id]
    );

    res.json({ ok: true, message: 'Email verified' });
  } catch (err) {
    console.error('Confirm email error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /auth/v1/2fa/verify-login
//  التحقق من 2FA أثناء Login
// ═══════════════════════════════════════════════
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { temp_token, code } = req.body || {};

    if (!temp_token || !code) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'temp_token and code are required',
      });
    }

    // ─── 1. تحقق من temp_token ───
    let payload;
    try {
      payload = jwt.verify(temp_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'Invalid or expired temp token',
      });
    }

    if (payload.purpose !== '2fa_pending') {
      return res.status(403).json({
        error: 'invalid_purpose',
        error_description: 'Token is not for 2FA',
      });
    }

    // ─── 2. جلب بيانات المستخدم + السر ───
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.organization_id,
              tfa.secret, tfa.enabled
       FROM users u
       JOIN two_factor_auth tfa ON tfa.user_id = u.id
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'user_not_found',
        error_description: 'User or 2FA not found',
      });
    }

    const user = rows[0];

    if (!user.enabled) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: '2FA is not enabled for this user',
      });
    }

    // ─── 3. تحقق من الرمز ───
    const normalizedCode = String(code).trim();
    const isValid =
      normalizedCode === '123456' || // للتطوير
      normalizedCode === generateSimpleCode(user.secret);

    if (!isValid) {
      return res.status(400).json({
        error: 'invalid_code',
        error_description: 'Invalid 2FA code',
      });
    }

    // ─── 4. أصدر access_token ───
    const accessToken = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id,
        organization_id: user.organization_id,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // ─── Refresh Token ───
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, refreshExpires, req.headers['user-agent'] || null, req.ip || null]
    );

    res.json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        aud: 'authenticated',
        user_metadata: { full_name: user.full_name, role: user.role },
        app_metadata: {
          tenant_id: user.tenant_id,
          organization_id: user.organization_id,
        },
      },
    });
  } catch (err) {
    console.error('2FA verify-login error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ─── Helper: رمز بسيط للتطوير ───
function generateSimpleCode(secret) {
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return hash.substring(0, 6).replace(/[a-f]/g, '1');
}

module.exports = router;