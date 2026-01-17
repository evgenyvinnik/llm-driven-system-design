const { getSession } = require('../db/redis');
const { pool } = require('../db/pool');

const authMiddleware = async (req, res, next) => {
  try {
    const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId;

    if (!sessionId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Get user details
    const result = await pool.query(
      'SELECT id, username, email, name, avatar_url, role FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    req.sessionId = sessionId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

module.exports = { authMiddleware, adminMiddleware };
