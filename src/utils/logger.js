// ═══════════════════════════════════════════════
//  src/utils/logger.js
//  Winston Logger — احترافي مع دوران الملفات
// ═══════════════════════════════════════════════

const winston = require('winston');
const path = require('path');

try {
  require('winston-daily-rotate-file');
} catch (e) {
  console.warn('⚠️ winston-daily-rotate-file not installed. Using basic file logging.');
}

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// ─── Formats ───
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// ─── Transports ───
const transports = [
  // Console
  new winston.transports.Console({
    format: consoleFormat,
  }),
];

// File transports (إذا كانت المكتبة مثبتة)
try {
  const DailyRotateFile = require('winston-daily-rotate-file');

  transports.push(
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    }),
    new DailyRotateFile({
      filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    })
  );
} catch (e) {
  // Fallback: simple file
  transports.push(
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: fileFormat,
    })
  );
}

// ─── Logger ───
const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'qemma-backend' },
  transports,
  exitOnError: false,
});

// ─── Helper Methods ───
logger.logRequest = (req, res, duration) => {
  logger.info(`${req.method} ${req.url}`, {
    status: res.statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });
};

logger.logError = (error, context = {}) => {
  logger.error(error.message, {
    stack: error.stack,
    ...context,
  });
};

logger.logAuth = (action, user, context = {}) => {
  logger.info(`[AUTH] ${action}`, {
    userId: user?.id,
    email: user?.email,
    ...context,
  });
};

module.exports = logger;