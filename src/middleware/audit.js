// ═══════════════════════════════════════════════
//  src/middleware/audit.js
//  Audit Logging — مع tenant_id
// ═══════════════════════════════════════════════

const { emitToTenant, emitToUser } = require('../realtime/socket');
const pool = require('../db');

/**
 * تسجيل عملية في audit_log
 * @param {object} options
 */
async function logAudit({
  userId,
  userEmail,
  tenantId,
  action,
  tableName,
  recordId,
  oldData,
  newData,
  ipAddress,
  userAgent,
}) {
  try {
    // ─── 1. إدراج في audit_log ───
    await pool.query(
      `INSERT INTO audit_log
       (user_id, user_email, tenant_id, action, table_name, record_id, 
        old_data, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId || null,
        userEmail || null,
        tenantId || null,
        action,
        tableName,
        recordId || null,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        ipAddress || null,
        userAgent || null,
      ]
    );

    // ─── 2. Real-time Event ───
    const eventData = {
      action,
      table: tableName,
      recordId,
      userEmail,
      tenantId,
      timestamp: new Date().toISOString(),
    };

    // ✅ البث لكل مستخدمي الفرع (store_admin يرى عمليات فريقه)
    if (tenantId) {
      emitToTenant(tenantId, 'audit:new', eventData);
    } else if (userId) {
      // للأدوار العامة (developer, platform team)
      emitToUser(userId, 'audit:new', eventData);
    }
  } catch (err) {
    console.error('❌ Audit log error:', err.message);
    // لا نُفشل العملية الأساسية
  }
}

/**
 * Middleware: يضيف req.audit
 */
function auditMiddleware(req, _res, next) {
  req.audit = (options) => {
    return logAudit({
      userId: req.user?.sub,
      userEmail: req.user?.email,
      tenantId: req.user?.tenant_id,
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      ...options,
    });
  };
  next();
}

module.exports = { logAudit, auditMiddleware };