// ═══════════════════════════════════════════════════════════
//  Idempotency Middleware
//  يمنع تكرار العمليات عند إعادة الإرسال
// ═══════════════════════════════════════════════════════════
const pool = require('../db');

function idempotencyMiddleware(req, res, next) {
  const key = req.headers['idempotency-key'];

  // ─── لا يوجد مفتاح → تجاهل ───
  if (!key) return next();

  // ─── لا يوجد مستخدم → تجاهل ───
  if (!req.user?.sub) return next();

  // ═══ تحقق من وجود المفتاح مسبقاً ═══
  pool.query(
    `SELECT response_data, created_at
     FROM idempotency_keys
     WHERE key = $1 
     AND user_id = $2
     AND expires_at > NOW()`,
    [key, req.user.sub]
  ).then(({ rows }) => {
    if (rows.length > 0) {
      // ─── المفتاح موجود → أعد الرد الأصلي ───
      console.log(`🔁 Idempotency hit: ${key}`);
      return res.status(200).json({
        ...rows[0].response_data,
        _idempotent: true,
      });
    }

    // ═══ اعترض الرد الأصلي لحفظه ═══
    const originalJson = res.json.bind(res);

    res.json = function (data) {
      // ─── احفظ المفتاح فقط عند النجاح (2xx) ───
      if (res.statusCode >= 200 && res.statusCode < 300) {
        pool.query(
          `INSERT INTO idempotency_keys
           (key, user_id, tenant_id, endpoint, response_data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (key) DO NOTHING`,
          [
            key,
            req.user.sub,
            req.user.tenant_id || null,
            `${req.method} ${req.path}`,
            JSON.stringify(data),
          ]
        ).catch(err => console.error('Idempotency save error:', err.message));
      }
      return originalJson(data);
    };

    next();
  }).catch(err => {
    console.error('Idempotency check error:', err.message);
    next();   // ⚠️ لا نُفشل العملية الأساسية
  });
}

module.exports = { idempotencyMiddleware };