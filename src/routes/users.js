// ═══════════════════════════════════════════════
//  src/routes/users.js
//  User Management كامل (مع RLS + Audit + bcrypt)
// ═══════════════════════════════════════════════

const express = require('express');
const bcrypt = require('bcrypt'); // أو 'bcryptjs'
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();

router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  GET /api/users — كل المستخدمين (بدون RLS)
// ═══════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, email, full_name, role, tenant_id, organization_id, is_active, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 200`
    );

    res.json({
      ok: true,
      user: user.sub || 'anonymous',
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /users error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/users/:id — مستخدم واحد
// ═══════════════════════════════════════════════
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };

    const result = await queryAsUser(
      user,
      `SELECT id, email, full_name, role, tenant_id, organization_id, is_active, created_at
       FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/users — إنشاء مستخدم (مع كلمة مرور)
// ═══════════════════════════════════════════════
router.post('/', optionalAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser || !currentUser.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { id, email, full_name, role, password, tenant_id, organization_id, is_active } = req.body;

    // ─── التحقق من المدخلات ───
    if (!id) {
      return res.status(400).json({ ok: false, error: 'id (UUID) is required' });
    }
    if (!email) {
      return res.status(400).json({ ok: false, error: 'email is required' });
    }
    if (!role) {
      return res.status(400).json({ ok: false, error: 'role is required' });
    }

    // ─── تشفير كلمة المرور (إن وُجدت) ───
    let passwordHash = null;
    if (password && password.trim().length > 0) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    // ─── tenant من JWT (للأمان) ───
    const finalTenantId = tenant_id || currentUser.tenant_id || null;
    const finalOrgId = organization_id || currentUser.organization_id || null;

    const result = await queryAsUser(
      currentUser,
      `INSERT INTO users (id, email, full_name, role, password_hash, tenant_id, organization_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, full_name, role, tenant_id, organization_id, is_active, created_at`,
      [
        id,
        email.toLowerCase().trim(),
        full_name || null,
        role,
        passwordHash,
        finalTenantId,
        finalOrgId,
        is_active !== undefined ? is_active : true,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'users',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /users error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Email or ID already exists' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/users/:id — تحديث بيانات المستخدم
// ═══════════════════════════════════════════════
router.put('/:id', optionalAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser || !currentUser.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { email, full_name, role, is_active, password } = req.body;

    // جلب البيانات القديمة
    const oldResult = await queryAsUser(
      currentUser,
      `SELECT id, email, full_name, role, tenant_id, organization_id, is_active FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found or access denied' });
    }

    // بناء UPDATE ديناميكي
    const updates = [];
    const values = [];

    if (email) {
      values.push(email.toLowerCase().trim());
      updates.push(`email = $${values.length}`);
    }
    if (full_name !== undefined) {
      values.push(full_name);
      updates.push(`full_name = $${values.length}`);
    }
    if (role) {
      values.push(role);
      updates.push(`role = $${values.length}`);
    }
    if (is_active !== undefined) {
      values.push(is_active);
      updates.push(`is_active = $${values.length}`);
    }
    if (password && password.trim().length > 0) {
      const hash = await bcrypt.hash(password, 10);
      values.push(hash);
      updates.push(`password_hash = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: 'No fields to update' });
    }

    values.push(req.params.id);

    const result = await queryAsUser(
      currentUser,
      `UPDATE users
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, email, full_name, role, tenant_id, organization_id, is_active, updated_at`,
      values
    );

    await req.audit({
      action: 'update',
      tableName: 'users',
      recordId: result.rows[0].id,
      oldData: oldResult.rows[0],
      newData: result.rows[0],
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /users error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/users/:id/role — تغيير الدور فقط
// ═══════════════════════════════════════════════
router.put('/:id/role', optionalAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser || !currentUser.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { role } = req.body;
    if (!role) {
      return res.status(400).json({ ok: false, error: 'role is required' });
    }

    const oldResult = await queryAsUser(
      currentUser,
      `SELECT id, email, role FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (oldResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    const result = await queryAsUser(
      currentUser,
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, email, full_name, role, is_active`,
      [role, req.params.id]
    );

    await req.audit({
      action: 'update-role',
      tableName: 'users',
      recordId: req.params.id,
      oldData: { role: oldResult.rows[0].role },
      newData: { role },
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /users/:id/role error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  PUT /api/users/:id/active — تفعيل/تعطيل
// ═══════════════════════════════════════════════
router.put('/:id/active', optionalAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser || !currentUser.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // منع المستخدم من تعطيل نفسه
    if (currentUser.sub === req.params.id) {
      return res.status(400).json({ ok: false, error: 'لا يمكنك تعطيل حسابك الخاص' });
    }

    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'is_active (boolean) is required' });
    }

    const result = await queryAsUser(
      currentUser,
      `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, email, full_name, role, is_active`,
      [is_active, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    await req.audit({
      action: is_active ? 'activate' : 'deactivate',
      tableName: 'users',
      recordId: req.params.id,
      newData: { is_active },
    });

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('PUT /users/:id/active error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/users/:id — حذف مستخدم
// ═══════════════════════════════════════════════
router.delete('/:id', optionalAuth, async (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser || !currentUser.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    // منع المستخدم من حذف نفسه
    if (currentUser.sub === req.params.id) {
      return res.status(400).json({ ok: false, error: 'لا يمكنك حذف حسابك الخاص' });
    }

    const result = await queryAsUser(
      currentUser,
      `DELETE FROM users WHERE id = $1 RETURNING id, email, full_name, role`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    await req.audit({
      action: 'delete',
      tableName: 'users',
      recordId: result.rows[0].id,
      oldData: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /users error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;