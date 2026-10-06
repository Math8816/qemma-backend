// ═══════════════════════════════════════════════
//  src/db-rls.js
//  اتصال RLS-aware — لكل طلب
// ═══════════════════════════════════════════════

const { Pool } = require('pg');

const rlsPool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT),
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max:      10,
});

/**
 * تنفيذ استعلام في جلسة RLS مُعدّة
 * @param {object} user - { sub, tenant_id, organization_id }
 * @param {string} sql - الاستعلام
 * @param {array} params - معاملات الاستعلام
 * @returns {Promise<object>} - { rows, rowCount }
 */
async function queryAsUser(user, sql, params = []) {
  const client = await rlsPool.connect();

  try {
    // ─── بدء Transaction ───
    await client.query('BEGIN');

    // ─── ضبط دور authenticated ───
    await client.query('SET LOCAL role TO authenticated');
    await client.query("SELECT set_config('request.jwt.claim.role', $1, true)", ['authenticated']);

    // ─── ضبط هوية المستخدم ───
    if (user && user.sub) {
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [user.sub]);
    }

    if (user && user.tenant_id) {
      await client.query("SELECT set_config('request.jwt.claim.tenant_id', $1, true)", [user.tenant_id]);
    }

    if (user && user.organization_id) {
      await client.query("SELECT set_config('request.jwt.claim.organization_id', $1, true)", [user.organization_id]);
    }

    // ─── تنفيذ الاستعلام ───
    const result = await client.query(sql, params);

    // ─── إنهاء Transaction ───
    await client.query('COMMIT');

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { rlsPool, queryAsUser };