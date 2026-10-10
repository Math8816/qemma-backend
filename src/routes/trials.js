// ═══════════════════════════════════════════════
//  src/routes/trials.js
//  إدارة المستخدمين التجريبيين — 4 endpoints
// ═══════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

const ALLOWED_PLANS = ['standard', 'premium', 'enterprise'];

function requireRole(user, roles) {
  if (!user?.sub) return { ok: false, code: 401, error: 'Authentication required' };
  if (!roles.includes(user.role)) return { ok: false, code: 403, error: 'Access denied' };
  return { ok: true };
}

// ═══════════════════════════════════════════════
//  POST /api/trials/convert
//  تحويل trial → عميل دائم
// ═══════════════════════════════════════════════
router.post('/convert', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const check = requireRole(req.user, ['developer', 'org_admin']);
    if (!check.ok) {
      client.release();
      return res.status(check.code).json({ ok: false, error: check.error });
    }

    const { email, subscriptionPlan = 'standard' } = req.body;

    if (!email) {
      client.release();
      return res.status(400).json({ ok: false, error: 'email is required' });
    }
    if (!ALLOWED_PLANS.includes(subscriptionPlan)) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: `Invalid plan. Allowed: ${ALLOWED_PLANS.join(', ')}`,
      });
    }

    await client.query('BEGIN');

    // ─── 1. جلب trial_signup ───
    const trialRes = await client.query(
      `SELECT * FROM trial_signups WHERE email = $1 LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    if (trialRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        error: 'لم يتم العثور على المستخدم التجريبي',
      });
    }

    const trialUser = trialRes.rows[0];

    // ─── 2. تحقق من عدم وجود المستخدم في users ───
    const existingRes = await client.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [trialUser.email]
    );

    let userId;

    if (existingRes.rows.length > 0) {
      // موجود بالفعل
      userId = existingRes.rows[0].id;
      console.warn('⚠️ المستخدم موجود بالفعل في users');
    } else {
      // ─── 3. إنشاء مستخدم جديد ───
      userId = trialUser.id || crypto.randomUUID();
      const passwordHash = await bcrypt.hash('Trial123!', 10);

      await client.query(
        `INSERT INTO users
          (id, email, full_name, role, password_hash, tenant_id,
           is_active, invite_status)
         VALUES ($1, $2, $3, 'store_admin', $4, $5, true, 'accepted')`,
        [
          userId,
          trialUser.email,
          trialUser.full_name || null,
          passwordHash,
          trialUser.tenant_id || null,
        ]
      );
    }

    // ─── 4. تحديث المحل بالخطة ───
    if (trialUser.tenant_id) {
      const now = new Date();
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      await client.query(
        `UPDATE tenants
         SET subscription_plan = $1,
             subscription_status = 'active',
             subscription_started_at = $2,
             subscription_expires_at = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [subscriptionPlan, now, expiresAt, trialUser.tenant_id]
      );
    }

    // ─── 5. حذف من trial_signups ───
    await client.query(`DELETE FROM trial_signups WHERE email = $1`, [
      trialUser.email,
    ]);

    await client.query('COMMIT');

    await req.audit({
      action: 'convert-trial',
      tableName: 'trial_signups',
      recordId: userId,
      newData: { email: trialUser.email, plan: subscriptionPlan },
    });

    res.json({
      ok: true,
      success: true,
      message: '✅ تم تحويل المستخدم التجريبي إلى عميل دائم',
      userId,
      email: trialUser.email,
      tenantId: trialUser.tenant_id,
      plan: subscriptionPlan,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/trials/convert error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  POST /api/trials/extend
//  تمديد فترة التجربة
// ═══════════════════════════════════════════════
router.post('/extend', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { email, days = 7 } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: 'email is required' });
    }
    const numDays = Math.max(1, Math.min(parseInt(days) || 7, 365));

    // حساب النهاية الجديدة — نستخدم GREATEST مع القيمة الحالية
    const newEnd = new Date();
    newEnd.setDate(newEnd.getDate() + numDays);

    const result = await pool.query(
      `UPDATE trial_signups
       SET trial_ends_at = GREATEST(
         COALESCE(trial_ends_at, NOW()),
         $1::timestamptz
       )
       WHERE email = $2
       RETURNING id, email, trial_ends_at`,
      [newEnd, email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Trial user not found' });
    }

    await req.audit({
      action: 'extend-trial',
      tableName: 'trial_signups',
      recordId: result.rows[0].id,
      newData: { email, days: numDays, newEnd },
    });

    res.json({
      ok: true,
      success: true,
      message: `✅ تم تمديد التجربة بمقدار ${numDays} يوم`,
      trial_ends_at: result.rows[0].trial_ends_at,
    });
  } catch (err) {
    console.error('POST /api/trials/extend error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/trials — قائمة المستخدمين التجريبيين
// ═══════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { status } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT * FROM trial_signups ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );

    res.json({ ok: true, count: result.rows.length, data: result.rows });
  } catch (err) {
    console.error('GET /api/trials error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/trials/:email
//  جلب مستخدم تجريبي واحد
// ═══════════════════════════════════════════════
router.get('/:email', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const result = await pool.query(
      `SELECT * FROM trial_signups WHERE email = $1 LIMIT 1`,
      [req.params.email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Trial not found' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /api/trials/:email error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;