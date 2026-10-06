// ═══════════════════════════════════════════════
//  src/middleware/rateLimit.js
//  Rate Limiting
// ═══════════════════════════════════════════════

const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';

// ─── Auth: 10 محاولات / 15 دقيقة (إنتاج)، 1000 (تطوير) ───
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 1000 : 10,
  skipSuccessfulRequests: isDev,   // ← في التطوير: تجاهل الناجحة
  message: {
    error: 'too_many_requests',
    error_description: 'Too many login attempts. Try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── API عام: 100 طلب / دقيقة (إنتاج)، 5000 (تطوير) ───
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 5000 : 100,
  message: {
    ok: false,
    error: 'too_many_requests',
    error_description: 'Too many requests. Slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Signup: 5 / ساعة (إنتاج)، 100 (تطوير) ───
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 100 : 5,
  message: {
    error: 'too_many_requests',
    error_description: 'Too many signup attempts. Try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, apiLimiter, signupLimiter };