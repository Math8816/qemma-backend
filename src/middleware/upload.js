// ═══════════════════════════════════════════════
//  src/middleware/upload.js
//  Multer — رفع الملفات
// ═══════════════════════════════════════════════

const multer = require('multer');

// ─── تخزين في الذاكرة (سنحفظ لاحقاً بأنفسنا) ───
const storage = multer.memoryStorage();

// ─── فلترة الملفات ───
function fileFilter(_req, file, cb) {
  const ALLOWED_MIME = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'application/pdf',
    'application/json',
    'application/zip',
    'text/plain',
  ];

  if (ALLOWED_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`));
  }
}

// ─── Multer ───
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB
    files: 5,
  },
});

module.exports = { upload };