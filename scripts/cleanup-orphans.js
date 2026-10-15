// ═══════════════════════════════════════════════════════════
//  🧹 Cleanup Job — حذف القيود القديمة للعملاء/الموردين المحذوفين
//  ⚠️ شغّله شهرياً أو سنوياً
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const pool = require('../src/db');

const RETENTION_YEARS = 7;   // احتفظ 7 سنوات (متوافق قانونياً)
const BATCH_SIZE = 1000;

async function cleanupOrphans() {
  console.log('\n🧹 Starting orphan cleanup...\n');

  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - RETENTION_YEARS);

  let totalDeleted = 0;

  try {
    // ─── 1. ابحث عن عملاء محذوفين منذ RETENTION_YEARS ───
    const { rows: oldCustomers } = await pool.query(
      `SELECT id FROM customers
       WHERE is_active = false
         AND deleted_at IS NOT NULL
         AND deleted_at < $1`,
      [cutoffDate]
    );

    console.log(`📋 Found ${oldCustomers.length} old customers to cleanup`);

    // ─── 2. احذف قيودهم على دفعات ───
    for (let i = 0; i < oldCustomers.length; i += BATCH_SIZE) {
      const batch = oldCustomers.slice(i, i + BATCH_SIZE);
      const ids = batch.map((c) => c.id);

      const result = await pool.query(
        `DELETE FROM ledger_entries
         WHERE account_type = 'customer'
           AND account_id = ANY($1::uuid[])`,
        [ids]
      );

      totalDeleted += result.rowCount;
      console.log(`  ✅ Deleted ${result.rowCount} customer entries`);
    }

    // ─── 3. نفس الشيء للموردين ───
    const { rows: oldSuppliers } = await pool.query(
      `SELECT id FROM suppliers
       WHERE is_active = false
         AND deleted_at IS NOT NULL
         AND deleted_at < $1`,
      [cutoffDate]
    );

    console.log(`📋 Found ${oldSuppliers.length} old suppliers to cleanup`);

    for (let i = 0; i < oldSuppliers.length; i += BATCH_SIZE) {
      const batch = oldSuppliers.slice(i, i + BATCH_SIZE);
      const ids = batch.map((s) => s.id);

      const result = await pool.query(
        `DELETE FROM ledger_entries
         WHERE account_type = 'supplier'
           AND account_id = ANY($1::uuid[])`,
        [ids]
      );

      totalDeleted += result.rowCount;
      console.log(`  ✅ Deleted ${result.rowCount} supplier entries`);
    }

    // ─── 4. احذف السجلات الفعلية ───
    await pool.query(
      `DELETE FROM customers
       WHERE is_active = false
         AND deleted_at IS NOT NULL
         AND deleted_at < $1`,
      [cutoffDate]
    );

    await pool.query(
      `DELETE FROM suppliers
       WHERE is_active = false
         AND deleted_at IS NOT NULL
         AND deleted_at < $1`,
      [cutoffDate]
    );

    console.log(`\n✅ Total deleted: ${totalDeleted} ledger entries\n`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Cleanup failed:', err.message);
    process.exit(1);
  }
}

cleanupOrphans();