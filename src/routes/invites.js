// ═══════════════════════════════════════════════════════════
//  src/routes/invites.js
//  إدارة الدعوات — 4 endpoints
// ═══════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { sendEmail } = require('../utils/mailer');

const router = express.Router();
router.use(auditMiddleware);

const ALLOWED_ROLES = [
  'owner', 'org_admin', 'store_admin', 'store_manager',
  'employee', 'accountant', 'inventory_manager', 'trial_store_manager',
];

function requireRole(user, roles) {
  if (!user?.sub) return { ok: false, code: 401, error: 'Authentication required' };
  if (!roles.includes(user.role)) return { ok: false, code: 403, error: 'Access denied' };
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
//  📧 Helper — بناء HTML الدعوة
// ═══════════════════════════════════════════════════════════
function buildInviteHtml({ name, email, role, contextName, tempPassword, loginUrl }) {
  const roleLabel = {
    owner: 'صاحب السلسلة',
    org_admin: 'مدير عام',
    org_accountant: 'محاسب السلسلة',
    store_admin: 'مدير محل',
    store_manager: 'مدير تنفيذي',
    employee: 'موظف',
    accountant: 'محاسب',
    inventory_manager: 'مدير مخزون',
    trial_store_manager: 'مدير تجريبي',
  }[role] || role;

  return `
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: 'Cairo', Arial, sans-serif; background: #f4f7fc; margin: 0; padding: 0; direction: rtl; }
        .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
        .header { background: linear-gradient(135deg, #1a5276, #1a8cff); color: #fff; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 26px; }
        .header p { margin: 8px 0 0; opacity: 0.85; }
        .content { padding: 30px; color: #333; }
        .content h2 { color: #1a5276; margin-top: 0; }
        .button { display: inline-block; background: #1a8cff; color: #fff !important; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600; margin: 20px 0; }
        .info-box { background: #f0f7ff; border-right: 4px solid #1a8cff; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
        .info-box strong { color: #1a5276; }
        .footer { text-align: center; padding: 20px; background: #f8f9fa; color: #999; font-size: 13px; border-top: 1px solid #eee; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🏢 منصة القمة</h1>
          <p>نظام إدارة المحلات المتكامل</p>
        </div>
        <div class="content">
          <h2>مرحباً ${name || email}،</h2>
          <p>تمت دعوتك للانضمام إلى <strong>${contextName}</strong> كـ <strong>${roleLabel}</strong>.</p>
          <p>لتفعيل حسابك، اضغط على الزر أدناه:</p>
          <div style="text-align: center;">
            <a href="${loginUrl}" class="button">🔑 تسجيل الدخول</a>
          </div>
          <div class="info-box">
            <strong>📋 معلومات الدخول:</strong><br />
            البريد الإلكتروني: <strong>${email}</strong><br />
            كلمة المرور المؤقتة: <strong>${tempPassword}</strong>
          </div>
          <p style="font-size: 13px; color: #666;">
            💡 نوصي بتغيير كلمة المرور فور تسجيل الدخول عبر صفحة "نسيت كلمة المرور".
          </p>
          <p style="font-size: 12px; color: #999;">
            إذا لم تكن تتوقع هذه الدعوة، يمكنك تجاهل هذا البريد الإلكتروني.
          </p>
        </div>
        <div class="footer">
          © 2026 منصة القمة — جميع الحقوق محفوظة
        </div>
      </div>
    </body>
    </html>
  `;
}

// ═══════════════════════════════════════════════════════════
//  POST /api/invites — إنشاء دعوة
// ═══════════════════════════════════════════════════════════
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
      [userId, normalizedEmail, fullName || null, role, passwordHash,
       tenantId, organizationId, now, expiresAt]
    );

    // ─── ربط Owner بـ Organization ───
    if (role === 'owner' && organizationId) {
      await pool.query(
        `UPDATE organizations SET owner_id = $1, updated_at = NOW() WHERE id = $2`,
        [userId, organizationId]
      );
    }

    // ═══════════════════════════════════════════════════════
    //  📧 إرسال البريد الإلكتروني
    // ═══════════════════════════════════════════════════════
    let contextName = 'منصة القمة';
    try {
      if (organizationId) {
        const orgRes = await pool.query(
          'SELECT name FROM organizations WHERE id = $1',
          [organizationId]
        );
        if (orgRes.rows.length > 0) contextName = orgRes.rows[0].name;
      } else if (tenantId) {
        const tenRes = await pool.query(
          'SELECT name FROM tenants WHERE id = $1',
          [tenantId]
        );
        if (tenRes.rows.length > 0) contextName = tenRes.rows[0].name;
      }
    } catch (e) {
      console.warn('⚠️ Failed to get context name:', e.message);
    }

    const loginUrl = `${process.env.FRONTEND_URL || 'https://qc-services.vercel.app'}/login`;

    try {
      const html = buildInviteHtml({
        name: fullName,
        email: normalizedEmail,
        role,
        contextName,
        tempPassword,
        loginUrl,
      });

      await sendEmail({
        to: normalizedEmail,
        subject: `📧 دعوة للانضمام إلى ${contextName} — منصة القمة`,
        html,
        text: `مرحباً ${fullName || normalizedEmail}،

تمت دعوتك للانضمام إلى ${contextName}.

رابط الدخول: ${loginUrl}
البريد: ${normalizedEmail}
كلمة المرور المؤقتة: ${tempPassword}`,
      });

      console.log(`📧 Invitation email sent to ${normalizedEmail}`);
    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError.message);
      // ─── لا نُفشل العملية ───
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