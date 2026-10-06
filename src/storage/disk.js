// ═══════════════════════════════════════════════
//  src/storage/disk.js
//  Disk Adapter — التخزين المحلي
// ═══════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(__dirname, '../../storage');

// ─── تأكد من وجود المجلد ───
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── مسار Bucket ───
function bucketPath(bucket) {
  const p = path.join(STORAGE_ROOT, bucket);
  ensureDir(p);
  return p;
}

// ─── مسار الملف الكامل ───
function filePath(bucket, fileName) {
  // منع path traversal
  const safeName = fileName.replace(/\.\./g, '').replace(/^\/+/, '');
  return path.join(bucketPath(bucket), safeName);
}

// ═══════════════════════════════════════════════
//  Operations
// ═══════════════════════════════════════════════

async function upload(bucket, fileName, buffer) {
  const filepath = filePath(bucket, fileName);
  const dir = path.dirname(filepath);
  ensureDir(dir);
  fs.writeFileSync(filepath, buffer);
  return {
    key: `${bucket}/${fileName}`,
    size: buffer.length,
  };
}

async function download(bucket, fileName) {
  const filepath = filePath(bucket, fileName);
  if (!fs.existsSync(filepath)) {
    throw new Error('File not found');
  }
  return fs.readFileSync(filepath);
}

async function remove(bucket, fileName) {
  const filepath = filePath(bucket, fileName);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    return { deleted: true };
  }
  return { deleted: false };
}

async function list(bucket, prefix = '') {
  const dir = path.join(bucketPath(bucket), prefix);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir, { withFileTypes: true });
  return files
    .filter((f) => f.isFile())
    .map((f) => {
      const filepath = path.join(dir, f.name);
      const stat = fs.statSync(filepath);
      return {
        name: prefix ? `${prefix}/${f.name}` : f.name,
        size: stat.size,
        updated_at: stat.mtime,
      };
    });
}

module.exports = {
  upload,
  download,
  remove,
  list,
  STORAGE_ROOT,
};