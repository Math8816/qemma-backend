// src/services/backup/config.js
// ═══════════════════════════════════════════════════════════
//  ⚙️ Backup Configuration
// ═══════════════════════════════════════════════════════════

module.exports = {
  // ─── Storage Adapter ───
  // 'db'  → PostgreSQL (default)
  // 's3'  → Amazon S3 (later)
  // 'r2'  → Cloudflare R2 (later)
  // 'disk' → Local filesystem (fallback)
  storageType: process.env.BACKUP_STORAGE || 'db',

  // ─── Limits ───
  maxBackupsPerScope: parseInt(process.env.BACKUP_MAX || '10', 10),
  maxSizeBytes: 50 * 1024 * 1024,   // 50 MB compressed

  // ─── Compression ───
  compress: true,
  compressionLevel: 6,   // 0-9

  // ─── S3 Config (للمستقبل) ───
  s3: {
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || 'eu-central-1',
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    endpoint: process.env.S3_ENDPOINT,   // للـ R2 / MinIO
  },

  // ─── Disk Config (fallback) ───
  disk: {
    path: process.env.STORAGE_PATH || './storage/backups',
  },
};