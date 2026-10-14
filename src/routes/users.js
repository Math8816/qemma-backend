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

// ═══════════════════════════════════════════════════════════
//  GET /api/users — فلترة حسب الدور + RLS
// ═══════════════════════════════════════════════════════════
router.get('/', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    let whereClause = 'WHERE 1=1';
    const params = [];

    // ─── فلترة حسب دور الطالب ───
    if (user.role === 'developer') {
      // Developer → كل المستخدمين
    } else if (['owner', 'org_admin', 'org_accountant'].includes(user.role)) {
      // Owner → مستخدمي سلسته
      if (user.organization_id) {
        params.push(user.organization_id);
        whereClause += ` AND organization_id = $${params.length}`;
      }
    } else if (['store_admin', 'store_manager'].includes(user.role)) {
      // Store Admin → موظفي فرعه فقط
      if (user.tenant_id) {
        params.push(user.tenant_id);
        whereClause += ` AND tenant_id = $${params.length}`;
      }

      // ⭐ استبعاد الأدوار الإدارية العليا
      whereClause += ` AND role NOT IN ('developer', 'owner', 'org_admin', 'org_accountant')`;
    } else {
      // باقي الأدوار → لا يرون أحد
      return res.json({ ok: true, count: 0, data: [] });
    }

    // ─── فلترة اختيارية (Developer فقط) ───
    const { tenant_id, role, is_active } = req.query;

    if (tenant_id && user.role === 'developer') {
      params.push(tenant_id);
      whereClause += ` AND tenant_id = $${params.length}`;
    }

    if (role && user.role === 'developer') {
      params.push(role);
      whereClause += ` AND role = $${params.length}`;
    }

    if (is_active !== undefined) {
      params.push(is_active === 'true');
      whereClause += ` AND is_active = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT id, email, full_name, role, tenant_id, organization_id,
              is_active, invite_status, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT 200`,
      params
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /users error:', err.message);
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