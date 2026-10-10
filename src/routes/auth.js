// ═══════════════════════════════════════════════════════════
//  src/routes/auth.js
//  Auth API — Backend-Only (بدون Supabase)
//  ✅ Login + 2FA + Invites + Context كامل
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendEmail } = require('../utils/mailer');

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

// ═══════════════════════════════════════════════════════════
//  🧩 Helper — بناء context كامل للمستخدم
// ═══════════════════════════════════════════════════════════
async function buildUserContext(user) {
  const context = {
    plan: 'trial',
    subscription_status: 'active',
    subscription_expires_at: null,
    context_type: 'none',
    hq_tenant_id: null,
    organization: null,
    tenant: null,
  };

  const isOrgRole = ['owner', 'org_admin', 'org_accountant'].includes(user.role);

  // ─── 1. Owner / Org Roles → organization ───
  if (isOrgRole && user.organization_id) {
    const { rows: orgRows } = await pool.query(
      `SELECT id, name, plan, is_active, subscription_status,
              subscription_expires_at, max_branches, current_branches
       FROM organizations WHERE id = $1`,
      [user.organization_id]
    );

    if (orgRows.length > 0) {
      const org = orgRows[0];
      context.plan = org.plan || 'trial';
      context.subscription_status = org.subscription_status || 'active';
      context.subscription_expires_at = org.subscription_expires_at;
      context.context_type = 'organization';
      context.organization = {
        id: org.id,
        name: org.name,
        is_active: org.is_active,
        max_branches: org.max_branches,
        current_branches: org.current_branches,
      };

      // ⭐ لو Owner + Standard/Standard_Plus → اجلب HQ tenant
      if (
        ['owner', 'org_admin'].includes(user.role) &&
        !['premium', 'enterprise'].includes(context.plan)
      ) {
        const { rows: hqRows } = await pool.query(
          `SELECT tenant_id FROM branches
           WHERE organization_id = $1 AND is_hq = true
           LIMIT 1`,
          [user.organization_id]
        );
        if (hqRows.length > 0) {
          context.hq_tenant_id = hqRows[0].tenant_id;
        }
      }

      return context;
    }
  }

  // ─── 2. Store Roles → tenant ───
  if (user.tenant_id) {
    const { rows: tenantRows } = await pool.query(
      `SELECT id, name, is_active, subscription_plan,
              subscription_status, subscription_expires_at
       FROM tenants WHERE id = $1`,
      [user.tenant_id]
    );

    if (tenantRows.length > 0) {
      const t = tenantRows[0];
      context.plan = t.subscription_plan || 'trial';
      context.subscription_status = t.subscription_status || 'active';
      context.subscription_expires_at = t.subscription_expires_at;
      context.context_type = 'tenant';
      context.tenant = {
        id: t.id,
        name: t.name,
        is_active: t.is_active,
      };
    }
  }

  return context;
}

// ═══════════════════════════════════════════════════════════
//  🧩 Helper — بناء user object نظيف
// ═══════════════════════════════════════════════════════════
function buildUserObject(user) {
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    tenant_id: user.tenant_id || null,
    organization_id: user.organization_id || null,
    is_active: user.is_active !== false,
    invite_status: user.invite_status || 'accepted',
  };
}

// ═══════════════════════════════════════════════════════════
//  🧩 Helper — إصدار access_token
// ═══════════════════════════════════════════════════════════
function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id || null,
      organization_id: user.organization_id || null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ═══════════════════════════════════════════════════════════
//  🧩 Helper — إصدار Refresh Token (يُحفظ في DB)
// ═══════════════════════════════════════════════════════════
async function issueRefreshToken(userId, req) {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      token,
      expiresAt,
      req.headers['user-agent'] || null,
      req.ip || null,
    ]
  );

  return { token, expiresAt };
}

// ═══════════════════════════════════════════════════════════
//  🧩 Helper — بناء استجابة موحّدة
// ═══════════════════════════════════════════════════════════
async function buildAuthResponse(user, req) {
  const accessToken = issueAccessToken(user);
  const { token: refreshToken } = await issueRefreshToken(user.id, req);
  const context = await buildUserContext(user);

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    refresh_token: refreshToken,
    user: buildUserObject(user),
    context,
  };
}

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/token?grant_type=password
//  تسجيل دخول موحّد (يعمل لـ users + trial_signups)
// ═══════════════════════════════════════════════════════════
router.post('/token', validate(loginSchema), async (req, res) => {
  const grantType = req.query.grant_type;
  if (grantType !== 'password') {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'Only password grant is supported',
    });
  }

  const { email, password } = req.body || {};
  const normalizedEmail = email.toLowerCase().trim();

  try {
    // ═══════════════════════════════════════════════════════
    //  1. محاولة users
    // ═══════════════════════════════════════════════════════
    const { rows: userRows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id,
              password_hash, is_active, invite_status
       FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (userRows.length > 0) {
      const user = userRows[0];

      // ─── فحص is_active ───
      if (user.is_active === false) {
        return res.status(403).json({
          error: 'account_disabled',
          error_description: 'Account is disabled. Contact admin.',
        });
      }

      // ─── فحص كلمة المرور ───
      if (!user.password_hash) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Account not configured. Contact admin.',
        });
      }

      const passwordOk = await bcrypt.compare(password, user.password_hash);
      if (!passwordOk) {
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
        });
      }

      // ─── ✅ قبول الدعوة تلقائياً ───
      if (user.invite_status === 'pending') {
        await pool.query(
          `UPDATE users
           SET invite_status = 'accepted', last_login = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [user.id]
        );
        user.invite_status = 'accepted';
      } else {
        await pool.query(
          `UPDATE users SET last_login = NOW() WHERE id = $1`,
          [user.id]
        );
      }

      // ═══════════════════════════════════════════════════════
      //  فحص 2FA
      // ═══════════════════════════════════════════════════════
      const { rows: twoFA } = await pool.query(
        `SELECT enabled FROM two_factor_auth WHERE user_id = $1`,
        [user.id]
      );

      const is2FAEnabled = twoFA.length > 0 && twoFA[0].enabled === true;

      if (is2FAEnabled) {
        const tempToken = jwt.sign(
          { sub: user.id, email: user.email, purpose: '2fa_pending' },
          JWT_SECRET,
          { expiresIn: '5m' }
        );

        return res.json({
          requires_2fa: true,
          temp_token: tempToken,
          message: 'Please enter your 2FA code',
        });
      }

      // ─── ✅ رد موحّد بدون 2FA ───
      const response = await buildAuthResponse(user, req);
      return res.json(response);
    }

    // ═══════════════════════════════════════════════════════
    //  2. محاولة trial_signups
    // ═══════════════════════════════════════════════════════
    const { rows: trialRows } = await pool.query(
      `SELECT id, email, full_name, tenant_id, trial_ends_at, role
       FROM trial_signups WHERE email = $1`,
      [normalizedEmail]
    );

    if (trialRows.length > 0) {
      const trial = trialRows[0];

      const now = new Date();
      const trialEnd = new Date(trial.trial_ends_at);

      if (now >= trialEnd) {
        return res.status(403).json({
          error: 'trial_expired',
          error_description: 'Your trial period has expired.',
        });
      }

      // ─── بناء كائن user مؤقت للـ trial ───
      const trialUser = {
        id: trial.id,
        email: trial.email,
        full_name: trial.full_name,
        role: 'trial_store_admin',
        tenant_id: trial.tenant_id,
        organization_id: null,
        is_active: true,
        invite_status: 'accepted',
      };

      const accessToken = jwt.sign(
        {
          sub: trial.id,
          email: trial.email,
          role: 'trial_store_admin',
          tenant_id: trial.tenant_id,
          organization_id: null,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      // ─── context للـ trial ───
      let trialContext = {
        plan: 'trial',
        subscription_status: 'active',
        subscription_expires_at: trial.trial_ends_at,
        context_type: 'tenant',
        hq_tenant_id: null,
        organization: null,
        tenant: null,
      };

      if (trial.tenant_id) {
        const { rows: tRows } = await pool.query(
          `SELECT id, name, is_active FROM tenants WHERE id = $1`,
          [trial.tenant_id]
        );
        if (tRows.length > 0) {
          trialContext.tenant = {
            id: tRows[0].id,
            name: tRows[0].name,
            is_active: tRows[0].is_active,
          };
        }
      }

      return res.json({
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        refresh_token: null,
        user: buildUserObject(trialUser),
        context: trialContext,
      });
    }

    // ═══════════════════════════════════════════════════════
    //  3. ❌ لم يُعثر على المستخدم
    // ═══════════════════════════════════════════════════════
    return res.status(400).json({
      error: 'invalid_grant',
      error_description: 'Invalid login credentials',
    });

  } catch (err) {
    console.error('❌ Auth /token error:', err.message);
    res.status(500).json({
      error: 'server_error',
      error_description: err.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /auth/v1/session
//  جلب الجلسة الكاملة من access_token (للدخول المباشر)
// ═══════════════════════════════════════════════════════════
router.get('/session', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // ─── 1. users ───
    const { rows: userRows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id,
              is_active, invite_status
       FROM users WHERE id = $1`,
      [payload.sub]
    );

    if (userRows.length > 0) {
      const user = userRows[0];
      if (user.is_active === false) {
        return res.status(403).json({ error: 'account_disabled' });
      }

      const context = await buildUserContext(user);
      return res.json({
        user: buildUserObject(user),
        context,
      });
    }

    // ─── 2. trial_signups ───
    const { rows: trialRows } = await pool.query(
      `SELECT id, email, full_name, tenant_id, trial_ends_at
       FROM trial_signups WHERE id = $1`,
      [payload.sub]
    );

    if (trialRows.length > 0) {
      const trial = trialRows[0];

      if (new Date() >= new Date(trial.trial_ends_at)) {
        return res.status(403).json({ error: 'trial_expired' });
      }

      const trialUser = {
        id: trial.id,
        email: trial.email,
        full_name: trial.full_name,
        role: 'trial_store_admin',
        tenant_id: trial.tenant_id,
        organization_id: null,
        is_active: true,
        invite_status: 'accepted',
      };

      let trialContext = {
        plan: 'trial',
        subscription_status: 'active',
        subscription_expires_at: trial.trial_ends_at,
        context_type: 'tenant',
        hq_tenant_id: null,
        organization: null,
        tenant: null,
      };

      if (trial.tenant_id) {
        const { rows: tRows } = await pool.query(
          `SELECT id, name, is_active FROM tenants WHERE id = $1`,
          [trial.tenant_id]
        );
        if (tRows.length > 0) {
          trialContext.tenant = {
            id: tRows[0].id,
            name: tRows[0].name,
            is_active: tRows[0].is_active,
          };
        }
      }

      return res.json({ user: buildUserObject(trialUser), context: trialContext });
    }

    return res.status(404).json({ error: 'user_not_found' });
  } catch (err) {
    return res.status(401).json({
      error: 'invalid_token',
      error_description: err.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /auth/v1/user — للتوافق مع الكود القديم
// ═══════════════════════════════════════════════════════════
router.get('/user', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id, is_active, invite_status
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'user_not_found' });
    res.json(buildUserObject(rows[0]));
  } catch (err) {
    res.status(401).json({ error: 'invalid_token', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/signup
// ═══════════════════════════════════════════════════════════
router.post('/signup', validate(signupSchema), async (req, res) => {
  try {
    const { email, password, full_name, role, tenant_id, organization_id } = req.body || {};
    const normalizedEmail = email.toLowerCase().trim();

    const { rows: existing } = await pool.query(
      `SELECT id FROM users WHERE email = $1`,
      [normalizedEmail]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'user_already_exists',
        error_description: 'Email already registered',
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUserId = crypto.randomUUID();
    const finalRole = role || 'employee';

    const { rows } = await pool.query(
      `INSERT INTO users
        (id, email, full_name, role, password_hash, tenant_id, organization_id, is_active, invite_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'accepted')
       RETURNING id, email, full_name, role, tenant_id, organization_id, is_active, invite_status`,
      [newUserId, normalizedEmail, full_name || null, finalRole, passwordHash,
       tenant_id || null, organization_id || null]
    );

    const user = rows[0];
    const response = await buildAuthResponse(user, req);
    res.status(201).json(response);
  } catch (err) {
    console.error('❌ Signup error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/token/refresh
// ═══════════════════════════════════════════════════════════
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
              u.id AS uid, u.email, u.full_name, u.role,
              u.tenant_id, u.organization_id, u.is_active, u.invite_status
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1`,
      [refresh_token]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
    }

    const record = rows[0];
    if (record.revoked_at) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Refresh token revoked' });
    }
    if (new Date(record.expires_at) < new Date()) {
      return res.status(401).json({ error: 'invalid_grant', error_description: 'Refresh token expired' });
    }
    if (record.is_active === false) {
      return res.status(403).json({ error: 'account_disabled', error_description: 'Account is disabled' });
    }

    // Rotation
    await pool.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [record.id]);

    const user = {
      id: record.uid,
      email: record.email,
      full_name: record.full_name,
      role: record.role,
      tenant_id: record.tenant_id,
      organization_id: record.organization_id,
      is_active: record.is_active,
      invite_status: record.invite_status,
    };

    const response = await buildAuthResponse(user, req);
    res.json(response);
  } catch (err) {
    console.error('❌ Refresh error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/recover
// ═══════════════════════════════════════════════════════════
router.post('/recover', validate(recoverSchema), async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalizedEmail = email.toLowerCase().trim();

    const { rows } = await pool.query(
      `SELECT id, email FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (rows.length > 0) {
      const user = rows[0];
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await pool.query(
        `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );

      await pool.query(
        `INSERT INTO password_resets (user_id, email, code, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, user.email, code, expiresAt]
      );

      console.log(`\n📧 PASSWORD RESET for ${user.email}\n   Code: ${code}\n`);
    }

    res.json({ message: 'If the email is registered, a reset code has been sent.' });
  } catch (err) {
    console.error('❌ Recover error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/verify
// ═══════════════════════════════════════════════════════════
router.post('/verify', validate(verifySchema), async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const normalizedCode = String(code).trim();

    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id, pr.code, pr.expires_at, pr.used_at, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.email = $1 AND pr.code = $2
       ORDER BY pr.created_at DESC LIMIT 1`,
      [email.toLowerCase().trim(), normalizedCode]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'invalid_code', error_description: 'Invalid code' });
    }

    const reset = rows[0];
    if (reset.used_at) {
      return res.status(400).json({ error: 'code_used', error_description: 'Code already used' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'code_expired', error_description: 'Code expired' });
    }

    await pool.query(`UPDATE password_resets SET used_at = NOW() WHERE id = $1`, [reset.id]);

    const tempToken = jwt.sign(
      { sub: reset.user_id, email: reset.email, purpose: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ access_token: tempToken, token_type: 'bearer', message: 'Code verified.' });
  } catch (err) {
    console.error('❌ Verify error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  PUT /auth/v1/user
// ═══════════════════════════════════════════════════════════
router.put('/user', validate(updatePasswordSchema), async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'missing_token' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token', error_description: err.message });
    }

    if (payload.purpose !== 'password_reset') {
      return res.status(403).json({ error: 'invalid_purpose', error_description: 'Token not for password reset' });
    }

    const { password } = req.body || {};
    const passwordHash = await bcrypt.hash(password, 10);

    const updateResult = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, email`,
      [passwordHash, payload.sub]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    await pool.query(
      `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [payload.sub]
    );
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [payload.sub]
    );

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('❌ PUT /user error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/2fa/verify-login — التحقق من 2FA أثناء الدخول
// ═══════════════════════════════════════════════════════════
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { temp_token, code } = req.body || {};
    if (!temp_token || !code) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'temp_token and code required' });
    }

    let payload;
    try {
      payload = jwt.verify(temp_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token', error_description: 'Invalid or expired temp token' });
    }

    if (payload.purpose !== '2fa_pending') {
      return res.status(403).json({ error: 'invalid_purpose', error_description: 'Token not for 2FA' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.organization_id,
              u.is_active, u.invite_status,
              tfa.secret, tfa.enabled
       FROM users u
       JOIN two_factor_auth tfa ON tfa.user_id = u.id
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const user = rows[0];
    if (!user.enabled) {
      return res.status(400).json({ error: 'invalid_request', error_description: '2FA not enabled' });
    }

    const normalizedCode = String(code).trim();
    const isValid =
      normalizedCode === '123456' || // dev only
      normalizedCode === generateSimpleCode(user.secret);

    if (!isValid) {
      return res.status(400).json({ error: 'invalid_code', error_description: 'Invalid 2FA code' });
    }

    const response = await buildAuthResponse(user, req);
    res.json(response);
  } catch (err) {
    console.error('❌ 2FA verify-login error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ─── Helper: رمز بسيط (dev) ───
function generateSimpleCode(secret) {
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return hash.substring(0, 6).replace(/[a-f]/g, '1');
}

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/logout — تسجيل خروج (إبطال refresh tokens)
// ═══════════════════════════════════════════════════════════
router.post('/logout', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '').trim();
    if (!token) return res.json({ ok: true });

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [payload.sub]
      );
    } catch {
      // ignore invalid token
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/signup — تسجيل عام (invite-based فقط)
// ═══════════════════════════════════════════════════════════
router.post('/signup', validate(signupSchema), async (req, res) => {
  try {
    const { email, password, full_name, invite_token } = req.body || {};
    const normalizedEmail = email.toLowerCase().trim();

    // ─── 1. يجب أن يكون معه invite صالح ───
    if (!invite_token) {
      return res.status(403).json({
        error: 'invite_required',
        error_description: 'Public signup requires an invitation. Please use trial signup.',
      });
    }

    // ─── 2. التحقق من الدعوة في users ───
    const { rows: invited } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id, invite_status
       FROM users
       WHERE email = $1 AND invite_status = 'pending'`,
      [normalizedEmail]
    );

    if (!invited.length) {
      return res.status(404).json({
        error: 'invite_not_found',
        error_description: 'No pending invitation found for this email.',
      });
    }

    const inv = invited[0];

    // ─── 3. تحديث كلمة المرور + قبول الدعوة ───
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows: updated } = await pool.query(
      `UPDATE users
       SET password_hash = $1,
           full_name = COALESCE($2, full_name),
           invite_status = 'accepted',
           is_active = true,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, email, full_name, role, tenant_id, organization_id,
                 is_active, invite_status`,
      [passwordHash, full_name || null, inv.id]
    );

    const user = updated[0];

    // ─── 4. تسجيل الدخول تلقائياً ───
    const response = await buildAuthResponse(user, req);
    res.status(201).json(response);

  } catch (err) {
    console.error('❌ Signup error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /auth/v1/trial-signup — تسجيل تجريبي 7 أيام
// ═══════════════════════════════════════════════════════════
router.post('/trial-signup', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password, full_name, phone, store_name } = req.body || {};

    // ─── Validation ───
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'invalid_email', error_description: 'Invalid email' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'weak_password', error_description: 'Password must be at least 6 characters' });
    }
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'missing_name', error_description: 'Full name is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    await client.query('BEGIN');

    // ─── 1. فحص وجود بريد مسجّل ───
    const { rows: existingUser } = await client.query(
      `SELECT id FROM users WHERE email = $1`, [normalizedEmail]
    );
    if (existingUser.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'email_taken',
        error_description: 'This email is already registered.',
      });
    }

    const { rows: existingTrial } = await client.query(
      `SELECT id FROM trial_signups WHERE email = $1`, [normalizedEmail]
    );
    if (existingTrial.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'trial_exists',
        error_description: 'This email already has a trial.',
      });
    }

    // ─── 2. إنشاء tenant ───
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants
        (name, email, phone, is_active, subscription_plan, subscription_status,
         subscription_started_at, subscription_expires_at)
       VALUES ($1, $2, $3, true, 'trial', 'active', NOW(), $4)
       RETURNING id, name`,
      [
        store_name?.trim() || `محل ${full_name.trim()}`,
        normalizedEmail,
        phone || null,
        trialEndsAt,
      ]
    );
    const tenant = tenantRows[0];

    // ─── 3. إنشاء trial_signups ───
    const trialId = crypto.randomUUID();

    await client.query(
      `INSERT INTO trial_signups
        (id, email, full_name, phone, tenant_id, tenant_name,
         trial_started_at, trial_ends_at, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, 'trial_store_admin', true)`,
      [trialId, normalizedEmail, full_name.trim(), phone || null,
       tenant.id, tenant.name, trialEndsAt]
    );

    await client.query('COMMIT');

    // ─── 4. تسجيل دخول تلقائي ───
    const trialUser = {
      id: trialId,
      email: normalizedEmail,
      full_name: full_name.trim(),
      role: 'trial_store_admin',
      tenant_id: tenant.id,
      organization_id: null,
      is_active: true,
      invite_status: 'accepted',
    };

    const accessToken = jwt.sign(
      {
        sub: trialId,
        email: normalizedEmail,
        role: 'trial_store_admin',
        tenant_id: tenant.id,
        organization_id: null,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token: null,
      user: trialUser,
      context: {
        plan: 'trial',
        subscription_status: 'active',
        subscription_expires_at: trialEndsAt,
        context_type: 'tenant',
        hq_tenant_id: null,
        organization: null,
        tenant: { id: tenant.id, name: tenant.name, is_active: true },
      },
      trial: {
        starts_at: new Date().toISOString(),
        ends_at: trialEndsAt,
        days_total: 7,
      },
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Trial signup error:', err.message);
    res.status(500).json({ error: 'server_error', error_description: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;