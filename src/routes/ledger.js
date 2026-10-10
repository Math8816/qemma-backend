// ═══════════════════════════════════════════════
//  src/routes/ledger.js
//  دفتر الأستاذ — Ledger API
//  ✅ يتوافق مع RLS Policy الموجودة
//  ✅ يُدرج قيود + يُحدّث cache الأرصدة
//  ✅ يدعم: void-invoice, expense, accounts, delete
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  🧮 Helper: حساب رصيد حساب من ledger_entries
// ═══════════════════════════════════════════════
async function calculateBalance(user, tenantId, accountId, accountType) {
  const result = await queryAsUser(
    user,
    `SELECT 
       COALESCE(SUM(debit), 0)::numeric AS total_debit,
       COALESCE(SUM(credit), 0)::numeric AS total_credit
     FROM ledger_entries
     WHERE tenant_id = $1
       AND account_id = $2
       AND account_type = $3`,
    [tenantId, accountId, accountType]
  );

  const row = result.rows[0] || { total_debit: 0, total_credit: 0 };
  const totalDebit = Number(row.total_debit) || 0;
  const totalCredit = Number(row.total_credit) || 0;

  let balance;
  if (accountType === 'customer') {
    balance = totalDebit - totalCredit;
  } else if (accountType === 'supplier') {
    balance = totalCredit - totalDebit;
  } else {
    balance = totalDebit - totalCredit;
  }

  return { balance, totalDebit, totalCredit };
}

// ═══════════════════════════════════════════════
//  🔄 Helper: تحديث cache الرصيد في customers/suppliers
// ═══════════════════════════════════════════════
async function refreshAccountCache(user, tenantId, accountId, accountType) {
  try {
    const { balance } = await calculateBalance(user, tenantId, accountId, accountType);

    const table = accountType === 'customer' ? 'customers' : 'suppliers';
    if (accountType !== 'customer' && accountType !== 'supplier') {
      return { success: true, balance };
    }

    await queryAsUser(
      user,
      `UPDATE ${table}
       SET balance = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [balance, accountId, tenantId]
    );

    return { success: true, balance };
  } catch (err) {
    console.error('⚠️ refreshAccountCache error:', err.message);
    return { success: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════
//  🧮 Helper: تحديث cache رصيد (عبر client — للـ transaction)
// ═══════════════════════════════════════════════
async function refreshBalanceCache(client, user, tenantId, accountId, accountType) {
  const table = accountType === 'customer' ? 'customers' : 'suppliers';
  if (!['customer', 'supplier'].includes(accountType)) return;

  const sign = accountType === 'customer'
    ? 'debit - credit'
    : 'credit - debit';

  await client.query(
    `UPDATE ${table}
     SET balance = COALESCE(
       (SELECT COALESCE(SUM(${sign}), 0)
        FROM ledger_entries
        WHERE tenant_id = $1 AND account_id = $2 AND account_type = $3),
       0
     ), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $1`,
    [tenantId, accountId, accountType]
  );
}

// ═══════════════════════════════════════════════
//  🔒 Helper: التحقق من قفل الفترة
// ═══════════════════════════════════════════════
async function checkPeriodLock(user, tenantId, entryDate) {
  const result = await queryAsUser(
    user,
    `SELECT id, period_start, period_end, status
     FROM accounting_periods
     WHERE tenant_id = $1
       AND period_start <= $2
       AND period_end >= $2
       AND status IN ('closed', 'locked')
     LIMIT 1`,
    [tenantId, entryDate]
  );

  return result.rows[0] || null;
}

// ═══════════════════════════════════════════════
//  GET /api/ledger/rls/list — قائمة القيود
// ═══════════════════════════════════════════════
router.get('/rls/list', optionalAuth, async (req, res) => {
  try {
    const user = req.user || { sub: null };
    const {
      entry_type,
      account_type,
      account_id,
      start_date,
      end_date,
      limit = 200,
    } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (entry_type) {
      params.push(entry_type);
      whereClause += ` AND entry_type = $${params.length}`;
    }
    if (account_type) {
      params.push(account_type);
      whereClause += ` AND account_type = $${params.length}`;
    }
    if (account_id) {
      params.push(account_id);
      whereClause += ` AND account_id = $${params.length}`;
    }
    if (start_date) {
      params.push(start_date);
      whereClause += ` AND entry_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      whereClause += ` AND entry_date <= $${params.length}`;
    }

    params.push(Math.min(parseInt(limit) || 200, 500));

    const result = await queryAsUser(
      user,
      `SELECT *
       FROM ledger_entries
       ${whereClause}
       ORDER BY entry_date DESC, created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      ok: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    console.error('GET /ledger/rls/list error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/rls/accounts
//  ✅ customers + suppliers مع الرصيد الفعلي المحسوب
// ═══════════════════════════════════════════════
router.get('/rls/accounts', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const [customersRes, suppliersRes, balancesRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT * FROM customers WHERE tenant_id = $1 ORDER BY full_name`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT * FROM suppliers WHERE tenant_id = $1 ORDER BY name`,
        [tenantId]
      ),
      queryAsUser(
        user,
        `SELECT account_id, account_type,
                COALESCE(SUM(debit), 0)  AS total_debit,
                COALESCE(SUM(credit), 0) AS total_credit
         FROM ledger_entries
         WHERE tenant_id = $1
         GROUP BY account_id, account_type`,
        [tenantId]
      ),
    ]);

    const balanceMap = {};
    (balancesRes.rows || []).forEach((b) => {
      const k = `${b.account_type}_${b.account_id}`;
      balanceMap[k] = {
        debit: Number(b.total_debit) || 0,
        credit: Number(b.total_credit) || 0,
      };
    });

    const customers = (customersRes.rows || []).map((c) => {
      const b = balanceMap[`customer_${c.id}`] || { debit: 0, credit: 0 };
      return {
        ...c,
        name: c.full_name,
        type: 'customer',
        balance: b.debit - b.credit,
        cached_balance: c.balance,
      };
    });

    const suppliers = (suppliersRes.rows || []).map((s) => {
      const b = balanceMap[`supplier_${s.id}`] || { debit: 0, credit: 0 };
      return {
        ...s,
        type: 'supplier',
        balance: b.credit - b.debit,
        cached_balance: s.balance,
      };
    });

    res.json({
      ok: true,
      customers,
      suppliers,
      all: [...customers, ...suppliers],
    });
  } catch (err) {
    console.error('GET /ledger/rls/accounts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/rls/balance/:accountId
// ═══════════════════════════════════════════════
router.get('/rls/balance/:accountId', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { accountType = 'customer' } = req.query;
    const tenantId = user.tenant_id;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const balanceData = await calculateBalance(
      user,
      tenantId,
      req.params.accountId,
      accountType
    );

    res.json({
      ok: true,
      accountId: req.params.accountId,
      accountType,
      ...balanceData,
    });
  } catch (err) {
    console.error('GET /ledger/rls/balance error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/rls/statement/:accountId
// ═══════════════════════════════════════════════
router.get('/rls/statement/:accountId', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const { accountType = 'customer', start_date, end_date } = req.query;
    const tenantId = user.tenant_id;

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    let whereClause = 'WHERE tenant_id = $1 AND account_id = $2 AND account_type = $3';
    const params = [tenantId, req.params.accountId, accountType];

    if (start_date) {
      params.push(start_date);
      whereClause += ` AND entry_date >= $${params.length}`;
    }
    if (end_date) {
      params.push(end_date);
      whereClause += ` AND entry_date <= $${params.length}`;
    }

    const result = await queryAsUser(
      user,
      `SELECT *
       FROM ledger_entries
       ${whereClause}
       ORDER BY entry_date ASC, created_at ASC`,
      params
    );

    let runningBalance = 0;
    const statement = result.rows.map((entry) => {
      const debit = Number(entry.debit) || 0;
      const credit = Number(entry.credit) || 0;

      if (accountType === 'customer') {
        runningBalance += debit - credit;
      } else {
        runningBalance += credit - debit;
      }

      return { ...entry, running_balance: runningBalance };
    });

    const summary = statement.reduce(
      (acc, e) => {
        acc.total_debit += Number(e.debit) || 0;
        acc.total_credit += Number(e.credit) || 0;
        return acc;
      },
      { total_debit: 0, total_credit: 0 }
    );

    summary.balance = runningBalance;
    summary.entries_count = statement.length;

    res.json({
      ok: true,
      accountId: req.params.accountId,
      accountType,
      statement,
      summary,
    });
  } catch (err) {
    console.error('GET /ledger/rls/statement error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls — إدراج قيد
// ═══════════════════════════════════════════════
router.post('/rls', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      account_id,
      account_type,
      account_category,
      entry_type,
      reference_id,
      reference_number,
      debit = 0,
      credit = 0,
      description,
      entry_date,
      metadata = {},
      tax_amount = 0,
      tax_rate = 0,
      subtotal = 0,
    } = req.body;

    if (!account_type || !entry_type) {
      return res.status(400).json({
        ok: false,
        error: 'account_type and entry_type are required',
      });
    }

    if (Number(debit) <= 0 && Number(credit) <= 0) {
      return res.status(400).json({
        ok: false,
        error: 'يجب تحديد debit أو credit بقيمة موجبة',
      });
    }

    if (Number(debit) > 0 && Number(credit) > 0) {
      return res.status(400).json({
        ok: false,
        error: 'لا يمكن تحديد debit و credit معاً',
      });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;
    const finalDate = entry_date || new Date().toISOString().split('T')[0];

    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required in token' });
    }

    const lockedPeriod = await checkPeriodLock(user, tenantId, finalDate);
    if (lockedPeriod) {
      return res.status(409).json({
        ok: false,
        error: 'LOCKED_PERIOD',
        message: `الفترة من ${lockedPeriod.period_start} إلى ${lockedPeriod.period_end} مقفولة`,
      });
    }

    const result = await queryAsUser(
      user,
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type, account_category,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata,
         tax_amount, tax_rate, subtotal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        tenantId,
        organizationId,
        account_id || null,
        account_type,
        account_category || null,
        entry_type,
        reference_id || null,
        reference_number || null,
        Number(debit) || 0,
        Number(credit) || 0,
        description || null,
        finalDate,
        JSON.stringify(metadata),
        Number(tax_amount) || 0,
        Number(tax_rate) || 0,
        Number(subtotal) || 0,
      ]
    );

    const entry = result.rows[0];

    await req.audit({
      action: 'create',
      tableName: 'ledger_entries',
      recordId: entry.id,
      newData: entry,
    });

    let cacheUpdate = null;
    if (account_id && ['customer', 'supplier'].includes(account_type)) {
      cacheUpdate = await refreshAccountCache(user, tenantId, account_id, account_type);
    }

    res.status(201).json({
      ok: true,
      data: entry,
      cache: cacheUpdate,
    });
  } catch (err) {
    console.error('POST /ledger/rls error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/record-invoice — قيد فاتورة
// ═══════════════════════════════════════════════
router.post('/rls/record-invoice', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      accountId,
      accountType,
      invoiceId,
      invoiceNumber,
      total,
      subtotal = 0,
      taxAmount = 0,
      taxRate = 0,
      description,
      entryDate,
    } = req.body;

    if (!accountId || !accountType || !total) {
      return res.status(400).json({
        ok: false,
        error: 'accountId, accountType, total are required',
      });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;
    const finalDate = entryDate || new Date().toISOString().split('T')[0];

    const isCustomer = accountType === 'customer';

    const result = await queryAsUser(
      user,
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata,
         tax_amount, tax_rate, subtotal)
       VALUES ($1, $2, $3, $4, 'invoice', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        tenantId,
        organizationId,
        accountId,
        accountType,
        invoiceId || null,
        invoiceNumber || null,
        isCustomer ? Number(total) : 0,
        isCustomer ? 0 : Number(total),
        description || `${isCustomer ? 'فاتورة مبيعات' : 'فاتورة مشتريات'} ${invoiceNumber || ''}`,
        finalDate,
        JSON.stringify({
          invoice_number: invoiceNumber,
          subtotal,
          tax_amount: taxAmount,
          tax_rate: taxRate,
        }),
        Number(taxAmount) || 0,
        Number(taxRate) || 0,
        Number(subtotal) || 0,
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'ledger_entries',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    const cacheUpdate = await refreshAccountCache(user, tenantId, accountId, accountType);

    res.status(201).json({
      ok: true,
      data: result.rows[0],
      cache: cacheUpdate,
    });
  } catch (err) {
    console.error('POST /ledger/rls/record-invoice error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/record-payment — قيد دفعة
// ═══════════════════════════════════════════════
router.post('/rls/record-payment', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      accountId,
      accountType,
      amount,
      paymentType,
      notes,
      invoiceId,
      invoiceNumber,
      invoiceType,
      entryDate,
    } = req.body;

    if (!accountId || !accountType || !amount) {
      return res.status(400).json({
        ok: false,
        error: 'accountId, accountType, amount are required',
      });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;
    const finalDate = entryDate || new Date().toISOString().split('T')[0];

    const isCustomer = accountType === 'customer';

    const result = await queryAsUser(
      user,
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata)
       VALUES ($1, $2, $3, $4, 'payment', $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        tenantId,
        organizationId,
        accountId,
        accountType,
        invoiceId || null,
        invoiceNumber || null,
        isCustomer ? 0 : Number(amount),
        isCustomer ? Number(amount) : 0,
        notes || (isCustomer ? 'استلام من عميل' : 'دفع لمورد'),
        finalDate,
        JSON.stringify({
          payment_type: paymentType || 'cash',
          invoice_id: invoiceId || null,
          invoice_number: invoiceNumber || null,
          invoice_type: invoiceType || null,
        }),
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'ledger_entries',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    const cacheUpdate = await refreshAccountCache(user, tenantId, accountId, accountType);

    res.status(201).json({
      ok: true,
      data: result.rows[0],
      cache: cacheUpdate,
    });
  } catch (err) {
    console.error('POST /ledger/rls/record-payment error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/record-return — قيد مرتجع
// ═══════════════════════════════════════════════
router.post('/rls/record-return', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const {
      accountId,
      accountType,
      returnId,
      returnNumber,
      total,
      returnType,
      description,
      entryDate,
    } = req.body;

    if (!accountId || !accountType || !total) {
      return res.status(400).json({
        ok: false,
        error: 'accountId, accountType, total are required',
      });
    }

    const tenantId = user.tenant_id;
    const organizationId = user.organization_id || null;
    const finalDate = entryDate || new Date().toISOString().split('T')[0];

    const isCustomer = accountType === 'customer';

    const result = await queryAsUser(
      user,
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata)
       VALUES ($1, $2, $3, $4, 'return', $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        tenantId,
        organizationId,
        accountId,
        accountType,
        returnId || null,
        returnNumber || null,
        isCustomer ? 0 : Number(total),
        isCustomer ? Number(total) : 0,
        description || `${isCustomer ? 'مرتجع مبيعات' : 'مرتجع مشتريات'} ${returnNumber || ''}`,
        finalDate,
        JSON.stringify({ return_type: returnType || (isCustomer ? 'sales_return' : 'purchase_return') }),
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'ledger_entries',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    const cacheUpdate = await refreshAccountCache(user, tenantId, accountId, accountType);

    res.status(201).json({
      ok: true,
      data: result.rows[0],
      cache: cacheUpdate,
    });
  } catch (err) {
    console.error('POST /ledger/rls/record-return error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/void-invoice
//  ✅ إلغاء فاتورة (قيد عكسي + إرجاع مخزون + تحديث حالة)
// ═══════════════════════════════════════════════
router.post('/rls/void-invoice', optionalAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = req.user;
    if (!user || !user.sub) {
      client.release();
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      client.release();
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const {
      invoiceId, invoiceNumber, customerId,
      total, reason, entryDate,
    } = req.body;

    if (!reason || reason.trim().length < 5) {
      client.release();
      return res.status(400).json({ ok: false, error: 'REASON_REQUIRED' });
    }
    if (!invoiceId || !customerId || !total) {
      client.release();
      return res.status(400).json({
        ok: false,
        error: 'invoiceId, customerId, total are required',
      });
    }

    const finalDate = entryDate || new Date().toISOString().split('T')[0];

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // 1. التحقق من قفل الفترة
    const lockRes = await client.query(
      `SELECT id FROM accounting_periods
       WHERE tenant_id = $1
         AND period_start <= $2
         AND period_end >= $2
         AND status IN ('closed', 'locked')
       LIMIT 1`,
      [tenantId, finalDate]
    );
    if (lockRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'LOCKED_PERIOD' });
    }

    // 2. جلب أصناف الفاتورة
    const itemsRes = await client.query(
      `SELECT * FROM sales_invoice_items WHERE invoice_id = $1`,
      [invoiceId]
    );

    // 3. قيد عكسي (credit على العميل)
    await client.query(
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata)
       VALUES ($1, $2, $3, 'customer', 'return', $4, $5,
               0, $6, $7, $8, $9)`,
      [
        tenantId,
        user.organization_id || null,
        customerId,
        invoiceId,
        invoiceNumber,
        Number(total),
        `إلغاء فاتورة ${invoiceNumber} — ${reason}`,
        finalDate,
        JSON.stringify({
          type: 'void',
          original_invoice: invoiceNumber,
          reason,
          voided_by: user.email,
        }),
      ]
    );

    // 4. إرجاع المخزون
    for (const item of itemsRes.rows) {
      if (!item.product_id || !item.unit_id) continue;

      const stockRes = await client.query(
        `SELECT id, quantity FROM stock
         WHERE tenant_id = $1 AND product_id = $2 AND unit_id = $3`,
        [tenantId, item.product_id, item.unit_id]
      );

      let prevQty = 0;
      let newQty = 0;

      if (stockRes.rows.length > 0) {
        prevQty = Number(stockRes.rows[0].quantity) || 0;
        newQty = prevQty + Number(item.quantity);
        await client.query(
          `UPDATE stock SET quantity = $1, updated_at = NOW() WHERE id = $2`,
          [newQty, stockRes.rows[0].id]
        );
      } else {
        newQty = Number(item.quantity);
        await client.query(
          `INSERT INTO stock
            (tenant_id, organization_id, product_id, unit_id, quantity, min_quantity)
           VALUES ($1, $2, $3, $4, $5, 0)`,
          [tenantId, user.organization_id || null, item.product_id, item.unit_id, newQty]
        );
      }

      await client.query(
        `INSERT INTO inventory_log
          (tenant_id, organization_id, product_id, product_name, unit_id,
           change_amount, previous_qty, new_qty, entry_type, reason,
           reference_id, reference_number, unit_cost, total_value,
           created_by, date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'void_sale',$9,$10,$11,$12,$13,$14,$15)`,
        [
          tenantId,
          user.organization_id || null,
          item.product_id,
          item.product_name || null,
          item.unit_id,
          Number(item.quantity),
          prevQty,
          newQty,
          `إلغاء فاتورة ${invoiceNumber}`,
          invoiceId,
          invoiceNumber,
          Number(item.price || 0),
          Number(item.quantity) * Number(item.price || 0),
          user.sub,
          finalDate,
        ]
      );
    }

    // 5. تحديث حالة الفاتورة
    await client.query(
      `UPDATE sales_invoices
       SET status = 'cancelled',
           remaining = 0,
           notes = COALESCE(notes, '') || ' [ملغاة]',
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );

    // 6. تحديث cache الرصيد
    await refreshBalanceCache(client, user, tenantId, customerId, 'customer');

    await client.query('COMMIT');

    await req.audit({
      action: 'void',
      tableName: 'ledger_entries',
      recordId: invoiceId,
      newData: { invoiceNumber, reason, total },
    });

    res.json({ ok: true, invoiceId, voided: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /ledger/rls/void-invoice error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/expense — قيد مصروف
// ═══════════════════════════════════════════════
router.post('/rls/expense', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const {
      entryId, entryType, amount,
      description, entryDate, metadata = {},
    } = req.body;

    if (!entryId) {
      return res.status(400).json({ ok: false, error: 'entryId is required' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ ok: false, error: 'amount must be > 0' });
    }

    const finalDate = entryDate || new Date().toISOString().split('T')[0];
    const referenceNumber = `EXP-${String(entryType || 'GEN').toUpperCase()}-${Date.now()
      .toString()
      .slice(-6)}`;

    const result = await queryAsUser(
      user,
      `INSERT INTO ledger_entries
        (tenant_id, organization_id, account_id, account_type,
         entry_type, reference_id, reference_number,
         debit, credit, description, entry_date, metadata)
       VALUES ($1, $2, NULL, 'expense', 'expense', $3, $4,
               $5, 0, $6, $7, $8)
       RETURNING *`,
      [
        tenantId,
        user.organization_id || null,
        entryId,
        referenceNumber,
        Number(amount),
        description || null,
        finalDate,
        JSON.stringify({ expense_type: entryType, ...metadata }),
      ]
    );

    await req.audit({
      action: 'create',
      tableName: 'ledger_entries',
      recordId: result.rows[0].id,
      newData: result.rows[0],
    });

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('POST /ledger/rls/expense error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  DELETE /api/ledger/rls/:id — حذف قيد
// ═══════════════════════════════════════════════
router.delete('/rls/:id', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const tenantId = user.tenant_id;

    const fetchRes = await queryAsUser(
      user,
      `SELECT id, account_id, account_type, is_locked
       FROM ledger_entries
       WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (fetchRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Entry not found or access denied' });
    }

    const entry = fetchRes.rows[0];

    if (entry.is_locked) {
      return res.status(409).json({ ok: false, error: 'LOCKED_PERIOD' });
    }

    await queryAsUser(
      user,
      `DELETE FROM ledger_entries WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (entry.account_id && ['customer', 'supplier'].includes(entry.account_type)) {
      await refreshAccountCache(user, tenantId, entry.account_id, entry.account_type);
    }

    await req.audit({
      action: 'delete',
      tableName: 'ledger_entries',
      recordId: req.params.id,
      oldData: entry,
    });

    res.json({ ok: true, deleted_id: req.params.id });
  } catch (err) {
    console.error('DELETE /ledger/rls/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  POST /api/ledger/rls/recalc-all — إعادة حساب كل الأرصدة
// ═══════════════════════════════════════════════
router.post('/rls/recalc-all', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.sub) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }

    const tenantId = user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: 'tenant_id required' });
    }

    const [customersRes, suppliersRes] = await Promise.all([
      queryAsUser(user, `SELECT id FROM customers WHERE tenant_id = $1`, [tenantId]),
      queryAsUser(user, `SELECT id FROM suppliers WHERE tenant_id = $1`, [tenantId]),
    ]);

    let processed = 0;
    let errors = 0;

    for (const c of customersRes.rows || []) {
      const r = await refreshAccountCache(user, tenantId, c.id, 'customer');
      r.success ? processed++ : errors++;
    }
    for (const s of suppliersRes.rows || []) {
      const r = await refreshAccountCache(user, tenantId, s.id, 'supplier');
      r.success ? processed++ : errors++;
    }

    res.json({
      ok: true,
      processed,
      errors,
      message: `تم تحديث ${processed} حساب`,
    });
  } catch (err) {
    console.error('POST /ledger/rls/recalc-all error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;