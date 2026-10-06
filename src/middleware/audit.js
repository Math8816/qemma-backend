// ═══════════════════════════════════════════════
//  src/middleware/audit.js
//  Audit Logging
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
  action,
  tableName,
  recordId,
  oldData,
  newData,
  ipAddress,
  userAgent,
}) {
  try {
    await pool.query(
      `INSERT INTO audit_log
       (user_id, user_email, action, table_name, record_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId || null,
        userEmail || null,
        action,
        tableName,
        recordId || null,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        ipAddress || null,
        userAgent || null,
      ]
    );
    // ─── Real-time Event ───
const eventData = {
  action,
  table: tableName,
  recordId: recordId,
  userEmail: userEmail,
  timestamp: new Date().toISOString(),
};

if (userId) {
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
      ipAddress: req.ip || req.headers['x-forwarded-for'],
      userAgent: req.headers['user-agent'],
      ...options,
    });
  };
  next();
}

module.exports = { logAudit, auditMiddleware };