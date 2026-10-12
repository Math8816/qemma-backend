// src/services/backup/adapters/db.adapter.js
// ═══════════════════════════════════════════════════════════
//  💾 DB Adapter — حفظ النسخ في PostgreSQL
// ═══════════════════════════════════════════════════════════

const zlib = require('zlib');
const { promisify } = require('util');
const pool = require('../../../db');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ═══════════════════════════════════════════════════════════
//  💾 Save
// ═══════════════════════════════════════════════════════════
async function save(id, scopeType, scopeId, data, metadata = {}) {
  // 1. JSON stringify
  const jsonString = JSON.stringify(data);
  const sizeBytes = Buffer.byteLength(jsonString, 'utf8');

  // 2. Compress
  const compressed = await gzip(jsonString, { level: 6 });
  const dataBase64 = compressed.toString('base64');

  // 3. Insert
  const { rows } = await pool.query(
    `INSERT INTO backups 
     (id, scope_type, scope_id, tenant_id, organization_id,
      data_compressed, size_bytes, size_compressed_bytes,
      tables_count, records_count, created_by, created_by_email,
      notes, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, created_at`,
    [
      id,
      scopeType,
      scopeId,
      metadata.tenant_id || null,
      metadata.organization_id || null,
      dataBase64,
      sizeBytes,
      compressed.length,
      metadata.tables_count || 0,
      metadata.records_count || 0,
      metadata.created_by || null,
      metadata.created_by_email || null,
      metadata.notes || null,
      metadata.version || '2.1',
    ]
  );

  return {
    id: rows[0].id,
    createdAt: rows[0].created_at,
    sizeBytes,
    sizeCompressed: compressed.length,
    ratio: (compressed.length / sizeBytes).toFixed(2),
  };
}

// ═══════════════════════════════════════════════════════════
//  📖 Load
// ═══════════════════════════════════════════════════════════
async function load(id) {
  const { rows } = await pool.query(
    `SELECT data_compressed, size_bytes, tables_count, 
            records_count, created_at, version
     FROM backups WHERE id = $1`,
    [id]
  );

  if (rows.length === 0) {
    throw new Error('Backup not found');
  }

  const row = rows[0];

  // 1. Base64 → Buffer
  const compressed = Buffer.from(row.data_compressed, 'base64');

  // 2. Gunzip
  const jsonBuffer = await gunzip(compressed);

  // 3. Parse
  const data = JSON.parse(jsonBuffer.toString('utf8'));

  return {
    data,
    metadata: {
      id,
      sizeBytes: row.size_bytes,
      tablesCount: row.tables_count,
      recordsCount: row.records_count,
      createdAt: row.created_at,
      version: row.version,
    },
  };
}

// ═══════════════════════════════════════════════════════════
//  📋 List
// ═══════════════════════════════════════════════════════════
async function list(scopeType, scopeId) {
  const { rows } = await pool.query(
    `SELECT id, scope_type, scope_id, size_bytes, 
            size_compressed_bytes, tables_count, records_count,
            created_by_email, created_at, notes, version
     FROM backups
     WHERE scope_type = $1 AND scope_id = $2
     ORDER BY created_at DESC`,
    [scopeType, scopeId]
  );

  return rows.map((r) => ({
    id: r.id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    sizeBytes: r.size_bytes,
    sizeCompressed: r.size_compressed_bytes,
    tablesCount: r.tables_count,
    recordsCount: r.records_count,
    createdBy: r.created_by_email,
    createdAt: r.created_at,
    notes: r.notes,
    version: r.version,
  }));
}

// ═══════════════════════════════════════════════════════════
//  🗑️ Delete
// ═══════════════════════════════════════════════════════════
async function remove(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM backups WHERE id = $1',
    [id]
  );
  return { deleted: rowCount > 0 };
}

// ═══════════════════════════════════════════════════════════
//  ❓ Exists
// ═══════════════════════════════════════════════════════════
async function exists(id) {
  const { rows } = await pool.query(
    'SELECT 1 FROM backups WHERE id = $1',
    [id]
  );
  return rows.length > 0;
}

// ═══════════════════════════════════════════════════════════
//  🧹 Cleanup (احتفظ بأحدث N)
// ═══════════════════════════════════════════════════════════
async function cleanup(scopeType, scopeId, keepCount = 10) {
  const { rowCount } = await pool.query(
    `DELETE FROM backups
     WHERE id IN (
       SELECT id FROM backups
       WHERE scope_type = $1 AND scope_id = $2
       ORDER BY created_at DESC
       OFFSET $3
     )`,
    [scopeType, scopeId, keepCount]
  );
  return { deleted: rowCount };
}

module.exports = {
  save,
  load,
  list,
  delete: remove,
  exists,
  cleanup,
};