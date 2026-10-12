// src/routes/backup.js
// ═══════════════════════════════════════════════════════════
//  💾 Backup Routes — Adapter Pattern
// ═══════════════════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const backupStorage = require('../services/backup');
const backupService = require('../services/backup/backupService');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════
function requireAuth(req, res) {
  if (!req.user?.sub) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return false;
  }
  if (!req.user.tenant_id && !req.user.organization_id) {
    res.status(400).json({ ok: false, error: 'tenant_id or organization_id required' });
    return false;
  }
  return true;
}

function getScope(req) {
  const user = req.user;
  if (
    ['owner', 'org_admin'].includes(user.role) &&
    user.organization_id
  ) {
    return { id: user.organization_id, type: 'organization' };
  }
  return { id: user.tenant_id, type: 'tenant' };
}

// ⭐ فحص الخطة
async function checkBackupAllowed(user) {
  const planRes = await pool.query(
    `SELECT subscription_plan FROM tenants WHERE id = $1
     UNION
     SELECT plan AS subscription_plan FROM organizations WHERE id = $2
     LIMIT 1`,
    [user.tenant_id || '00000000-0000-0000-0000-000000000000',
     user.organization_id || '00000000-0000-0000-0000-000000000000']
  );

  const plan = planRes.rows[0]?.subscription_plan || 'trial';
  return ['standard', 'standard_plus', 'premium', 'enterprise'].includes(plan);
}

// ═══════════════════════════════════════════════════════════
//  POST /api/backup/create
// ═══════════════════════════════════════════════════════════
router.post('/create', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    // ⭐ فحص الخطة
    const allowed = await checkBackupAllowed(req.user);
    if (!allowed) {
      return res.status(403).json({
        ok: false,
        error: 'Backup requires Standard plan or higher',
      });
    }

    const { id: scopeId, type: scopeType } = getScope(req);

    const result = await backupService.createBackup(
      req.user,
      scopeId,
      scopeType
    );

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/backup/create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /api/backup/list
// ═══════════════════════════════════════════════════════════
router.get('/list', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { id: scopeId, type: scopeType } = getScope(req);
    const files = await backupStorage.list(scopeType, scopeId);

    res.json({ ok: true, files, count: files.length });
  } catch (err) {
    console.error('GET /api/backup/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/backup/restore/:id
// ═══════════════════════════════════════════════════════════
router.post('/restore/:id', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const allowed = await checkBackupAllowed(req.user);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'Backup requires paid plan' });
    }

    const { id: scopeId, type: scopeType } = getScope(req);
    const { id } = req.params;

    const exists = await backupStorage.exists(id);
    if (!exists) {
      return res.status(404).json({ ok: false, error: 'Backup not found' });
    }

    const result = await backupService.restoreBackup(req.user, id, scopeId, scopeType);

    res.json({
      ok: true,
      totalInserted: result.totalInserted,
      totalTables: result.totalTables,
      message: 'تمت الاستعادة بنجاح',
    });
  } catch (err) {
    console.error('POST /api/backup/restore error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /api/backup/download/:id
// ═══════════════════════════════════════════════════════════
router.get('/download/:id', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const allowed = await checkBackupAllowed(req.user);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'Backup requires paid plan' });
    }

    const { id } = req.params;
    const exists = await backupStorage.exists(id);
    if (!exists) {
      return res.status(404).json({ ok: false, error: 'Backup not found' });
    }

    const { data, metadata } = await backupStorage.load(id);

    const fileName = `backup-${id}.json`;
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('GET /api/backup/download error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  DELETE /api/backup/:id
// ═══════════════════════════════════════════════════════════
router.delete('/:id', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { id: scopeId, type: scopeType } = getScope(req);
    const { id } = req.params;

    const exists = await backupStorage.exists(id);
    if (!exists) {
      return res.status(404).json({ ok: false, error: 'Backup not found' });
    }

    const result = await backupStorage.delete(id);

    res.json({ ok: true, deleted: result.deleted ? id : null });
  } catch (err) {
    console.error('DELETE /api/backup error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;