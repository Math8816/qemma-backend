// ═══════════════════════════════════════════════════════════════════
//  src/routes/expenses.js
//  💸 Expenses — سجلات المصاريف (Backend Service)
//  ✅ Transaction لكل عملية (Ledger + Expense + Payment)
//  ✅ Period Lock check (بدل Trigger)
//  ✅ Idempotency على POST
//  ✅ Soft Delete + Reversal Entry
//  ✅ JOINs مع users + operating_expenses
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { idempotencyMiddleware } = require('../middleware/idempotency');

const router = express.Router();
router.use(auditMiddleware);


// ═══════════════════════════════════════════════════════════════════
//  🧩 Helpers
// ═══════════════════════════════════════════════════════════════════

function requireAuth(req, res) {
  if (!req.user?.sub) {
    res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    return false;
  }
  if (!req.user.tenant_id) {
    res.status(400).json({ ok: false, error: 'TENANT_REQUIRED' });
    return false;
  }
  return true;
}

/**
 * 🔒 فحص قفل الفترة المحاسبية
 * يستخدم بدلاً من DB Trigger
 */
async function checkPeriodLock(client, tenantId, expenseDate) {
  const { rows } = await client.query(
    `SELECT id, period_start, period_end, status
     FROM accounting_periods
     WHERE tenant_id = $1
       AND $2::date BETWEEN period_start AND period_end
       AND status IN ('closed', 'locked')
     LIMIT 1`,
    [tenantId, expenseDate]
  );

  if (rows.length > 0) {
    const p = rows[0];
    const err = new Error(
      `الفترة من ${p.period_start} إلى ${p.period_end} مقفولة (${p.status})`
    );
    err.statusCode = 409;
    err.code = 'PERIOD_LOCKED';
    err.details = p;
    throw err;
  }
}

/**
 * 📒 إدراج قيد محاسبي (expense)
 * debit/credit على حساب expense
 */
async function insertExpenseLedger(client, {
  tenantId,
  organizationId,
  expenseId,
  entryId,
  entryType,
  amount,
  description,
  entryDate,
  metadata = {},
}) {
  if (Number(amount) <= 0) return null;

  const result = await client.query(
    `INSERT INTO ledger_entries
      (tenant_id, organization_id, account_id, account_type,
       entry_type, reference_id, reference_number,
       debit, credit, description, entry_date, metadata)
     VALUES ($1, $2, $3, 'expense', 'expense', $4, $5,
             $6, 0, $7, $8, $9)
     RETURNING *`,
    [
      tenantId,
      organizationId,
      expenseId,
      entryId,
      `EXP-${entryType}-${Date.now().toString().slice(-6)}`,
      Number(amount),
      description,
      entryDate,
      JSON.stringify({ expense_type: entryType, ...metadata }),
    ]
  );

  return result.rows[0];
}

/**
 * 🔄 تحديث ledger_entry_id في سجل المصروف
 */
async function linkLedgerEntry(client, expenseId, ledgerEntryId) {
  await client.query(
    `UPDATE operating_expense_entries
     SET ledger_entry_id = $1, updated_at = NOW()
     WHERE id = $2`,
    [ledgerEntryId, expenseId]
  );
}

/**
 * 🎯 تحديد account_type من entry_type
 */
function getAccountTypeFromEntryType(entryType) {
  const map = {
    salary: 'expense',
    rent: 'expense',
    utility: 'expense',
    maintenance: 'expense',
    other: 'expense',
  };
  return map[entryType] || 'expense';
}


// ═══════════════════════════════════════════════════════════════════
//  GET /api/expenses/rls/list
//  قائمة سجلات المصاريف (مع JOINs)
// ═══════════════════════════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const tenantId = req.user.tenant_id;
    const {
      entry_type,
      payment_status,
      month,
      start_date,
      end_date,
      search,
      limit = 100,
      page = 1,
    } = req.query;

    const finalLimit = Math.min(parseInt(limit) || 100, 500);
    const finalPage = Math.max(1, parseInt(page) || 1);
    const offset = (finalPage - 1) * finalLimit;

    let where = 'WHERE e.tenant_id = $1 AND e.deleted_at IS NULL';
    const params = [tenantId];

    if (entry_type) {
      params.push(entry_type);
      where += ` AND e.entry_type = $${params.length}`;
    }
    if (payment_status) {
      params.push(payment_status);
      where += ` AND e.payment_status = $${params.length}`;
    }
    if (month) {
      params.push(`${month}-%`);
      where += ` AND e.expense_date::text LIKE $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      where += ` AND e.expense_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      where += ` AND e.expense_date <= $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (
        e.description ILIKE $${params.length} OR
        e.vendor_name ILIKE $${params.length} OR
        e.worker_role ILIKE $${params.length}
      )`;
    }

    // Count
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM operating_expense_entries e ${where}`,
      params
    );

    // Data
    const dataParams = [...params, finalLimit, offset];
    const { rows } = await pool.query(
      `SELECT
         e.*,
         u.full_name AS employee_name,
         oe.name AS expense_name,
         oe.color AS expense_color
       FROM operating_expense_entries e
       LEFT JOIN users u ON u.id = e.employee_id
       LEFT JOIN operating_expenses oe ON oe.id = e.expense_id
       ${where}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${dataParams.length - 1}
       OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({
      ok: true,
      count: rows.length,
      pagination: {
        page: finalPage,
        limit: finalLimit,
        total: countRes.rows[0]?.total || 0,
        pages: Math.ceil((countRes.rows[0]?.total || 0) / finalLimit),
      },
      data: rows,
    });
  } catch (err) {
    console.error('GET /expenses/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  GET /api/expenses/rls/summary
//  KPIs للفترة
// ═══════════════════════════════════════════════════════════════════
router.get('/rls/summary', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const tenantId = req.user.tenant_id;
    const { month, year } = req.query;

    const params = [tenantId];
    let where = 'WHERE tenant_id = $1 AND deleted_at IS NULL';

    if (month) {
      params.push(`${month}-%`);
      where += ` AND expense_date::text LIKE $${params.length}`;
    } else if (year) {
      params.push(`${year}-%`);
      where += ` AND expense_date::text LIKE $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COALESCE(SUM(amount), 0)::numeric AS total_amount,
         COALESCE(SUM(paid_amount), 0)::numeric AS total_paid,
         COALESCE(SUM(remaining), 0)::numeric AS total_remaining,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_count,
         COUNT(*) FILTER (WHERE payment_status = 'partial')::int AS partial_count,
         COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS pending_count
       FROM operating_expense_entries
       ${where}`,
      params
    );

    // حسب النوع
    const byTypeRes = await pool.query(
      `SELECT
         entry_type,
         COUNT(*)::int AS count,
         COALESCE(SUM(amount), 0)::numeric AS total,
         COALESCE(SUM(paid_amount), 0)::numeric AS paid,
         COALESCE(SUM(remaining), 0)::numeric AS remaining
       FROM operating_expense_entries
       ${where}
       GROUP BY entry_type
       ORDER BY total DESC`,
      params
    );

    const s = rows[0] || {};

    res.json({
      ok: true,
      kpis: {
        count: s.total_count || 0,
        total: Number(s.total_amount) || 0,
        paid: Number(s.total_paid) || 0,
        remaining: Number(s.total_remaining) || 0,
        paid_count: s.paid_count || 0,
        partial_count: s.partial_count || 0,
        pending_count: s.pending_count || 0,
      },
      by_type: byTypeRes.rows,
    });
  } catch (err) {
    console.error('GET /expenses/rls/summary error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  GET /api/expenses/rls/:id
//  تفاصيل سجل واحد
// ═══════════════════════════════════════════════════════════════════
router.get('/rls/:id', optionalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { rows } = await pool.query(
      `SELECT
         e.*,
         u.full_name AS employee_name,
         oe.name AS expense_name,
         oe.color AS expense_color
       FROM operating_expense_entries e
       LEFT JOIN users u ON u.id = e.employee_id
       LEFT JOIN operating_expenses oe ON oe.id = e.expense_id
       WHERE e.id = $1 AND e.tenant_id = $2 AND e.deleted_at IS NULL`,
      [req.params.id, req.user.tenant_id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'EXPENSE_NOT_FOUND' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /expenses/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  POST /api/expenses/rls
//  إنشاء سجل مصروف (مع Ledger atomic)
// ═══════════════════════════════════════════════════════════════════
router.post(
  '/rls',
  optionalAuth,
  idempotencyMiddleware,
  async (req, res) => {
    const client = await pool.connect();
    try {
      if (!requireAuth(req, res)) {
        client.release();
        return;
      }

      const user = req.user;
      const tenantId = user.tenant_id;
      const organizationId = user.organization_id || null;

      const {
        entry_type = 'other',
        description,
        expense_id = null,
        employee_id = null,
        worker_role = null,
        vendor_name = null,
        notes = null,
        amount,
        paid_amount = 0,
        expense_date,
        due_date = null,
        payment_method = 'cash',
      } = req.body;

      // ═══ Validation ═══
      if (!description || !description.trim()) {
        client.release();
        return res.status(400).json({
          ok: false,
          error: 'DESCRIPTION_REQUIRED',
          message: 'الوصف مطلوب',
        });
      }

      if (!amount || Number(amount) <= 0) {
        client.release();
        return res.status(400).json({
          ok: false,
          error: 'AMOUNT_REQUIRED',
          message: 'المبلغ يجب أن يكون أكبر من صفر',
        });
      }

      if (Number(paid_amount) > Number(amount)) {
        client.release();
        return res.status(400).json({
          ok: false,
          error: 'PAID_EXCEEDS_AMOUNT',
          message: 'المبلغ المدفوع لا يمكن أن يتجاوز المبلغ الإجمالي',
        });
      }

      if (entry_type === 'salary' && !employee_id) {
        client.release();
        return res.status(400).json({
          ok: false,
          error: 'EMPLOYEE_REQUIRED',
          message: 'الموظف مطلوب لمصروف الرواتب',
        });
      }

      const finalDate = expense_date || new Date().toISOString().split('T')[0];

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

      // ═══ Period Lock ═══
      await checkPeriodLock(client, tenantId, finalDate);

      // ═══ 1. Insert expense entry ═══
      const expRes = await client.query(
        `INSERT INTO operating_expense_entries
          (tenant_id, organization_id, expense_id, employee_id, worker_role,
           entry_type, description, vendor_name, notes,
           amount, paid_amount, expense_date, due_date, payment_method,
           created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          tenantId,
          organizationId,
          expense_id || null,
          employee_id || null,
          worker_role || null,
          entry_type,
          description.trim(),
          vendor_name || null,
          notes || null,
          Number(amount),
          Number(paid_amount) || 0,
          finalDate,
          due_date || null,
          payment_method,
          user.sub,
        ]
      );

      const entry = expRes.rows[0];

      // ═══ 2. Ledger — للجزء المدفوع فقط ═══
      if (Number(paid_amount) > 0) {
        const ledger = await insertExpenseLedger(client, {
          tenantId,
          organizationId,
          expenseId: expense_id,
          entryId: entry.id,
          entryType: entry_type,
          amount: paid_amount,
          description: description.trim(),
          entryDate: finalDate,
          metadata: {
            employee_id,
            worker_role,
            vendor_name,
          },
        });

        if (ledger) {
          await linkLedgerEntry(client, entry.id, ledger.id);
          entry.ledger_entry_id = ledger.id;
        }
      }

      await client.query('COMMIT');

      await req.audit({
        action: 'create',
        tableName: 'operating_expense_entries',
        recordId: entry.id,
        newData: entry,
      });

      res.status(201).json({ ok: true, data: entry });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('POST /expenses/rls error:', err.message);

      if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
        return res.status(err.statusCode).json({
          ok: false,
          error: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        });
      }

      res.status(500).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
  }
);


// ═══════════════════════════════════════════════════════════════════
//  PUT /api/expenses/rls/:id
//  تحديث سجل مصروف (مع إعادة حساب Ledger)
// ═══════════════════════════════════════════════════════════════════
router.put('/rls/:id', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!requireAuth(req, res)) {
      client.release();
      return;
    }

    const user = req.user;
    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;

    const {
      entry_type,
      description,
      expense_id,
      employee_id,
      worker_role,
      vendor_name,
      notes,
      amount,
      paid_amount,
      expense_date,
      due_date,
      payment_method,
    } = req.body;

    if (description !== undefined && (!description || !description.trim())) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: 'DESCRIPTION_REQUIRED',
        message: 'الوصف مطلوب',
      });
    }

    if (amount !== undefined && Number(amount) <= 0) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: 'AMOUNT_REQUIRED',
        message: 'المبلغ يجب أن يكون أكبر من صفر',
      });
    }

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // ═══ جلب القديم ═══
    const oldRes = await client.query(
      `SELECT * FROM operating_expense_entries
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [req.params.id, tenantId]
    );

    if (oldRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'EXPENSE_NOT_FOUND' });
    }

    const old = oldRes.rows[0];
    const finalDate = expense_date || old.expense_date;

    // ═══ Period Lock (على التاريخ القديم والجديد) ═══
    await checkPeriodLock(client, tenantId, old.expense_date);
    if (finalDate !== old.expense_date) {
      await checkPeriodLock(client, tenantId, finalDate);
    }

    // ═══ حذف القيد القديم (إن وُجد) ═══
    if (old.ledger_entry_id) {
      await client.query(
        `DELETE FROM ledger_entries WHERE id = $1 AND tenant_id = $2`,
        [old.ledger_entry_id, tenantId]
      );
    }

    // ═══ بناء UPDATE ديناميكي ═══
    const updates = [];
    const values = [];

    const addUpdate = (field, value) => {
      if (value !== undefined) {
        values.push(value);
        updates.push(`${field} = $${values.length}`);
      }
    };

    addUpdate('entry_type', entry_type);
    addUpdate('description', description?.trim());
    addUpdate('expense_id', expense_id);
    addUpdate('employee_id', employee_id);
    addUpdate('worker_role', worker_role);
    addUpdate('vendor_name', vendor_name);
    addUpdate('notes', notes);
    addUpdate('amount', amount !== undefined ? Number(amount) : undefined);
    addUpdate('paid_amount', paid_amount !== undefined ? Number(paid_amount) : undefined);
    addUpdate('expense_date', expense_date);
    addUpdate('due_date', due_date);
    addUpdate('payment_method', payment_method);

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        error: 'NO_FIELDS',
        message: 'لا توجد حقول للتحديث',
      });
    }

    updates.push(`updated_at = NOW()`);
    updates.push(`ledger_entry_id = NULL`); // سيُعاد تعيينه
    values.push(req.params.id);

    const updateRes = await client.query(
      `UPDATE operating_expense_entries
       SET ${updates.join(', ')}
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );

    const updated = updateRes.rows[0];

    // ═══ إنشاء قيد جديد للجزء المدفوع ═══
    if (Number(updated.paid_amount) > 0) {
      const ledger = await insertExpenseLedger(client, {
        tenantId,
        organizationId,
        expenseId: updated.expense_id,
        entryId: updated.id,
        entryType: updated.entry_type,
        amount: updated.paid_amount,
        description: updated.description,
        entryDate: updated.expense_date,
        metadata: {
          employee_id: updated.employee_id,
          worker_role: updated.worker_role,
          vendor_name: updated.vendor_name,
        },
      });

      if (ledger) {
        await linkLedgerEntry(client, updated.id, ledger.id);
        updated.ledger_entry_id = ledger.id;
      }
    }

    await client.query('COMMIT');

    await req.audit({
      action: 'update',
      tableName: 'operating_expense_entries',
      recordId: updated.id,
      oldData: old,
      newData: updated,
    });

    res.json({ ok: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /expenses/rls error:', err.message);

    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({
        ok: false,
        error: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      });
    }

    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});


// ═══════════════════════════════════════════════════════════════════
//  DELETE /api/expenses/rls/:id
//  Soft Delete + عكس القيد
// ═══════════════════════════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!requireAuth(req, res)) {
      client.release();
      return;
    }

    const user = req.user;
    const tenantId = user.tenant_id;

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    const oldRes = await client.query(
      `SELECT * FROM operating_expense_entries
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [req.params.id, tenantId]
    );

    if (oldRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'EXPENSE_NOT_FOUND' });
    }

    const old = oldRes.rows[0];

    // ═══ Period Lock ═══
    await checkPeriodLock(client, tenantId, old.expense_date);

    // ═══ عكس القيد (reversal) ═══
    if (old.ledger_entry_id && Number(old.paid_amount) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
          (tenant_id, organization_id, account_id, account_type,
           entry_type, reference_id, reference_number,
           debit, credit, description, entry_date, metadata)
         VALUES ($1, $2, $3, 'expense', 'adjustment', $4, $5,
                 0, $6, $7, $8, $9)`,
        [
          tenantId,
          old.organization_id,
          old.expense_id,
          old.id,
          `REVERSE-EXP-${Date.now().toString().slice(-6)}`,
          Number(old.paid_amount),
          `عكس مصروف محذوف: ${old.description}`,
          new Date().toISOString().split('T')[0],
          JSON.stringify({ reversal: true, original_amount: old.paid_amount }),
        ]
      );
    }

    // ═══ Soft Delete ═══
    const result = await client.query(
      `UPDATE operating_expense_entries
       SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3
       RETURNING *`,
      [user.sub, req.params.id, tenantId]
    );

    await client.query('COMMIT');

    await req.audit({
      action: 'soft_delete',
      tableName: 'operating_expense_entries',
      recordId: req.params.id,
      oldData: old,
    });

    res.json({ ok: true, deleted: result.rows[0], soft: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /expenses/rls error:', err.message);

    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return res.status(err.statusCode).json({
        ok: false,
        error: err.code,
        message: err.message,
      });
    }

    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});


module.exports = router;