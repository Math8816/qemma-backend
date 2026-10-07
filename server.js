// ═══════════════════════════════════════════════
//  Imports
// ═══════════════════════════════════════════════
const logger = require('./src/utils/logger');
const { initSentry, captureException, setUser } = require('./src/utils/sentry');
const twoFactorRouter = require('./src/routes/twoFactor');
const syncRouter = require('./src/routes/sync');

const rateLimit = require('express-rate-limit');
const cors = require('cors');                                    // ← أضف
const helmet = require('helmet');

require('dotenv').config();
const express = require('express');
const pool = require('./src/db');

const { initSocket } = require('./src/realtime/socket');
const { optionalAuth } = require('./src/middleware/auth');
const { authLimiter, apiLimiter, signupLimiter } = require('./src/middleware/rateLimit');

const productsRouter = require('./src/routes/products');
const usersRouter = require('./src/routes/users');
const authRouter = require('./src/routes/auth');
const auditRouter = require('./src/routes/audit');
const genericRouter = require('./src/routes/generic');
const storageRouter = require('./src/routes/storage');

const app = express();
initSentry(app);
const PORT = process.env.PORT || 4000;

// ═══════════════════════════════════════════════
//  Trust Proxy
// ═══════════════════════════════════════════════
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════
//  Security Headers (Helmet)
// ═══════════════════════════════════════════════
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// ═══════════════════════════════════════════════
//  CORS محدود
// ═══════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'https://qemma-platform.com',
  'https://app.qemma-platform.com',
  'https://qemma-platform.web.app',
  'https://qc-services.vercel.app',
  'https://qc-services-h7vkcv7f8-math8816.vercel.app',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      console.warn(`🚫 CORS blocked: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ═══════════════════════════════════════════════
//  Body Parser
// ═══════════════════════════════════════════════
app.use(express.json());

// ═══════════════════════════════════════════════
//  Optional Auth
// ═══════════════════════════════════════════════
app.use(optionalAuth);

// ═══════════════════════════════════════════════
//  Logger
// ═══════════════════════════════════════════════
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.logRequest(req, res, Date.now() - start);
  });
  next();
});

// ═══════════════════════════════════════════════
//  Recovery Rate Limiter
// ═══════════════════════════════════════════════
const recoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 3 : 100,
  message: {
    error: 'too_many_requests',
    error_description: 'Too many recovery attempts. Try again later.',
  },
});

// ═══════════════════════════════════════════════
//  Health & DB Check
// ═══════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'qemma-backend', time: new Date().toISOString() });
});

app.get('/db-check', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now, current_database() AS db');
    res.json({ ok: true, database: rows[0].db, time: rows[0].now });
  } catch (err) {
    // ─── سجّل الخطأ الكامل في Render Logs ───
    console.error('❌ db-check error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));

    // ─── أرجع التفاصيل للمتصفح ───
    res.status(500).json({
      ok: false,
      error: err.message || 'no_message',
      code: err.code || 'no_code',
      detail: err.detail || 'no_detail',
      hint: err.hint || 'no_hint',
      severity: err.severity || 'no_severity',
      name: err.name || 'no_name',
    });
  }
});

// ═══════════════════════════════════════════════
//  Auth Routes (مع Rate Limiters)
// ═══════════════════════════════════════════════
app.use('/auth/v1/token', authLimiter);
app.use('/auth/v1/signup', signupLimiter);
app.use('/auth/v1/recover', recoveryLimiter);
app.use('/auth/v1', authRouter);
app.use('/auth/v1/2fa', twoFactorRouter);
app.use('/api/sync', syncRouter);

// ═══════════════════════════════════════════════
//  API Routes (مع API Limiter أولاً)
// ═══════════════════════════════════════════════
app.use('/storage/v1', storageRouter);
app.use('/api', apiLimiter);            // ← قبل كل /api/*
app.use('/api/products', productsRouter);
app.use('/api/users', usersRouter);
app.use('/api/audit', auditRouter);
app.use('/api/generic', genericRouter);

// ═══════════════════════════════════════════════
//  Root
// ═══════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.json({
    message: 'مرحباً بك في Qemma Backend',
    version: '5.0.0',
    endpoints: [
      'GET    /health',
      'GET    /db-check',
      'POST   /auth/v1/token',
      'POST   /auth/v1/signup',
      'POST   /auth/v1/recover',
      'POST   /auth/v1/verify',
      'POST   /auth/v1/token/refresh',
      'PUT    /auth/v1/user',
      'GET    /api/products',
      'GET    /api/products/rls/list',
      'GET    /api/users',
      'GET    /api/audit',
      'GET    /api/generic',
      'GET    /api/generic/:table',
    ],
  });
});

// ═══════════════════════════════════════════════
//  CORS Error Handler
// ═══════════════════════════════════════════════
app.use((err, req, res, _next) => {
  // ─── CORS ───
  if (err.message === 'Not allowed by CORS') {
    logger.warn(`CORS blocked: ${req.headers.origin}`);
    return res.status(403).json({ ok: false, error: 'CORS blocked' });
  }

  // ─── Sentry + Logger ───
  captureException(err, { url: req.url, method: req.method });
  logger.logError(err, { url: req.url, method: req.method });

  // ─── Response ───
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(err.statusCode || 500).json({
    ok: false,
    error: 'Internal server error',
    ...(isDev && { details: err.message }),
  });
});

// ═══════════════════════════════════════════════
//  Start Server
// ═══════════════════════════════════════════════
const server = app.listen(PORT, () => {
  console.log(`🚀 Server → http://localhost:${PORT}`);
  console.log(`✅ DB Connected: ${new Date().toISOString()}`);
});

// ─── Socket.io ───
initSocket(server);