// ═══════════════════════════════════════════════
//  src/utils/sentry.js
//  Sentry Error Tracking
// ═══════════════════════════════════════════════

let Sentry = null;
let initialized = false;

try {
  Sentry = require('@sentry/node');
} catch (e) {
  console.warn('⚠️ @sentry/node not installed. Sentry disabled.');
}

function initSentry(app) {
  if (!Sentry) return false;
  if (!process.env.SENTRY_DSN) {
    console.log('ℹ️ SENTRY_DSN not set. Sentry disabled.');
    return false;
  }

  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
      beforeSend(event) {
        // تجاهل أخطاء معروفة
        if (event.exception?.values?.[0]?.value?.includes('ResizeObserver')) {
          return null;
        }
        return event;
      },
    });

    // Express error handler
    if (app) {
      Sentry.setupExpressErrorHandler(app);
    }

    initialized = true;
    console.log('✅ Sentry initialized');
    return true;
  } catch (err) {
    console.error('❌ Sentry init error:', err.message);
    return false;
  }
}

function captureException(error, context = {}) {
  if (!initialized || !Sentry) {
    console.error('❌ [ERROR]', error.message, context);
    return;
  }
  Sentry.captureException(error, { extra: context });
}

function captureMessage(message, level = 'info', context = {}) {
  if (!initialized || !Sentry) {
    console.log(`[${level.toUpperCase()}]`, message, context);
    return;
  }
  Sentry.captureMessage(message, { level, extra: context });
}

function setUser(user) {
  if (!initialized || !Sentry) return;
  Sentry.setUser(user ? { id: user.sub, email: user.email } : null);
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  setUser,
};