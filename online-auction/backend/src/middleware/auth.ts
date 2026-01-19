import { getSession } from '../redis.js';
import { query } from '../db.js';

export const authenticate = async (req, res, next) => {
  const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const userId = await getSession(token);

    if (!userId) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const result = await query('SELECT id, username, email, role FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

export const optionalAuth = async (req, res, next) => {
  const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return next();
  }

  try {
    const userId = await getSession(token);

    if (userId) {
      const result = await query('SELECT id, username, email, role FROM users WHERE id = $1', [userId]);

      if (result.rows.length > 0) {
        req.user = result.rows[0];
        req.sessionToken = token;
      }
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
