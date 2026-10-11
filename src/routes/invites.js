// ═══════════════════════════════════════════════════════════
//  src/routes/invites.js
//  إدارة الدعوات — نظام صلاحيات هرمي
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

// ═══════════════════════════════════════════════════════════
//  🎯 مصفوفة الدعوات الهرمية
//  مَن يستطيع دعوة مَن؟
// ═══════════════════════════════════════════════════════════
const INVITE_PERMISSIONS = {
  // ─── Developer ───
  developer: [
    'owner',
    'dev_assistant',
    'support',
    'auditor',
    'store_admin',
  ],

  // ─── Platform Team (لا يدعو أحداً) ───
  dev_assistant: [],
  support: [],
  auditor: [],

  // ─── Owner ───
  owner: [
    'org_admin',
    'org_accountant',
    'store_admin',
  ],

  // ─── Org Roles (لا يدعو أحداً) ───
  org_admin: [],
  org_accountant: [],

  // ─── Store Admin ───
  store_admin: [
    'store_manager',
    'employee',
    'accountant',
    'inventory_manager',
  ],

  // ─── باقي الأدوار (لا يدعو أحداً) ───
  store_manager: [],
  employee: [],
  accountant: [],
  inventory_manager: [],
  trial_store_admin: [],
};

// ═══════════════════════════════════════════════════════════
//  🎯 الأدوار التي تحتاج organization_id
// ═══════════════════════════════════════════════════════════
const ORG_SCOPED_ROLES = ['owner', 'org_admin', 'org_accountant'];

// ═══════════════════════════════════════════════════════════
//  🎯 فحص صلاحية الدعوة
// ═══════════════════════════════════════════════════════════
function canInvite(inviterRole, targetRole) {
  const allowed = INVITE_PERMISSIONS[inviterRole] || [];
  return allowed.includes(targetRole);
}

function requireInvitePermission(user, targetRole) {
  if (!user?.sub) {
    return {
      ok: false,
      code: 401,
      error: 'Authentication required',
    };
  }

  if (!canInvite(user.role, targetRole)) {
    return {
      ok: false,
      code: 403,
      error: 'Access denied',
      error_description: `دورك (${user.role}) لا يملك صلاحية دعوة (${targetRole})`,
    };
  }

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
//  🎯 التحقق من السياق (organization / tenant)
// ═══════════════════════════════════════════════════════════
async function validateContext(inviter, targetRole, organizationId, tenantId) {
  const inviterRole = inviter.role;
  const inviterOrgId = inviter.organization_id;
  const inviterTenantId = inviter.tenant_id;

  // ═══ 1. Developer → لا قيود على السياق ═══
  if (inviterRole === 'developer') {
    return {
      ok: true,
      finalOrgId: organizationId || null,
      finalTenantId: tenantId || null,
    };
  }

  // ═══ 2. Platform Team → لا يدعو (مرفوض مبكراً) ═══
  if (['dev_assistant', 'support', 'auditor'].includes(inviterRole)) {
    return {
      ok: false,
      code: 403,
      error: 'Access denied',
    };
  }

  // ═══ 3. Owner → يدعو org_admin, org_accountant, store_admin ═══
  if (inviterRole === 'owner') {
    if (!inviterOrgId) {
      return {
        ok: false,
        code: 400,
        error: 'Missing organization_id in token',
      };
    }

    // دعوة org_admin أو org_accountant → organizationId إجباري من JWT
    if (['org_admin', 'org_accountant'].includes(targetRole)) {
      return {
        ok: true,
        finalOrgId: inviterOrgId,
        finalTenantId: null,
      };
    }

    // دعوة store_admin → tenantId مطلوب + ينتمي لسلسته
    if (targetRole === 'store_admin') {
      if (!tenantId) {
        return {
          ok: false,
          code: 400,
          error: 'tenantId required for store_admin invitation',
        };
      }

      const { rows } = await pool.query(
        `SELECT id FROM branches
         WHERE tenant_id = $1 AND organization_id = $2`,
        [tenantId, inviterOrgId]
      );

      if (rows.length === 0) {
        return {
          ok: false,
          code: 403,
          error: 'Access denied',
          error_description: 'الفرع لا ينتمي إلى سلستك',
        };
      }

      return {
        ok: true,
        finalOrgId: inviterOrgId,
        finalTenantId: tenantId,
      };
    }

    return {
      ok: false,
      code: 403,
      error: 'Access denied',
    };
  }

  // ═══ 4. Store Admin → يدعو موظفي فرعه (tenant من JWT إجباري) ═══
  if (inviterRole === 'store_admin') {
    if (!inviterTenantId) {
      return {
        ok: false,
        code: 400,
        error: 'Missing tenant_id in token',
      };
    }

    return {
      ok: true,
      finalOrgId: inviter.organization_id || null,
      finalTenantId: inviterTenantId,
    };
  }

  // ═══ 5. أي دور آخر → ممنوع ═══
  return {
    ok: false,
    code: 403,
    error: 'Access denied',
  };
}

// ═══════════════════════════════════════════════════════════
//  📧 Helper — بناء HTML الدعوة
// ═══════════════════════════════════════════════════════════
function buildInviteHtml({ name, email, role, contextName, tempPassword, loginUrl }) {
  const roleLabel = {
    developer: 'مطور',
    dev_assistant: 'مساعد المطور',
    support: 'دعم فني',
    auditor: 'مراقب',

    owner: 'صاحب السلسلة',
    org_admin: 'مدير عام',
    org_accountant: 'محاسب السلسلة',

    store_admin: 'مدير محل',
    store_manager: 'مدير تنفيذي',
    employee: 'موظف',
    accountant: 'محاسب',
    inventory_manager: 'مدير مخزون',

    trial_store_admin: 'مدير تجريبي',
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
            💡 نوصي بتغيير كلمة المرور فور تسجيل الدخول.
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
//  POST /api/invites — إنشاء دعوة (مع صلاحيات هرمية)
// ═══════════════════════════════════════════════════════════
router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      email,
      fullName,
      role: targetRole,
      tenantId = null,
      organizationId = null,
      tempPassword = 'TempPass123!',
    } = req.body;

    // ═══ 1. Validation المدخلات ═══
    if (!email) {
      return res.status(400).json({ ok: false, error: 'email required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email format' });
    }

    if (!targetRole || typeof targetRole !== 'string' || targetRole.trim() === '') {
      return res.status(400).json({ ok: false, error: 'role required' });
    }

    // ═══ 2. فحص صلاحية الدعوة ═══
    const permCheck = requireInvitePermission(req.user, targetRole);
    if (!permCheck.ok) {
      return res.status(permCheck.code).json({
        ok: false,
        error: permCheck.error,
        ...(permCheck.error_description && {
          error_description: permCheck.error_description,
        }),
      });
    }

    // ═══ 3. فحص السياق (organization / tenant) ═══
    const ctxCheck = await validateContext(
      req.user,
      targetRole,
      organizationId,
      tenantId
    );

    if (!ctxCheck.ok) {
      return res.status(ctxCheck.code).json({
        ok: false,
        error: ctxCheck.error,
        ...(ctxCheck.error_description && {
          error_description: ctxCheck.error_description,
        }),
      });
    }

    const { finalOrgId, finalTenantId } = ctxCheck;
    const normalizedEmail = email.toLowerCase().trim();

    // ═══ 4. فحص المستخدم الموجود ═══
    const existingRes = await pool.query(
      `SELECT id, invite_status FROM users WHERE email = $1`,
      [normalizedEmail]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      if (existing.invite_status === 'pending') {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await pool.query(
          `UPDATE users SET invite_sent_at = NOW(), invite_expires_at = $1 WHERE id = $2`,
          [expiresAt, existing.id]
        );
        return res.json({
          ok: true,
          success: true,
          userId: existing.id,
          resent: true,
        });
      }
      return res.status(409).json({
        ok: false,
        error: 'هذا البريد الإلكتروني مستخدم بالفعل',
      });
    }

    // ═══ 5. إنشاء المستخدم ═══
    const userId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await pool.query(
      `INSERT INTO users
        (id, email, full_name, role, password_hash, tenant_id, organization_id,
         is_active, invite_status, invite_sent_at, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'pending', NOW(), $8)`,
      [
        userId,
        normalizedEmail,
        fullName || null,
        targetRole,
        passwordHash,
        finalTenantId,
        finalOrgId,
        expiresAt,
      ]
    );

    // ═══ 6. ربط Owner بـ Organization ═══
    if (targetRole === 'owner' && finalOrgId) {
      await pool.query(
        `UPDATE organizations SET owner_id = $1, updated_at = NOW() WHERE id = $2`,
        [userId, finalOrgId]
      );
    }

    // ═══ 7. جلب اسم السياق (للإيميل) ═══
    let contextName = 'منصة القمة';
    try {
      if (finalOrgId) {
        const orgRes = await pool.query(
          'SELECT name FROM organizations WHERE id = $1',
          [finalOrgId]
        );
        if (orgRes.rows.length > 0) contextName = orgRes.rows[0].name;
      } else if (finalTenantId) {
        const tenRes = await pool.query(
          'SELECT name FROM tenants WHERE id = $1',
          [finalTenantId]
        );
        if (tenRes.rows.length > 0) contextName = tenRes.rows[0].name;
      }
    } catch (e) {
      console.warn('⚠️ Failed to get context name:', e.message);
    }

    // ═══ 8. إرسال الإيميل ═══
    const loginUrl = `${process.env.FRONTEND_URL || 'https://qc-services.vercel.app'}/login`;

    try {
      const html = buildInviteHtml({
        name: fullName,
        email: normalizedEmail,
        role: targetRole,
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

      console.log(`📧 Invitation sent to ${normalizedEmail}`);
    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError.message);
    }

    // ═══ 9. Audit ═══
    await req.audit({
      action: 'invite',
      tableName: 'users',
      recordId: userId,
      newData: {
        email: normalizedEmail,
        role: targetRole,
        organizationId: finalOrgId,
        tenantId: finalTenantId,
        invitedBy: req.user.sub,
      },
    });

    res.status(201).json({
      ok: true,
      success: true,
      userId,
      email: normalizedEmail,
      role: targetRole,
      organizationId: finalOrgId,
      tenantId: finalTenantId,
    });
  } catch (err) {
    console.error('POST /api/invites error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/invites/:userId/accept
// ═══════════════════════════════════════════════════════════
router.post('/:userId/accept', optionalAuth, async (req, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

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

// ═══════════════════════════════════════════════════════════
//  POST /api/invites/:userId/resend — إعادة إرسال الدعوة
// ═══════════════════════════════════════════════════════════
router.post('/:userId/resend', optionalAuth, async (req, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { rows } = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id, invite_status
       FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const targetUser = rows[0];

    if (targetUser.invite_status !== 'pending') {
      return res.status(409).json({
        ok: false,
        error: 'INVITE_NOT_PENDING',
      });
    }

    // فحص الصلاحية
    const permCheck = requireInvitePermission(req.user, targetUser.role);
    if (!permCheck.ok) {
      return res.status(permCheck.code).json({
        ok: false,
        error: permCheck.error,
        ...(permCheck.error_description && {
          error_description: permCheck.error_description,
        }),
      });
    }

    // كلمة مرور جديدة + تجديد التاريخ
    const newTempPassword =
      'TempPass' + Math.floor(1000 + Math.random() * 9000) + '!';
    const hash = await bcrypt.hash(newTempPassword, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users
       SET password_hash = $1, invite_sent_at = NOW(), invite_expires_at = $2
       WHERE id = $3`,
      [hash, expiresAt, req.params.userId]
    );

    // جلب اسم السياق
    let contextName = 'منصة القمة';
    try {
      if (targetUser.organization_id) {
        const r = await pool.query(
          'SELECT name FROM organizations WHERE id = $1',
          [targetUser.organization_id]
        );
        if (r.rows.length > 0) contextName = r.rows[0].name;
      } else if (targetUser.tenant_id) {
        const r = await pool.query(
          'SELECT name FROM tenants WHERE id = $1',
          [targetUser.tenant_id]
        );
        if (r.rows.length > 0) contextName = r.rows[0].name;
      }
    } catch (e) {}

    const loginUrl = `${process.env.FRONTEND_URL || 'https://qc-services.vercel.app'}/login`;
    const html = buildInviteHtml({
      name: targetUser.full_name,
      email: targetUser.email,
      role: targetUser.role,
      contextName,
      tempPassword: newTempPassword,
      loginUrl,
    });

    try {
      await sendEmail({
        to: targetUser.email,
        subject: `📧 إعادة إرسال: دعوة للانضمام إلى ${contextName}`,
        html,
      });
      console.log(`📧 Resend invitation to ${targetUser.email}`);
    } catch (e) {
      console.error('❌ Resend email failed:', e.message);
    }

    await req.audit({
      action: 'resend-invite',
      tableName: 'users',
      recordId: targetUser.id,
      newData: { email: targetUser.email },
    });

    res.json({
      ok: true,
      success: true,
      user: {
        id: targetUser.id,
        email: targetUser.email,
        fullName: targetUser.full_name,
      },
    });
  } catch (err) {
    console.error('POST /api/invites/:id/resend error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  DELETE /api/invites/:userId
// ═══════════════════════════════════════════════════════════
router.delete('/:userId', optionalAuth, async (req, res) => {
  try {
    if (!req.user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const userRes = await pool.query(
      `SELECT id, email, role, organization_id, tenant_id FROM users WHERE id = $1`,
      [req.params.userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const targetUser = userRes.rows[0];

    // فحص الصلاحية
    const permCheck = requireInvitePermission(req.user, targetUser.role);
    if (!permCheck.ok) {
      return res.status(permCheck.code).json({
        ok: false,
        error: permCheck.error,
        ...(permCheck.error_description && {
          error_description: permCheck.error_description,
        }),
      });
    }

    // فحص السياق: Owner لا يحذف من سلسلة أخرى
    if (
      ['owner', 'org_admin'].includes(req.user.role) &&
      targetUser.organization_id !== req.user.organization_id
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Access denied',
        error_description: 'لا يمكنك حذف مستخدم من سلسلة أخرى',
      });
    }

    // فحص السياق: Store Admin لا يحذف من فرع آخر
    if (
      ['store_admin', 'store_manager'].includes(req.user.role) &&
      targetUser.tenant_id !== req.user.tenant_id
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Access denied',
        error_description: 'لا يمكنك حذف مستخدم من فرع آخر',
      });
    }

    // إذا كان owner → افصل من organization
    if (targetUser.role === 'owner' && targetUser.organization_id) {
      await pool.query(
        `UPDATE organizations SET owner_id = NULL WHERE id = $1 AND owner_id = $2`,
        [targetUser.organization_id, req.params.userId]
      );
    }

    await pool.query(`DELETE FROM users WHERE id = $1`, [req.params.userId]);

    await req.audit({
      action: 'delete-invite',
      tableName: 'users',
      recordId: req.params.userId,
      oldData: { email: targetUser.email, role: targetUser.role },
    });

    res.json({ ok: true, success: true });
  } catch (err) {
    console.error('DELETE /api/invites/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;