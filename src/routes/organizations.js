// ═══════════════════════════════════════════════
//  src/routes/organizations.js
//  إدارة السلاسل والفروع
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

const ORG_PLANS = ['premium', 'enterprise'];

function requireRole(user, roles) {
  if (!user?.sub) return { ok: false, code: 401, error: 'Authentication required' };
  if (!roles.includes(user.role)) return { ok: false, code: 403, error: 'Access denied' };
  return { ok: true };
}

function getMaxBranches(plan) {
  return { premium: 10, enterprise: 999 }[plan] || 1;
}

// ═══ POST /api/organizations ═══
router.post('/', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { name, plan, createdBy = null } = req.body;
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'اسم السلسلة مطلوب' });
    if (!ORG_PLANS.includes(plan)) {
      return res.status(400).json({ ok: false, error: `الباقة يجب أن تكون: ${ORG_PLANS.join(', ')}` });
    }

    const { rows } = await pool.query(
      `INSERT INTO organizations
        (name, plan, max_branches, current_branches, owner_id, created_by,
         is_active, subscription_status, subscription_started_at, subscription_expires_at)
       VALUES ($1, $2, $3, 0, NULL, $4, true, 'active', NOW(), NOW() + INTERVAL '365 days')
       RETURNING *`,
      [name.trim(), plan, getMaxBranches(plan), createdBy]
    );

    res.status(201).json({ ok: true, success: true, organization: rows[0] });
  } catch (err) {
    console.error('POST /organizations error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ GET /api/organizations/me/current ═══
router.get('/me/current', optionalAuth, async (req, res) => {
  try {
    if (!req.user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    if (!req.user.organization_id) return res.json({ ok: true, data: null });

    const { rows } = await pool.query(
      `SELECT * FROM organizations WHERE id = $1`,
      [req.user.organization_id]
    );
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ GET /api/organizations/:id ═══
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    if (req.user.role !== 'developer' && req.user.organization_id !== req.params.id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `SELECT o.*, u.full_name AS owner_name, u.email AS owner_email
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_id
       WHERE o.id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Organization not found' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ PUT /api/organizations/:id ═══
router.put('/:id', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { name, plan, is_active, subscription_status } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) { values.push(name); updates.push(`name = $${values.length}`); }
    if (plan !== undefined) {
      if (!ORG_PLANS.includes(plan)) return res.status(400).json({ ok: false, error: 'invalid plan' });
      values.push(plan); updates.push(`plan = $${values.length}`);
      values.push(getMaxBranches(plan)); updates.push(`max_branches = $${values.length}`);
    }
    if (is_active !== undefined) { values.push(is_active); updates.push(`is_active = $${values.length}`); }
    if (subscription_status !== undefined) { values.push(subscription_status); updates.push(`subscription_status = $${values.length}`); }

    if (updates.length === 0) return res.status(400).json({ ok: false, error: 'No fields to update' });

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, success: true, organization: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ GET /api/organizations/:id/branches ═══
router.get('/:id/branches', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    if (req.user.role !== 'developer' && req.user.organization_id !== req.params.id) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `SELECT b.*, t.name AS tenant_name, t.is_active AS tenant_active, t.subscription_plan
       FROM branches b
       LEFT JOIN tenants t ON t.id = b.tenant_id
       WHERE b.organization_id = $1
       ORDER BY b.is_hq DESC, b.name`,
      [req.params.id]
    );

    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ POST /api/organizations/:id/branches ═══
router.post('/:id/branches', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const check = requireRole(req.user, ['developer', 'owner']);
    if (!check.ok) { client.release(); return res.status(check.code).json({ ok: false, error: check.error }); }

    if (req.user.role !== 'developer' && req.user.organization_id !== req.params.id) {
      client.release();
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const { name, code = null, address = null, phone = null, isHq = false } = req.body;
    if (!name?.trim()) { client.release(); return res.status(400).json({ ok: false, error: 'اسم الفرع مطلوب' }); }

    await client.query('BEGIN');

    const orgRes = await client.query(
      `SELECT plan, max_branches, current_branches, subscription_status,
              subscription_started_at, subscription_expires_at
       FROM organizations WHERE id = $1`,
      [req.params.id]
    );

    if (orgRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Organization not found' });
    }

    const org = orgRes.rows[0];
    if (org.current_branches >= org.max_branches) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: `الحد الأقصى ${org.max_branches} فروع` });
    }

    const tenantRes = await client.query(
      `INSERT INTO tenants (name, email, phone, address, organization_id, subscription_plan,
         subscription_status, subscription_started_at, subscription_expires_at, is_active)
       VALUES ($1, '', $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING *`,
      [name.trim(), phone, address, req.params.id, org.plan,
       org.subscription_status || 'active', org.subscription_started_at, org.subscription_expires_at]
    );
    const tenant = tenantRes.rows[0];

    const isFirst = org.current_branches === 0;
    const finalHq = isHq || isFirst;

    const branchRes = await client.query(
      `INSERT INTO branches (organization_id, tenant_id, name, code, address, phone, is_hq, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [req.params.id, tenant.id, name.trim(), code, address, phone, finalHq]
    );

    await client.query(
      `UPDATE organizations SET current_branches = current_branches + 1, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, success: true, branch: branchRes.rows[0], tenant });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /organizations/:id/branches error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══ DELETE /api/organizations/:id/branches/:branchId ═══
router.delete('/:id/branches/:branchId', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const check = requireRole(req.user, ['developer', 'owner']);
    if (!check.ok) { client.release(); return res.status(check.code).json({ ok: false, error: check.error }); }

    const forceDelete = req.query.forceDelete === 'true';

    await client.query('BEGIN');

    const branchRes = await client.query(
      `SELECT id, tenant_id, is_hq, name FROM branches WHERE id = $1 AND organization_id = $2`,
      [req.params.branchId, req.params.id]
    );

    if (branchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Branch not found' });
    }

    const branch = branchRes.rows[0];
    if (branch.is_hq && !forceDelete) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'لا يمكن حذف الفرع الرئيسي' });
    }

    const tenantId = branch.tenant_id;
    const tables = [
      'inventory_log', 'stock', 'product_units',
      'sales_invoice_items', 'purchase_invoice_items',
      'sales_invoices', 'purchase_invoices',
      'return_items', 'returns',
      'ledger_entries', 'transactions', 'accounts',
      'accounting_periods',
      'customers', 'suppliers', 'sales_reps',
      'products', 'categories', 'companies', 'units',
      'settings', 'notifications',
    ];

    for (const t of tables) {
      try {
        await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
      } catch (e) { /* skip */ }
    }

    await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await client.query(`DELETE FROM branches WHERE id = $1`, [req.params.branchId]);
    await client.query(
      `UPDATE organizations SET current_branches = GREATEST(0, current_branches - 1), updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true, success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══ GET /api/organizations/:id/check-limit ═══
router.get('/:id/check-limit', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { rows } = await pool.query(
      `SELECT max_branches, current_branches FROM organizations WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Not found' });

    const { max_branches, current_branches } = rows[0];
    res.json({
      ok: true,
      allowed: current_branches < max_branches,
      current: current_branches,
      max: max_branches,
      remaining: max_branches - current_branches,
      isUnlimited: false,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ GET /api/organizations/:id/staff ═══
router.get('/:id/staff', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer', 'owner', 'org_admin']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { rows } = await pool.query(
      `SELECT id, full_name, email, phone, role, is_active, created_at,
              invite_status, tenant_id, organization_id
       FROM users
       WHERE organization_id = $1 AND role = 'store_admin'
       ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ ok: true, count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══ DELETE /api/organizations/:id ═══
router.delete('/:id', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const check = requireRole(req.user, ['developer']);
    if (!check.ok) { client.release(); return res.status(check.code).json({ ok: false, error: check.error }); }

    await client.query('BEGIN');

    const branchesRes = await client.query(
      `SELECT id, tenant_id FROM branches WHERE organization_id = $1`,
      [req.params.id]
    );

    const tables = [
      'inventory_log', 'stock', 'product_units',
      'sales_invoice_items', 'purchase_invoice_items',
      'sales_invoices', 'purchase_invoices',
      'return_items', 'returns',
      'ledger_entries', 'transactions', 'accounts',
      'accounting_periods',
      'customers', 'suppliers', 'sales_reps',
      'products', 'categories', 'companies', 'units',
      'settings', 'notifications',
    ];

    for (const b of branchesRes.rows) {
      for (const t of tables) {
        try {
          await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [b.tenant_id]);
        } catch (e) { /* skip */ }
      }
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [b.tenant_id]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [b.tenant_id]);
    }

    await client.query(`DELETE FROM branches WHERE organization_id = $1`, [req.params.id]);

    const orgRes = await client.query(`SELECT owner_id FROM organizations WHERE id = $1`, [req.params.id]);
    if (orgRes.rows[0]?.owner_id) {
      await client.query(`UPDATE users SET organization_id = NULL WHERE id = $1`, [orgRes.rows[0].owner_id]);
    }

    await client.query(`DELETE FROM organizations WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true, success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══ POST /:id/link-owner & unlink-owner ═══
router.post('/:id/link-owner', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { ownerId } = req.body;
    if (!ownerId) return res.status(400).json({ ok: false, error: 'ownerId required' });

    await pool.query(`UPDATE users SET organization_id = $1 WHERE id = $2 AND role = 'owner'`, [req.params.id, ownerId]);
    await pool.query(`UPDATE organizations SET owner_id = $1 WHERE id = $2`, [ownerId, req.params.id]);
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:id/unlink-owner', optionalAuth, async (req, res) => {
  try {
    const check = requireRole(req.user, ['developer']);
    if (!check.ok) return res.status(check.code).json({ ok: false, error: check.error });

    const { ownerId } = req.body;
    await pool.query(`UPDATE users SET organization_id = NULL WHERE id = $1 AND role = 'owner'`, [ownerId]);
    await pool.query(`UPDATE organizations SET owner_id = NULL WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, success: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;