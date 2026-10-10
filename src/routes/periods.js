// ═══════════════════════════════════════════════
//  src/routes/periods.js
//  الفترات المحاسبية — 9 endpoints
//  ✅ يتوافق مع periodService.js (frontend)
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  🧮 Helper: حساب snapshot للفترة
// ═══════════════════════════════════════════════
async function calculatePeriodSnapshot(user, tenantId, startDate, endDate) {
  // أ. الرصيد الافتتاحي (قبل بداية الفترة)
  const priorRes = await queryAsUser(
    user,
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total_debit,
            COALESCE(SUM(credit), 0)::numeric AS total_credit
     FROM ledger_entries
     WHERE tenant_id = $1 AND entry_date < $2`,
    [tenantId, startDate]
  );

  const priorDebit = Number(priorRes.rows[0]?.total_debit) || 0;
  const priorCredit = Number(priorRes.rows[0]?.total_credit) || 0;
  const openingBalance = priorDebit - priorCredit;

  // ب. حركات الفترة
  const periodRes = await queryAsUser(
    user,
    `SELECT entry_type, account_type,
            COALESCE(debit, 0)::numeric AS debit,
            COALESCE(credit, 0)::numeric AS credit
     FROM ledger_entries
     WHERE tenant_id = $1
       AND entry_date >= $2 AND entry_date <= $3`,
    [tenantId, startDate, endDate]
  );

  let totalSales = 0, totalPurchases = 0, totalReturns = 0, totalExpenses = 0;
  let invoicesCount = 0, paymentsCount = 0, returnsCount = 0;
  let periodDebit = 0, periodCredit = 0;

  (periodRes.rows || []).forEach((e) => {
    const amount = Number(e.debit) || Number(e.credit) || 0;
    periodDebit += Number(e.debit) || 0;
    periodCredit += Number(e.credit) || 0;

    if (e.entry_type === 'invoice') {
      invoicesCount++;
      if (e.account_type === 'customer') totalSales += amount;
      if (e.account_type === 'supplier') totalPurchases += amount;
    }
    if (e.entry_type === 'payment') paymentsCount++;
    if (e.entry_type === 'return') {
      returnsCount++;
      totalReturns += amount;
    }
    if (e.account_type === 'expense') totalExpenses += amount;
  });

  const closingBalance = openingBalance + (periodDebit - periodCredit);
  const totalProfit = totalSales - totalPurchases - totalExpenses;

  return {
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    total_sales: totalSales,
    total_purchases: totalPurchases,
    total_returns: totalReturns,
    total_expenses: totalExpenses,
    total_profit: totalProfit,
    total_entries: periodRes.rows.length,
    invoices_count: invoicesCount,
    payments_count: paymentsCount,
    returns_count: returnsCount,
  };
}

// ═══════════════════════════════════════════════
//  GET /api/periods/rls/list — قائمة الفترات
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { status, year } = req.query;

    let where = 'WHERE tenant_id = $1';
    const params = [tenantId];

    if (status) {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    if (year) {
      params.push(parseInt(year));
      where += ` AND fiscal_year = $${params.length}`;
    }

    const result = await queryAsUser(
      user,
      `SELECT * FROM accounting_periods
       ${where}
       ORDER BY period_start DESC`,
      params
    );

    res.json({
      ok: true,
      success: true,
      count: result.rows.length,
      periods: result.rows,
    });
  } catch (err) {
    console.error('GET /periods/rls/list error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message, periods: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/periods/rls/:id
// ═══════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;

    const result = await queryAsUser(
      user,
      `SELECT * FROM accounting_periods WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Period not found or access denied' });
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('GET /periods/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/periods/rls/:id/history
// ═══════════════════════════════════════════════
router.get('/rls/:id/history', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;

    const result = await queryAsUser(
      user,
      `SELECT * FROM period_closing_log
       WHERE period_id = $1 AND tenant_id = $2
       ORDER BY action_at DESC`,
      [req.params.id, tenantId]
    );

    res.json({ ok: true, success: true, log: result.rows });
  } catch (err) {
    console.error('GET /periods/rls/:id/history error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message, log: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/periods/rls/check-lock
//  ✅ فحص إذا كان تاريخ معين مقفولاً
// ═══════════════════════════════════════════════
router.get('/rls/check-lock', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ ok: false, error: 'date query param required' });
    }

    const result = await queryAsUser(
      user,
      `SELECT id, period_start, period_end, status
       FROM accounting_periods
       WHERE tenant_id = $1
         AND period_start <= $2
         AND period_end >= $2
         AND status IN ('closed', 'locked')
       LIMIT 1`,
      [tenantId, date]
    );

    res.json({
      ok: true,
      success: true,
      isLocked: result.rows.length > 0,
      period: result.rows[0] || null,
    });
  } catch (err) {
    console.error('GET /periods/rls/check-lock error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message, isLocked: false });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/periods/rls — إنشاء فترة جديدة
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const {
      periodType = 'month',
      periodStart,
      periodEnd,
      fiscalYear,
    } = req.body;

    if (!periodStart || !periodEnd) {
      return res.status(400).json({ ok: false, error: 'periodStart and periodEnd required' });
    }

    // تحقق من عدم وجود تعارض
    const dupRes = await queryAsUser(
      user,
      `SELECT id FROM accounting_periods
       WHERE tenant_id = $1
         AND period_type = $2
         AND period_start = $3
         AND period_end = $4
       LIMIT 1`,
      [tenantId, periodType, periodStart, periodEnd]
    );

    if (dupRes.rows.length > 0) {
      return res.status(409).json({ ok: false, error: 'PERIOD_ALREADY_EXISTS' });
    }

    const result = await queryAsUser(
      user,
      `INSERT INTO accounting_periods
        (tenant_id, organization_id, period_type, period_start, period_end,
         fiscal_year, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')
       RETURNING *`,
      [
        tenantId,
        organizationId,
        periodType,
        periodStart,
        periodEnd,
        fiscalYear || new Date(periodStart).getFullYear(),
      ]
    );

    const period = result.rows[0];

    // سجل
    await queryAsUser(
      user,
      `INSERT INTO period_closing_log
        (tenant_id, period_id, action, action_by, action_by_name, snapshot)
       VALUES ($1, $2, 'create', $3, $4, '{}'::jsonb)`,
      [tenantId, period.id, user.sub, user.email || null]
    );

    await req.audit({
      action: 'create',
      tableName: 'accounting_periods',
      recordId: period.id,
      newData: period,
    });

    res.status(201).json({ ok: true, success: true, period });
  } catch (err) {
    console.error('POST /periods/rls error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/periods/rls/:id/close — إقفال فترة
// ═══════════════════════════════════════════════
router.post('/rls/:id/close', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user?.sub) {
      client.release();
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      client.release();
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const { notes = '' } = req.body;

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // 1. جلب الفترة
    const periodRes = await client.query(
      `SELECT * FROM accounting_periods
       WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (periodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'PERIOD_NOT_FOUND' });
    }

    const period = periodRes.rows[0];
    if (period.status === 'closed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'ALREADY_CLOSED' });
    }
    if (period.status === 'locked') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'ALREADY_LOCKED' });
    }

    // 2. حساب snapshot
    const snapshot = await calculatePeriodSnapshot(
      user,
      tenantId,
      period.period_start,
      period.period_end
    );

    // 3. قفل الحركات
    await client.query(
      `UPDATE ledger_entries
       SET is_locked = true,
           locked_at = NOW(),
           period_id = $1
       WHERE tenant_id = $2
         AND entry_date >= $3
         AND entry_date <= $4
         AND is_locked = false`,
      [req.params.id, tenantId, period.period_start, period.period_end]
    );

    // 4. تحديث الفترة
    await client.query(
      `UPDATE accounting_periods
       SET status = 'closed',
           closed_at = NOW(),
           closed_by = $1,
           closed_by_name = $2,
           closed_notes = $3,
           opening_balance = $4,
           closing_balance = $5,
           total_sales = $6,
           total_purchases = $7,
           total_returns = $8,
           total_expenses = $9,
           total_profit = $10,
           total_entries = $11,
           invoices_count = $12,
           payments_count = $13,
           returns_count = $14,
           updated_at = NOW()
       WHERE id = $15`,
      [
        user.sub,
        user.email || null,
        notes,
        snapshot.opening_balance,
        snapshot.closing_balance,
        snapshot.total_sales,
        snapshot.total_purchases,
        snapshot.total_returns,
        snapshot.total_expenses,
        snapshot.total_profit,
        snapshot.total_entries,
        snapshot.invoices_count,
        snapshot.payments_count,
        snapshot.returns_count,
        req.params.id,
      ]
    );

    // 5. سجل
    await client.query(
      `INSERT INTO period_closing_log
        (tenant_id, period_id, action, action_by, action_by_name, snapshot, reason)
       VALUES ($1, $2, 'close', $3, $4, $5, $6)`,
      [tenantId, req.params.id, user.sub, user.email || null, JSON.stringify(snapshot), notes]
    );

    await client.query('COMMIT');

    await req.audit({
      action: 'close',
      tableName: 'accounting_periods',
      recordId: req.params.id,
      newData: snapshot,
    });

    res.json({ ok: true, success: true, snapshot });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /periods/rls/:id/close error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  POST /api/periods/rls/:id/reopen — إعادة فتح
// ═══════════════════════════════════════════════
router.post('/rls/:id/reopen', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user?.sub) {
      client.release();
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;

    const { reason } = req.body;
    if (!reason || reason.trim().length < 10) {
      client.release();
      return res.status(400).json({ ok: false, error: 'REASON_REQUIRED' });
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    const periodRes = await client.query(
      `SELECT * FROM accounting_periods WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (periodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'PERIOD_NOT_FOUND' });
    }

    const period = periodRes.rows[0];
    if (period.status === 'locked') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'ALREADY_LOCKED' });
    }
    if (period.status === 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'ALREADY_OPEN' });
    }

    // فك قفل الحركات
    await client.query(
      `UPDATE ledger_entries
       SET is_locked = false, locked_at = NULL
       WHERE tenant_id = $1 AND period_id = $2`,
      [tenantId, req.params.id]
    );

    // تحديث الفترة
    await client.query(
      `UPDATE accounting_periods
       SET status = 'open',
           reopened_at = NOW(),
           reopened_by = $1,
           reopen_reason = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [user.sub, reason, req.params.id]
    );

    // سجل
    await client.query(
      `INSERT INTO period_closing_log
        (tenant_id, period_id, action, action_by, action_by_name, reason)
       VALUES ($1, $2, 'reopen', $3, $4, $5)`,
      [tenantId, req.params.id, user.sub, user.email || null, reason]
    );

    await client.query('COMMIT');

    await req.audit({
      action: 'reopen',
      tableName: 'accounting_periods',
      recordId: req.params.id,
      newData: { reason },
    });

    res.json({ ok: true, success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /periods/rls/:id/reopen error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  POST /api/periods/rls/:id/lock — قفل نهائي
// ═══════════════════════════════════════════════
router.post('/rls/:id/lock', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;

    const periodRes = await queryAsUser(
      user,
      `SELECT * FROM accounting_periods WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (periodRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'PERIOD_NOT_FOUND' });
    }

    if (periodRes.rows[0].status === 'locked') {
      return res.status(409).json({ ok: false, error: 'ALREADY_LOCKED' });
    }

    await queryAsUser(
      user,
      `UPDATE accounting_periods
       SET status = 'locked',
           locked_at = NOW(),
           locked_by = $1,
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [user.sub, req.params.id, tenantId]
    );

    await queryAsUser(
      user,
      `INSERT INTO period_closing_log
        (tenant_id, period_id, action, action_by, action_by_name, snapshot)
       VALUES ($1, $2, 'lock', $3, $4, '{}'::jsonb)`,
      [tenantId, req.params.id, user.sub, user.email || null]
    );

    await req.audit({
      action: 'lock',
      tableName: 'accounting_periods',
      recordId: req.params.id,
    });

    res.json({ ok: true, success: true });
  } catch (err) {
    console.error('POST /periods/rls/:id/lock error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

module.exports = router;