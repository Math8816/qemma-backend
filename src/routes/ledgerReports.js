// ═══════════════════════════════════════════════
//  src/routes/ledgerReports.js
//  تقارير دفتر الأستاذ — 8 endpoints
//  ✅ يتوافق مع ledgerReports.js (frontend)
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');

const router = express.Router();
router.use(auditMiddleware);

// ═══════════════════════════════════════════════
//  📅 Helper: حساب نطاق التاريخ
// ═══════════════════════════════════════════════
function getDateRange(period = 'month', startDate = null, endDate = null) {
  if (period === 'custom' && startDate && endDate) {
    return { start: startDate, end: endDate };
  }

  const today = new Date();
  let start, end;

  switch (period) {
    case 'today': {
      const s = today.toISOString().split('T')[0];
      return { start: s, end: s };
    }
    case 'week': {
      const d = new Date(today);
      d.setDate(d.getDate() - 7);
      start = d.toISOString().split('T')[0];
      end = today.toISOString().split('T')[0];
      break;
    }
    case 'month': {
      const y = today.getFullYear();
      const m = today.getMonth();
      start = new Date(y, m, 1).toISOString().split('T')[0];
      end = new Date(y, m + 1, 0).toISOString().split('T')[0];
      break;
    }
    case 'quarter': {
      const y = today.getFullYear();
      const q = Math.floor(today.getMonth() / 3);
      start = new Date(y, q * 3, 1).toISOString().split('T')[0];
      end = new Date(y, q * 3 + 3, 0).toISOString().split('T')[0];
      break;
    }
    case 'year': {
      const y = today.getFullYear();
      start = `${y}-01-01`;
      end = `${y}-12-31`;
      break;
    }
    default: {
      start = `${today.getFullYear()}-01-01`;
      end = today.toISOString().split('T')[0];
    }
  }

  return { start, end };
}

// ═══════════════════════════════════════════════
//  Helper: استخراج parameters
// ═══════════════════════════════════════════════
function extractRange(req) {
  const {
    period = 'month',
    startDate,
    endDate,
  } = req.query;
  return getDateRange(period, startDate, endDate);
}

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/journal
//  دفتر اليومية
// ═══════════════════════════════════════════════
router.get('/journal', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);
    const { entryType, accountType, accountId } = req.query;

    let where = 'WHERE tenant_id = $1 AND entry_date >= $2 AND entry_date <= $3';
    const params = [tenantId, start, end];

    if (entryType) {
      params.push(entryType);
      where += ` AND entry_type = $${params.length}`;
    }
    if (accountType) {
      params.push(accountType);
      where += ` AND account_type = $${params.length}`;
    }
    if (accountId) {
      params.push(accountId);
      where += ` AND account_id = $${params.length}`;
    }

    const result = await queryAsUser(
      user,
      `SELECT * FROM ledger_entries ${where}
       ORDER BY entry_date ASC, created_at ASC`,
      params
    );

    const totals = (result.rows || []).reduce(
      (acc, e) => {
        acc.debit += Number(e.debit) || 0;
        acc.credit += Number(e.credit) || 0;
        acc.tax += Number(e.tax_amount) || 0;
        return acc;
      },
      { debit: 0, credit: 0, tax: 0 }
    );

    res.json({
      ok: true,
      success: true,
      period: { start, end },
      entries: result.rows,
      totals,
      count: result.rows.length,
    });
  } catch (err) {
    console.error('GET /ledger/reports/journal error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message, entries: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/trial-balance
//  ميزان المراجعة
// ═══════════════════════════════════════════════
router.get('/trial-balance', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    // جلب الحركات مجموعة حسب الحساب
    const entriesRes = await queryAsUser(
      user,
      `SELECT 
         account_id, account_type,
         COALESCE(SUM(debit), 0)::numeric AS total_debit,
         COALESCE(SUM(credit), 0)::numeric AS total_credit
       FROM ledger_entries
       WHERE tenant_id = $1
         AND entry_date >= $2 AND entry_date <= $3
       GROUP BY account_id, account_type`,
      [tenantId, start, end]
    );

    // جلب أسماء الحسابات
    const [customersRes, suppliersRes] = await Promise.all([
      queryAsUser(user, `SELECT id, full_name AS name FROM customers WHERE tenant_id = $1`, [tenantId]),
      queryAsUser(user, `SELECT id, name FROM suppliers WHERE tenant_id = $1`, [tenantId]),
    ]);

    const namesMap = {};
    (customersRes.rows || []).forEach((c) => { namesMap[`customer_${c.id}`] = c.name; });
    (suppliersRes.rows || []).forEach((s) => { namesMap[`supplier_${s.id}`] = s.name; });

    const accounts = (entriesRes.rows || []).map((a) => {
      const debit = Number(a.total_debit) || 0;
      const credit = Number(a.total_credit) || 0;
      return {
        account_id: a.account_id,
        account_type: a.account_type,
        account_name: namesMap[`${a.account_type}_${a.account_id}`] || null,
        total_debit: debit,
        total_credit: credit,
        balance: debit - credit,
      };
    });

    accounts.sort((a, b) => (a.account_name || '').localeCompare(b.account_name || ''));

    const totals = accounts.reduce(
      (acc, a) => {
        acc.total_debit += a.total_debit;
        acc.total_credit += a.total_credit;
        acc.total_balance += a.balance;
        return acc;
      },
      { total_debit: 0, total_credit: 0, total_balance: 0 }
    );

    res.json({
      ok: true,
      success: true,
      period: { start, end },
      accounts,
      totals,
      is_balanced: Math.abs(totals.total_debit - totals.total_credit) < 0.01,
    });
  } catch (err) {
    console.error('GET /ledger/reports/trial-balance error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message, accounts: [], totals: {} });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/sales-purchases
// ═══════════════════════════════════════════════
router.get('/sales-purchases', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    const result = await queryAsUser(
      user,
      `SELECT * FROM ledger_entries
       WHERE tenant_id = $1
         AND entry_date >= $2 AND entry_date <= $3
         AND entry_type IN ('invoice', 'return')`,
      [tenantId, start, end]
    );

    const report = {
      sales: { invoices: 0, returns: 0, net: 0, count: 0 },
      purchases: { invoices: 0, returns: 0, net: 0, count: 0 },
      period: { start, end },
    };

    (result.rows || []).forEach((e) => {
      const amount = Number(e.debit) || Number(e.credit) || 0;
      const isSales = e.account_type === 'customer';
      const isReturn = e.entry_type === 'return';

      if (isSales) {
        if (isReturn) {
          report.sales.returns += amount;
        } else {
          report.sales.invoices += amount;
          report.sales.count++;
        }
      } else if (e.account_type === 'supplier') {
        if (isReturn) {
          report.purchases.returns += amount;
        } else {
          report.purchases.invoices += amount;
          report.purchases.count++;
        }
      }
    });

    report.sales.net = report.sales.invoices - report.sales.returns;
    report.purchases.net = report.purchases.invoices - report.purchases.returns;

    res.json({ ok: true, success: true, ...report });
  } catch (err) {
    console.error('GET /ledger/reports/sales-purchases error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/cash-flow
// ═══════════════════════════════════════════════
router.get('/cash-flow', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    const result = await queryAsUser(
      user,
      `SELECT 
         account_type,
         COALESCE(debit, 0) AS debit,
         COALESCE(credit, 0) AS credit,
         COALESCE(metadata->>'payment_type', 'cash') AS payment_type
       FROM ledger_entries
       WHERE tenant_id = $1
         AND entry_type = 'payment'
         AND entry_date >= $2 AND entry_date <= $3`,
      [tenantId, start, end]
    );

    const report = {
      incoming: 0,
      outgoing: 0,
      net: 0,
      byType: {
        cash: { incoming: 0, outgoing: 0 },
        card: { incoming: 0, outgoing: 0 },
        bank_transfer: { incoming: 0, outgoing: 0 },
        mobile: { incoming: 0, outgoing: 0 },
      },
      period: { start, end },
    };

    (result.rows || []).forEach((e) => {
      const amount = Number(e.debit) || Number(e.credit) || 0;
      const pt = e.payment_type || 'cash';
      const bucket = report.byType[pt] || (report.byType[pt] = { incoming: 0, outgoing: 0 });

      if (e.account_type === 'customer') {
        report.incoming += amount;
        bucket.incoming += amount;
      } else if (e.account_type === 'supplier') {
        report.outgoing += amount;
        bucket.outgoing += amount;
      }
    });

    report.net = report.incoming - report.outgoing;

    res.json({ ok: true, success: true, ...report });
  } catch (err) {
    console.error('GET /ledger/reports/cash-flow error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/tax
// ═══════════════════════════════════════════════
router.get('/tax', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    const result = await queryAsUser(
      user,
      `SELECT * FROM ledger_entries
       WHERE tenant_id = $1
         AND entry_date >= $2 AND entry_date <= $3
         AND tax_amount > 0`,
      [tenantId, start, end]
    );

    const report = {
      output_tax: 0,
      input_tax: 0,
      net_tax: 0,
      sales: { subtotal: 0, tax: 0, total: 0, count: 0 },
      purchases: { subtotal: 0, tax: 0, total: 0, count: 0 },
      by_rate: {},
      period: { start, end },
    };

    (result.rows || []).forEach((e) => {
      const tax = Number(e.tax_amount) || 0;
      const gross = Number(e.debit) || Number(e.credit) || 0;
      const subtotal = Number(e.subtotal) || (gross - tax);
      const total = subtotal + tax;
      const rate = Number(e.tax_rate) || 0;

      const isSales = e.account_type === 'customer' && e.entry_type === 'invoice';
      const isPurchase = e.account_type === 'supplier' && e.entry_type === 'invoice';

      if (!report.by_rate[rate]) {
        report.by_rate[rate] = { rate, subtotal: 0, tax: 0, total: 0, count: 0 };
      }
      report.by_rate[rate].subtotal += subtotal;
      report.by_rate[rate].tax += tax;
      report.by_rate[rate].total += total;
      report.by_rate[rate].count++;

      if (isSales) {
        report.output_tax += tax;
        report.sales.subtotal += subtotal;
        report.sales.tax += tax;
        report.sales.total += total;
        report.sales.count++;
      } else if (isPurchase) {
        report.input_tax += tax;
        report.purchases.subtotal += subtotal;
        report.purchases.tax += tax;
        report.purchases.total += total;
        report.purchases.count++;
      }
    });

    report.net_tax = report.output_tax - report.input_tax;
    report.by_rate = Object.values(report.by_rate).sort((a, b) => a.rate - b.rate);

    res.json({ ok: true, success: true, ...report });
  } catch (err) {
    console.error('GET /ledger/reports/tax error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/balance-sheet
// ═══════════════════════════════════════════════
router.get('/balance-sheet', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    // 1. الأصول (رصيد العملاء > 0)
    const assetsRes = await queryAsUser(
      user,
      `SELECT id, full_name, balance FROM customers
       WHERE tenant_id = $1 AND balance > 0`,
      [tenantId]
    );

    // 2. الالتزامات (رصيد الموردين > 0)
    const liabRes = await queryAsUser(
      user,
      `SELECT id, name, balance FROM suppliers
       WHERE tenant_id = $1 AND balance > 0`,
      [tenantId]
    );

    // 3. قيمة المخزون
    const inventoryRes = await queryAsUser(
      user,
      `SELECT COALESCE(SUM(s.quantity * COALESCE(pu.cost, 0)), 0)::numeric AS value
       FROM stock s
       LEFT JOIN product_units pu
         ON pu.product_id = s.product_id AND pu.unit_id = s.unit_id
       WHERE s.tenant_id = $1`,
      [tenantId]
    );
    const inventoryValue = Number(inventoryRes.rows[0]?.value) || 0;

    // 4. إجماليات Ledger
    const ledgerRes = await queryAsUser(
      user,
      `SELECT 
         account_type, entry_type,
         COALESCE(SUM(debit), 0)::numeric AS total_debit,
         COALESCE(SUM(credit), 0)::numeric AS total_credit,
         COALESCE(SUM(tax_amount), 0)::numeric AS total_tax
       FROM ledger_entries
       WHERE tenant_id = $1
         AND entry_date >= $2 AND entry_date <= $3
       GROUP BY account_type, entry_type`,
      [tenantId, start, end]
    );

    let totalSales = 0, totalPurchases = 0, totalTax = 0;
    (ledgerRes.rows || []).forEach((e) => {
      const amount = Number(e.total_debit) || Number(e.total_credit) || 0;
      totalTax += Number(e.total_tax) || 0;
      if (e.entry_type === 'invoice') {
        if (e.account_type === 'customer') totalSales += amount;
        if (e.account_type === 'supplier') totalPurchases += amount;
      }
    });

    const receivables = (assetsRes.rows || []).reduce((s, a) => s + Number(a.balance || 0), 0);
    const payables = (liabRes.rows || []).reduce((s, l) => s + Number(l.balance || 0), 0);

    const report = {
      assets: {
        receivables,
        inventory: inventoryValue,
        customers_count: assetsRes.rows.length,
        details: { customers: assetsRes.rows, inventory_value: inventoryValue },
      },
      liabilities: {
        payables,
        tax_payable: totalTax,
        suppliers_count: liabRes.rows.length,
        details: { suppliers: liabRes.rows, tax: totalTax },
      },
      period: { start, end },
    };

    report.total_assets = report.assets.receivables + report.assets.inventory;
    report.total_liabilities = report.liabilities.payables + report.liabilities.tax_payable;
    report.net_worth = report.total_assets - report.total_liabilities;
    report.summary = {
      total_sales: totalSales,
      total_purchases: totalPurchases,
      gross_profit: totalSales - totalPurchases,
    };

    res.json({ ok: true, success: true, ...report });
  } catch (err) {
    console.error('GET /ledger/reports/balance-sheet error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/income-statement
// ═══════════════════════════════════════════════
router.get('/income-statement', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);

    const [salesRes, purchasesRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT entry_type,
                COALESCE(SUM(debit), 0)::numeric AS total_debit,
                COALESCE(SUM(credit), 0)::numeric AS total_credit,
                COALESCE(SUM(tax_amount), 0)::numeric AS total_tax
         FROM ledger_entries
         WHERE tenant_id = $1
           AND account_type = 'customer'
           AND entry_date >= $2 AND entry_date <= $3
         GROUP BY entry_type`,
        [tenantId, start, end]
      ),
      queryAsUser(
        user,
        `SELECT entry_type,
                COALESCE(SUM(debit), 0)::numeric AS total_debit,
                COALESCE(SUM(credit), 0)::numeric AS total_credit,
                COALESCE(SUM(tax_amount), 0)::numeric AS total_tax
         FROM ledger_entries
         WHERE tenant_id = $1
           AND account_type = 'supplier'
           AND entry_date >= $2 AND entry_date <= $3
         GROUP BY entry_type`,
        [tenantId, start, end]
      ),
    ]);

    let grossSales = 0, salesReturns = 0, salesTax = 0;
    (salesRes.rows || []).forEach((e) => {
      const amount = Number(e.total_debit) || Number(e.total_credit) || 0;
      if (e.entry_type === 'invoice') grossSales += amount;
      if (e.entry_type === 'return') salesReturns += amount;
      salesTax += Number(e.total_tax) || 0;
    });

    let grossPurchases = 0, purchaseReturns = 0, purchaseTax = 0;
    (purchasesRes.rows || []).forEach((e) => {
      const amount = Number(e.total_debit) || Number(e.total_credit) || 0;
      if (e.entry_type === 'invoice') grossPurchases += amount;
      if (e.entry_type === 'return') purchaseReturns += amount;
      purchaseTax += Number(e.total_tax) || 0;
    });

    const netSales = grossSales - salesReturns;
    const netPurchases = grossPurchases - purchaseReturns;
    const grossProfit = netSales - netPurchases;
    const profitMargin = netSales > 0 ? (grossProfit / netSales) * 100 : 0;

    res.json({
      ok: true,
      success: true,
      period: { start, end },
      revenue: {
        gross_sales: grossSales,
        sales_returns: salesReturns,
        net_sales: netSales,
        tax_collected: salesTax,
      },
      costs: {
        gross_purchases: grossPurchases,
        purchase_returns: purchaseReturns,
        net_purchases: netPurchases,
        tax_paid: purchaseTax,
      },
      profit: {
        gross_profit: grossProfit,
        profit_margin: profitMargin,
        net_tax_payable: salesTax - purchaseTax,
      },
    });
  } catch (err) {
    console.error('GET /ledger/reports/income-statement error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/ledger/reports/detailed
// ═══════════════════════════════════════════════
router.get('/detailed', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!user?.sub) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const tenantId = user.tenant_id;
    if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

    const { start, end } = extractRange(req);
    const { entryType, accountType, accountId } = req.query;

    let where = 'WHERE tenant_id = $1 AND entry_date >= $2 AND entry_date <= $3';
    const params = [tenantId, start, end];

    if (entryType) { params.push(entryType); where += ` AND entry_type = $${params.length}`; }
    if (accountType) { params.push(accountType); where += ` AND account_type = $${params.length}`; }
    if (accountId) { params.push(accountId); where += ` AND account_id = $${params.length}`; }

    const result = await queryAsUser(
      user,
      `SELECT * FROM ledger_entries ${where}
       ORDER BY entry_date ASC, created_at ASC`,
      params
    );

    const grouped = {
      invoice: [],
      payment: [],
      return: [],
      opening: [],
      adjustment: [],
      expense: [],
    };

    (result.rows || []).forEach((e) => {
      if (!grouped[e.entry_type]) grouped[e.entry_type] = [];
      grouped[e.entry_type].push(e);
    });

    const summary = Object.entries(grouped).map(([type, entries]) => ({
      type,
      count: entries.length,
      total_debit: entries.reduce((s, e) => s + Number(e.debit || 0), 0),
      total_credit: entries.reduce((s, e) => s + Number(e.credit || 0), 0),
      total_tax: entries.reduce((s, e) => s + Number(e.tax_amount || 0), 0),
    }));

    res.json({
      ok: true,
      success: true,
      period: { start, end },
      entries: result.rows,
      grouped,
      summary,
    });
  } catch (err) {
    console.error('GET /ledger/reports/detailed error:', err.message);
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

module.exports = router;