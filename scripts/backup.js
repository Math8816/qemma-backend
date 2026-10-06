// ═══════════════════════════════════════════════
//  scripts/backup.js
//  نسخة احتياطية لقاعدة البيانات
// ═══════════════════════════════════════════════

require('dotenv').config();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const diskAdapter = require('../src/storage/disk');
const pool = require('../src/db');

const execAsync = promisify(exec);

// ─── إعدادات ───
const PG_DUMP = 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe';
const DB_NAME = process.env.DB_NAME || 'qemma_services';
const DB_USER = process.env.DB_USER || 'postgres';
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '5432';

async function backup() {
  try {
    console.log('\n💾 Starting database backup...\n');

    // ─── اسم الملف ───
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `qemma-${timestamp}.sql`;

    // ─── مسار مؤقت ───
    const tmpPath = path.join(__dirname, `../storage/backups/${fileName}`);

    // ─── pg_dump ───
    console.log(`📦 Running pg_dump...`);
    const cmd = `"${PG_DUMP}" -U ${DB_USER} -h ${DB_HOST} -p ${DB_PORT} -d ${DB_NAME} -f "${tmpPath}" --no-owner --no-privileges`;

    // ─── تعيين PGPASSWORD ───
    await execAsync(cmd, {
      env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD },
      maxBuffer: 1024 * 1024 * 100, // 100 MB
    });

    // ─── الحجم ───
    const stat = fs.statSync(tmpPath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`✅ pg_dump complete (${sizeMB} MB)`);

    // ─── حفظ في storage.objects ───
    const { rows } = await pool.query(
      `INSERT INTO storage.objects 
       (bucket_id, name, size, mime_type, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, size, created_at`,
      [
        'backups',
        fileName,
        stat.size,
        'application/sql',
        JSON.stringify({ type: 'database_backup', database: DB_NAME }),
      ]
    );

    console.log(`✅ Backup saved: ${rows[0].name} (${(rows[0].size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`📁 Location: storage/backups/${fileName}\n`);

    // ─── حذف النسخ الأقدم من 7 أيام ───
    await cleanupOldBackups();

    process.exit(0);
  } catch (err) {
    console.error('❌ Backup error:', err.message);
    process.exit(1);
  }
}

async function cleanupOldBackups() {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM storage.objects 
       WHERE bucket_id = 'backups' 
         AND created_at < NOW() - INTERVAL '7 days'`
    );

    for (const r of rows) {
      await diskAdapter.remove('backups', r.name);
      await pool.query('DELETE FROM storage.objects WHERE id = $1', [r.id]);
      console.log(`🗑️  Deleted old backup: ${r.name}`);
    }
  } catch (err) {
    console.warn('⚠️  Cleanup error:', err.message);
  }
}

backup();