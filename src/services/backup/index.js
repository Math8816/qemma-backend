// src/services/backup/index.js
// ═══════════════════════════════════════════════════════════
//  🎯 Backup Service — Adapter Pattern
// ═══════════════════════════════════════════════════════════

const config = require('./config');

// ─── Adapters ───
const adapters = {
  db: require('./adapters/db.adapter'),
  // s3: require('./adapters/s3.adapter'),   // ← فعّلها عند الحاجة
  // disk: require('./adapters/disk.adapter'),
};

// ─── اختر Adapter حسب .env ───
const adapter = adapters[config.storageType];

if (!adapter) {
  throw new Error(
    `Unknown BACKUP_STORAGE: "${config.storageType}". ` +
    `Available: ${Object.keys(adapters).join(', ')}`
  );
}

console.log(`✅ Backup storage: ${config.storageType}`);

module.exports = {
  save: (...args) => adapter.save(...args),
  load: (...args) => adapter.load(...args),
  list: (...args) => adapter.list(...args),
  delete: (...args) => adapter.delete(...args),
  exists: (...args) => adapter.exists(...args),
  cleanup: (...args) => adapter.cleanup(...args),
  config,
};