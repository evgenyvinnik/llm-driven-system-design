const { getSession } = require('../services/redis');
const { query } = require('../services/database');

async function requireAuth(req, res, next) {
  const sessionId = req.cookies.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = await getSession(sessionId);
  if (!userId) {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Session expired' });
  }

  req.userId = userId;
  next();
}

async function requireAdmin(req, res, next) {
  const sessionId = req.cookies.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = await getSession(sessionId);
  if (!userId) {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Session expired' });
  }

  const result = await query('SELECT role FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.userId = userId;
  req.userRole = 'admin';
  next();
}

async function optionalAuth(req, res, next) {
  const sessionId = req.cookies.session;

  if (sessionId) {
    const userId = await getSession(sessionId);
    if (userId) {
      req.userId = userId;
    }
  }

  next();
}

module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuth
};
