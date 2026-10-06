// ═══════════════════════════════════════════════
//  src/routes/storage.js
//  Storage API — رفع/تنزيل/حذف/قائمة + backup
// ═══════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const pool = require('../db');
const diskAdapter = require('../storage/disk');
const { upload } = require('../middleware/upload');
const { optionalAuth, requireAuth } = require('../middleware/auth');

const router = express.Router();
const execAsync = promisify(exec);

// ═══════════════════════════════════════════════
//  GET /storage/v1/buckets
// ═══════════════════════════════════════════════
router.get('/buckets', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, public FROM storage.buckets ORDER BY name'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /storage/v1/object/:bucket — رفع ملف
// ═══════════════════════════════════════════════
router.post(
  '/object/:bucket',
  requireAuth,
  upload.single('file'),
  async (req, res) => {
    try {
      const { bucket } = req.params;
      const user = req.user;

      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No file uploaded' });
      }

      const { rows: bucketRows } = await pool.query(
        'SELECT id, public, file_size_limit FROM storage.buckets WHERE id = $1',
        [bucket]
      );

      if (bucketRows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Bucket not found' });
      }

      if (req.file.size > bucketRows[0].file_size_limit) {
        return res.status(413).json({ ok: false, error: 'File too large' });
      }

      const ext = path.extname(req.file.originalname);
      const baseName = path.basename(req.file.originalname, ext);
      const timestamp = Date.now();
      const randomSuffix = crypto.randomBytes(4).toString('hex');
      const fileName = `${baseName}-${timestamp}-${randomSuffix}${ext}`;

      await diskAdapter.upload(bucket, fileName, req.file.buffer);

      const { rows } = await pool.query(
        `INSERT INTO storage.objects 
         (bucket_id, name, owner, size, mime_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, bucket_id, name, size, mime_type, created_at`,
        [
          bucket,
          fileName,
          user.sub,
          req.file.size,
          req.file.mimetype,
          JSON.stringify({ original_name: req.file.originalname }),
        ]
      );

      res.status(201).json({
        ok: true,
        data: {
          ...rows[0],
          url: `/storage/v1/object/${bucket}/${fileName}`,
        },
      });
    } catch (err) {
      console.error('Storage upload error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ═══════════════════════════════════════════════
//  GET /storage/v1/object/:bucket/* — تنزيل
// ═══════════════════════════════════════════════
router.get('/object/:bucket/*', async (req, res) => {
  try {
    const { bucket } = req.params;
    const fileName = req.params[0];

    const { rows } = await pool.query(
      'SELECT id, mime_type FROM storage.objects WHERE bucket_id = $1 AND name = $2',
      [bucket, fileName]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }

    const buffer = await diskAdapter.download(bucket, fileName);

    res.set('Content-Type', rows[0].mime_type || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /storage/v1/object/:bucket/* — حذف
// ═══════════════════════════════════════════════
router.delete('/object/:bucket/*', requireAuth, async (req, res) => {
  try {
    const { bucket } = req.params;
    const fileName = req.params[0];

    await diskAdapter.remove(bucket, fileName);

    const { rows } = await pool.query(
      'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING id',
      [bucket, fileName]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'File not found' });
    }

    res.json({ ok: true, message: 'File deleted' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /storage/v1/list/:bucket — قائمة
// ═══════════════════════════════════════════════
router.get('/list/:bucket', optionalAuth, async (req, res) => {
  try {
    const { bucket } = req.params;
    const prefix = req.query.prefix || '';

    const { rows } = await pool.query(
      `SELECT id, name, size, mime_type, owner, created_at
       FROM storage.objects
       WHERE bucket_id = $1 AND name LIKE $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [bucket, `${prefix}%`]
    );

    res.json({
      ok: true,
      bucket,
      count: rows.length,
      data: rows.map((r) => ({
        ...r,
        url: `/storage/v1/object/${bucket}/${r.name}`,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /storage/v1/backup/create
// ═══════════════════════════════════════════════
router.post('/backup/create', requireAuth, async (req, res) => {
  try {
    const PG_DUMP = 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `qemma-${timestamp}.sql`;
    const tmpPath = `./storage/backups/${fileName}`;

    const cmd = `"${PG_DUMP}" -U ${process.env.DB_USER} -h ${process.env.DB_HOST} -p ${process.env.DB_PORT} -d ${process.env.DB_NAME} -f "${tmpPath}" --no-owner --no-privileges`;

    await execAsync(cmd, {
      env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD },
      maxBuffer: 1024 * 1024 * 100,
    });

    const stat = fs.statSync(tmpPath);

    const { rows } = await pool.query(
      `INSERT INTO storage.objects 
       (bucket_id, name, owner, size, mime_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, size, created_at`,
      [
        'backups',
        fileName,
        req.user.sub,
        stat.size,
        'application/sql',
        JSON.stringify({ type: 'database_backup' }),
      ]
    );

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('Backup create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;