// ═══════════════════════════════════════════════
//  src/middleware/rateLimit.js
//  Rate Limiting
// ═══════════════════════════════════════════════

const rateLimit = require('express-rate-limit');

// ─── إعدادات مشتركة ───
const commonOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  // ⚠️ مهم: تجاوز allowlist في التطوير
  skip: () => false, // لا تتجاهل أي طلب
  validate: { trustProxy: false }, // لتفادي التحذيرات
};

// ─── Auth: 10 محاولات / 15 دقيقة ───
const authLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'too_many_requests',
    error_description: 'Too many login attempts. Try again later.',
  },
});

// ─── API عام: 100 طلب / دقيقة ───
const apiLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 1000,
  max: 100,
  message: {
    ok: false,
    error: 'too_many_requests',
    error_description: 'Too many requests. Slow down.',
  },
});

// ─── Signup: 5 حسابات / ساعة ───
const signupLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    error: 'too_many_requests',
    error_description: 'Too many signup attempts. Try again later.',
  },
});

module.exports = { authLimiter, apiLimiter, signupLimiter };