// ═══════════════════════════════════════════════
//  src/routes/dashboard.js
//  لوحة Owner — 9 endpoints
//  ✅ يتوافق مع dashboardService.js (frontend)
//  ✅ يعتمد على organization_id من JWT
// ═══════════════════════════════════════════════

const express = require('express');
const pool = require('../db');
const { queryAsUser } = require('../db-rls');
const { optionalAuth } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  Helper: التحقق من وجود organization_id
// ═══════════════════════════════════════════════
function requireOrg(user, res) {
  if (!user?.sub) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return null;
  }
  if (!user.organization_id) {
    res.status(400).json({ ok: false, error: 'organization_id required' });
    return null;
  }
  return user.organization_id;
}

// ═══════════════════════════════════════════════
//  Helper: تاريخ قبل N يوم
// ═══════════════════════════════════════════════
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════
//  Helper: قائمة tenant_ids للسلسلة
// ═══════════════════════════════════════════════
async function getOrgTenantIds(user, organizationId) {
  const r = await queryAsUser(
    user,
    `SELECT tenant_id FROM branches
     WHERE organization_id = $1 AND is_active = true`,
    [organizationId]
  );
  return (r.rows || []).map((b) => b.tenant_id).filter(Boolean);
}

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/overview
//  الإحصائيات العامة للسلسلة
// ═══════════════════════════════════════════════
router.get('/rls/overview', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const [branchesRes, productsRes, customersRes, invoicesRes] = await Promise.all([
      queryAsUser(user,
        `SELECT COUNT(*)::int AS c FROM branches
         WHERE organization_id = $1 AND is_active = true`,
        [orgId]
      ),
      queryAsUser(user,
        `SELECT COUNT(*)::int AS c FROM products WHERE organization_id = $1`,
        [orgId]
      ),
      queryAsUser(user,
        `SELECT COUNT(*)::int AS c FROM customers WHERE organization_id = $1`,
        [orgId]
      ),
      queryAsUser(user,
        `SELECT COALESCE(SUM(total), 0)::numeric AS revenue,
                COUNT(*)::int AS count
         FROM sales_invoices
         WHERE organization_id = $1
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId]
      ),
    ]);

    res.json({
      ok: true,
      branchesCount: branchesRes.rows[0]?.c || 0,
      productsCount: productsRes.rows[0]?.c || 0,
      customersCount: customersRes.rows[0]?.c || 0,
      invoicesCount: invoicesRes.rows[0]?.count || 0,
      totalRevenue: Number(invoicesRes.rows[0]?.revenue) || 0,
    });
  } catch (err) {
    console.error('GET /dashboard/rls/overview error:', err.message);
    res.status(500).json({
      ok: false,
      error: err.message,
      branchesCount: 0,
      productsCount: 0,
      customersCount: 0,
      invoicesCount: 0,
      totalRevenue: 0,
    });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/branches-stats
//  إحصائيات كل فرع (تفصيلية)
// ═══════════════════════════════════════════════
router.get('/rls/branches-stats', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const result = await queryAsUser(
      user,
      `SELECT
         b.id, b.tenant_id, b.name, b.code, b.is_hq, b.is_active, b.created_at,
         t.name AS tenant_name,
         t.is_active AS tenant_active,
         COALESCE(inv.sales_count, 0)::int AS "salesCount",
         COALESCE(inv.total_sales, 0)::numeric AS "totalSales",
         COALESCE(cust.customers_count, 0)::int AS "customersCount",
         COALESCE(prod.products_count, 0)::int AS "productsCount"
       FROM branches b
       LEFT JOIN tenants t ON t.id = b.tenant_id
       LEFT JOIN (
         SELECT tenant_id,
                COUNT(*)::int AS sales_count,
                SUM(total) AS total_sales
         FROM sales_invoices
         WHERE organization_id = $1
           AND status NOT IN ('cancelled', 'voided')
         GROUP BY tenant_id
       ) inv ON inv.tenant_id = b.tenant_id
       LEFT JOIN (
         SELECT tenant_id, COUNT(*)::int AS customers_count
         FROM customers WHERE organization_id = $1
         GROUP BY tenant_id
       ) cust ON cust.tenant_id = b.tenant_id
       LEFT JOIN (
         SELECT tenant_id, COUNT(*)::int AS products_count
         FROM products WHERE organization_id = $1
         GROUP BY tenant_id
       ) prod ON prod.tenant_id = b.tenant_id
       WHERE b.organization_id = $1 AND b.is_active = true
       ORDER BY b.is_hq DESC, b.name`,
      [orgId]
    );

    const filtered = result.rows.filter((b) => b.tenant_active !== false);

    res.json({ ok: true, count: filtered.length, data: filtered });
  } catch (err) {
    console.error('GET /dashboard/rls/branches-stats error:', err.message);
    res.status(500).json({ ok: false, error: err.message, data: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/branches-sales?days=30
//  مبيعات الفروع خلال N يوم
// ═══════════════════════════════════════════════
router.get('/rls/branches-sales', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const startDate = daysAgo(days);

    const result = await queryAsUser(
      user,
      `SELECT
         si.tenant_id,
         b.name,
         b.is_hq,
         COALESCE(SUM(si.total), 0)::numeric AS total,
         COUNT(*)::int AS count
       FROM sales_invoices si
       LEFT JOIN branches b ON b.tenant_id = si.tenant_id
       WHERE si.organization_id = $1
         AND si.date >= $2
         AND si.status NOT IN ('cancelled', 'voided')
       GROUP BY si.tenant_id, b.name, b.is_hq
       ORDER BY total DESC`,
      [orgId, startDate]
    );

    const data = result.rows.map((r) => ({
      tenantId: r.tenant_id,
      name: r.name || 'غير معروف',
      is_hq: r.is_hq || false,
      total: Number(r.total) || 0,
      count: r.count || 0,
    }));

    res.json({ ok: true, days, count: data.length, data });
  } catch (err) {
    console.error('GET /dashboard/rls/branches-sales error:', err.message);
    res.status(500).json({ ok: false, error: err.message, data: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/top-products?limit=10
//  أفضل المنتجات مبيعاً في السلسلة
// ═══════════════════════════════════════════════
router.get('/rls/top-products', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const result = await queryAsUser(
      user,
      `SELECT
         sii.product_id,
         MAX(sii.product_name) AS name,
         COALESCE(SUM(sii.quantity), 0)::numeric AS total_quantity,
         COALESCE(SUM(sii.total), 0)::numeric AS total_revenue
       FROM sales_invoice_items sii
       INNER JOIN sales_invoices si ON si.id = sii.invoice_id
       WHERE si.organization_id = $1
         AND si.status NOT IN ('cancelled', 'voided')
       GROUP BY sii.product_id
       ORDER BY total_quantity DESC
       LIMIT $2`,
      [orgId, limit]
    );

    const data = result.rows.map((r) => ({
      productId: r.product_id,
      name: r.name || 'منتج غير معروف',
      totalQuantity: Number(r.total_quantity) || 0,
      totalRevenue: Number(r.total_revenue) || 0,
    }));

    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    console.error('GET /dashboard/rls/top-products error:', err.message);
    res.status(500).json({ ok: false, error: err.message, data: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/top-customers?days=30&limit=10
//  أفضل العملاء
// ═══════════════════════════════════════════════
router.get('/rls/top-customers', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const startDate = daysAgo(days);

    const result = await queryAsUser(
      user,
      `SELECT
         customer_id,
         MAX(customer_name) AS name,
         COALESCE(SUM(total), 0)::numeric AS total,
         COUNT(*)::int AS count
       FROM sales_invoices
       WHERE organization_id = $1
         AND date >= $2
         AND status NOT IN ('cancelled', 'voided')
       GROUP BY customer_id, customer_name
       ORDER BY total DESC
       LIMIT $3`,
      [orgId, startDate, limit]
    );

    const data = result.rows.map((r) => ({
      customer_id: r.customer_id,
      name: r.name || 'غير معروف',
      total: Number(r.total) || 0,
      count: r.count || 0,
    }));

    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    console.error('GET /dashboard/rls/top-customers error:', err.message);
    res.status(500).json({ ok: false, error: err.message, data: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/period-stats?days=30
//  إحصائيات فترة محددة
// ═══════════════════════════════════════════════
router.get('/rls/period-stats', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const startDate = daysAgo(days);

    const result = await queryAsUser(
      user,
      `SELECT
         COALESCE(SUM(total), 0)::numeric AS total_revenue,
         COUNT(*)::int AS invoices_count
       FROM sales_invoices
       WHERE organization_id = $1
         AND date >= $2
         AND status NOT IN ('cancelled', 'voided')`,
      [orgId, startDate]
    );

    const row = result.rows[0] || {};
    const invoicesCount = row.invoices_count || 0;
    const totalRevenue = Number(row.total_revenue) || 0;

    res.json({
      ok: true,
      invoicesCount,
      totalRevenue,
      avgInvoice: invoicesCount > 0 ? totalRevenue / invoicesCount : 0,
    });
  } catch (err) {
    console.error('GET /dashboard/rls/period-stats error:', err.message);
    res.status(500).json({
      ok: false,
      error: err.message,
      invoicesCount: 0,
      totalRevenue: 0,
      avgInvoice: 0,
    });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/branch-health?days=30
//  صحة كل فرع (Health Score)
// ═══════════════════════════════════════════════
router.get('/rls/branch-health', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const days = Math.min(parseInt(req.query.days) || 30, 180);
    const startDate = daysAgo(days);
    const prevStartDate = daysAgo(days * 2);

    // 1. الفروع
    const branchesRes = await queryAsUser(
      user,
      `SELECT b.id, b.tenant_id, b.name, b.code, b.is_hq
       FROM branches b
       INNER JOIN tenants t ON t.id = b.tenant_id
       WHERE b.organization_id = $1
         AND b.is_active = true
         AND t.is_active = true
       ORDER BY b.is_hq DESC, b.name`,
      [orgId]
    );

    const branches = branchesRes.rows || [];
    if (branches.length === 0) {
      return res.json({ ok: true, count: 0, data: [] });
    }

    const tenantIds = branches.map((b) => b.tenant_id).filter(Boolean);
    if (tenantIds.length === 0) {
      return res.json({ ok: true, count: 0, data: [] });
    }

    // 2. الفواتير (فترة حالية + سابقة) + العملاء + المخزون المنخفض
    const [currInvRes, prevInvRes, customersRes, lowStockRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT tenant_id, total, paid, remaining, customer_id
         FROM sales_invoices
         WHERE organization_id = $1
           AND tenant_id = ANY($2::uuid[])
           AND date >= $3
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, tenantIds, startDate]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, total
         FROM sales_invoices
         WHERE organization_id = $1
           AND tenant_id = ANY($2::uuid[])
           AND date >= $3 AND date < $4
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, tenantIds, prevStartDate, startDate]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, id
         FROM customers
         WHERE organization_id = $1 AND tenant_id = ANY($2::uuid[])`,
        [orgId, tenantIds]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, COUNT(*)::int AS low_count
         FROM stock
         WHERE tenant_id = ANY($1::uuid[])
           AND min_quantity > 0
           AND quantity <= min_quantity
         GROUP BY tenant_id`,
        [tenantIds]
      ),
    ]);

    const lowStockMap = {};
    (lowStockRes.rows || []).forEach((r) => {
      lowStockMap[r.tenant_id] = r.low_count;
    });

    const data = branches.map((b) => {
      const tid = b.tenant_id;
      const currInv = (currInvRes.rows || []).filter((i) => i.tenant_id === tid);
      const prevInv = (prevInvRes.rows || []).filter((i) => i.tenant_id === tid);
      const cust = (customersRes.rows || []).filter((c) => c.tenant_id === tid);

      const revenue = currInv.reduce((s, i) => s + Number(i.total || 0), 0);
      const prevRevenue = prevInv.reduce((s, i) => s + Number(i.total || 0), 0);
      const paid = currInv.reduce((s, i) => s + Number(i.paid || 0), 0);

      const salesGrowth = prevRevenue > 0
        ? ((revenue - prevRevenue) / prevRevenue) * 100
        : revenue > 0 ? 100 : 0;

      const collectionRate = revenue > 0 ? (paid / revenue) * 100 : 100;

      const lowStockCount = lowStockMap[tid] || 0;
      const stockHealth = Math.max(0, 100 - lowStockCount * 5);

      const activeCustomers = new Set(
        currInv.map((i) => i.customer_id).filter(Boolean)
      ).size;
      const customerActivity = cust.length > 0
        ? (activeCustomers / cust.length) * 100
        : 0;

      const hasData = currInv.length > 0 || prevInv.length > 0 || cust.length > 0;

      let healthScore = null;
      let healthStatus = 'no_data';
      if (hasData) {
        healthScore = Math.round(
          Math.max(0, Math.min(100, salesGrowth)) * 0.3 +
          collectionRate * 0.25 +
          stockHealth * 0.2 +
          Math.min(100, customerActivity) * 0.25
        );
        if (healthScore >= 80) healthStatus = 'excellent';
        else if (healthScore >= 60) healthStatus = 'good';
        else healthStatus = 'poor';
      }

      return {
        tenantId: tid,
        name: b.name,
        code: b.code,
        isHq: b.is_hq,
        revenue,
        prevRevenue,
        salesGrowth: Math.round(salesGrowth * 10) / 10,
        paid,
        remaining: revenue - paid,
        collectionRate: Math.round(collectionRate),
        invoicesCount: currInv.length,
        lowStockCount,
        stockHealth: Math.round(stockHealth),
        customersCount: cust.length,
        activeCustomers,
        customerActivity: Math.round(customerActivity),
        healthScore,
        healthStatus,
        hasData,
      };
    });

    res.json({ ok: true, count: data.length, data });
  } catch (err) {
    console.error('GET /dashboard/rls/branch-health error:', err.message);
    res.status(500).json({ ok: false, error: err.message, data: [] });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/comparison?days=30
//  مقارنة الفترة الحالية بالسابقة
// ═══════════════════════════════════════════════
router.get('/rls/comparison', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = daysAgo(days);
    const prevEndDate = startDate;
    const prevStartDate = daysAgo(days * 2);

    const [currRes, prevRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT total, paid, remaining, customer_id
         FROM sales_invoices
         WHERE organization_id = $1
           AND date >= $2 AND date <= $3
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, startDate, endDate]
      ),
      queryAsUser(
        user,
        `SELECT total, paid, remaining, customer_id
         FROM sales_invoices
         WHERE organization_id = $1
           AND date >= $2 AND date < $3
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, prevStartDate, prevEndDate]
      ),
    ]);

    const summarize = (invoices) => {
      const total = invoices.reduce((s, i) => s + Number(i.total || 0), 0);
      const paid = invoices.reduce((s, i) => s + Number(i.paid || 0), 0);
      const remaining = invoices.reduce((s, i) => s + Number(i.remaining || 0), 0);
      const uniqueCustomers = new Set(
        invoices.map((i) => i.customer_id).filter(Boolean)
      ).size;

      return {
        revenue: total,
        paid,
        remaining,
        invoicesCount: invoices.length,
        avgInvoice: invoices.length > 0 ? total / invoices.length : 0,
        customersCount: uniqueCustomers,
      };
    };

    const current = summarize(currRes.rows || []);
    const previous = summarize(prevRes.rows || []);

    const calcChange = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    res.json({
      ok: true,
      current,
      previous,
      changes: {
        revenue: calcChange(current.revenue, previous.revenue),
        invoicesCount: calcChange(current.invoicesCount, previous.invoicesCount),
        avgInvoice: calcChange(current.avgInvoice, previous.avgInvoice),
        customersCount: calcChange(current.customersCount, previous.customersCount),
        paid: calcChange(current.paid, previous.paid),
      },
    });
  } catch (err) {
    console.error('GET /dashboard/rls/comparison error:', err.message);
    res.status(500).json({
      ok: false,
      error: err.message,
      current: {},
      previous: {},
      changes: {},
    });
  }
});

// ═══════════════════════════════════════════════
//  GET /api/dashboard/rls/alerts
//  التنبيهات الذكية
// ═══════════════════════════════════════════════
router.get('/rls/alerts', optionalAuth, async (req, res) => {
  try {
    const orgId = requireOrg(req.user, res);
    if (!orgId) return;
    const user = req.user;

    // 1. صحة الفروع (نستخدم منطق مشابه)
    const healthReq = { ...req, user };
    const healthUrl = `/api/dashboard/rls/branch-health?days=30`;

    // بدلاً من إعادة الاستدعاء — نكرر منطق مبسط
    const branchesRes = await queryAsUser(
      user,
      `SELECT b.tenant_id, b.name, b.is_hq
       FROM branches b
       INNER JOIN tenants t ON t.id = b.tenant_id
       WHERE b.organization_id = $1
         AND b.is_active = true
         AND t.is_active = true`,
      [orgId]
    );

    const branches = branchesRes.rows || [];
    if (branches.length === 0) {
      return res.json({ ok: true, critical: [], warning: [], info: [], total: 0 });
    }

    const tenantIds = branches.map((b) => b.tenant_id).filter(Boolean);
    const days = 30;
    const startDate = daysAgo(days);
    const prevStartDate = daysAgo(days * 2);

    const [currRes, prevRes, lowStockRes, agingRes] = await Promise.all([
      queryAsUser(
        user,
        `SELECT tenant_id, total, paid, customer_id
         FROM sales_invoices
         WHERE organization_id = $1
           AND tenant_id = ANY($2::uuid[])
           AND date >= $3
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, tenantIds, startDate]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, total
         FROM sales_invoices
         WHERE organization_id = $1
           AND tenant_id = ANY($2::uuid[])
           AND date >= $3 AND date < $4
           AND status NOT IN ('cancelled', 'voided')`,
        [orgId, tenantIds, prevStartDate, startDate]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, COUNT(*)::int AS low_count
         FROM stock
         WHERE tenant_id = ANY($1::uuid[])
           AND min_quantity > 0
           AND quantity <= min_quantity
         GROUP BY tenant_id`,
        [tenantIds]
      ),
      queryAsUser(
        user,
        `SELECT tenant_id, COUNT(*)::int AS aging_count,
                COALESCE(SUM(remaining), 0)::numeric AS aging_total
         FROM sales_invoices
         WHERE organization_id = $1
           AND remaining > 0
           AND date < $2
           AND status NOT IN ('cancelled', 'voided')
         GROUP BY tenant_id`,
        [orgId, daysAgo(60)]
      ),
    ]);

    const lowStockMap = {};
    (lowStockRes.rows || []).forEach((r) => { lowStockMap[r.tenant_id] = r.low_count; });

    const agingMap = {};
    (agingRes.rows || []).forEach((r) => {
      agingMap[r.tenant_id] = {
        count: r.aging_count,
        total: Number(r.aging_total) || 0,
      };
    });

    const critical = [];
    const warning = [];
    const info = [];

    for (const b of branches) {
      const tid = b.tenant_id;
      const curr = (currRes.rows || []).filter((i) => i.tenant_id === tid);
      const prev = (prevRes.rows || []).filter((i) => i.tenant_id === tid);

      const revenue = curr.reduce((s, i) => s + Number(i.total || 0), 0);
      const prevRevenue = prev.reduce((s, i) => s + Number(i.total || 0), 0);
      const paid = curr.reduce((s, i) => s + Number(i.paid || 0), 0);

      const salesGrowth = prevRevenue > 0
        ? ((revenue - prevRevenue) / prevRevenue) * 100
        : revenue > 0 ? 100 : 0;

      const collectionRate = revenue > 0 ? (paid / revenue) * 100 : 100;
      const lowStockCount = lowStockMap[tid] || 0;

      // ── sales_drop
      if (salesGrowth < -30 && prevRevenue > 0) {
        critical.push({
          type: 'sales_drop', severity: 'critical',
          branchId: tid, branchName: b.name,
          data: { change: Math.round(salesGrowth * 10) / 10 },
        });
      } else if (salesGrowth < -15 && prevRevenue > 0) {
        warning.push({
          type: 'sales_decline', severity: 'warning',
          branchId: tid, branchName: b.name,
          data: { change: Math.round(salesGrowth * 10) / 10 },
        });
      }

      // ── low_collection
      if (collectionRate < 60 && revenue > 0) {
        critical.push({
          type: 'low_collection', severity: 'critical',
          branchId: tid, branchName: b.name,
          data: { rate: Math.round(collectionRate) },
        });
      } else if (collectionRate < 80 && revenue > 0) {
        warning.push({
          type: 'collection_warning', severity: 'warning',
          branchId: tid, branchName: b.name,
          data: { rate: Math.round(collectionRate) },
        });
      }

      // ── low_stock
      if (lowStockCount > 10) {
        critical.push({
          type: 'low_stock', severity: 'critical',
          branchId: tid, branchName: b.name,
          data: { count: lowStockCount },
        });
      } else if (lowStockCount > 5) {
        warning.push({
          type: 'stock_warning', severity: 'warning',
          branchId: tid, branchName: b.name,
          data: { count: lowStockCount },
        });
      }

      // ── aging_debt
      const aging = agingMap[tid];
      if (aging) {
        if (aging.count >= 5 || aging.total >= 5000) {
          critical.push({
            type: 'aging_debt', severity: 'critical',
            branchId: tid, branchName: b.name,
            data: aging,
          });
        } else if (aging.count >= 2) {
          warning.push({
            type: 'aging_debt_warning', severity: 'warning',
            branchId: tid, branchName: b.name,
            data: aging,
          });
        }
      }

      // ── no_activity
      if (curr.length === 0 && prevRevenue === 0) {
        info.push({
          type: 'no_activity', severity: 'info',
          branchId: tid, branchName: b.name,
          data: {},
        });
      }
    }

    res.json({
      ok: true,
      critical,
      warning,
      info,
      total: critical.length + warning.length + info.length,
    });
  } catch (err) {
    console.error('GET /dashboard/rls/alerts error:', err.message);
    res.status(500).json({
      ok: false,
      error: err.message,
      critical: [], warning: [], info: [], total: 0,
    });
  }
});

module.exports = router;