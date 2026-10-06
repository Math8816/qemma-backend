require('dotenv').config();                 // ← ضروري!

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'qemma-local-dev-secret';

function optionalAuth(req, _res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();

  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      req.user = null;
    }
  } else {0
    req.user = null;
  }

  next();
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Missing token' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Invalid token: ' + err.message });
  }
}

module.exports = { optionalAuth, requireAuth };