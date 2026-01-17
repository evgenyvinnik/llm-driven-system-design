import { getSession } from '../services/auth.js';
import { query } from '../db.js';

export const authenticate = async (req, res, next) => {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const session = await getSession(sessionId);

    if (!session) {
      res.clearCookie('session');
      return res.status(401).json({ error: 'Session expired' });
    }

    // Get user from database
    const result = await query(
      'SELECT id, email, name, avatar_url, is_host, is_verified, role FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
};

export const optionalAuth = async (req, res, next) => {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    return next();
  }

  try {
    const session = await getSession(sessionId);

    if (session) {
      const result = await query(
        'SELECT id, email, name, avatar_url, is_host, is_verified, role FROM users WHERE id = $1',
        [session.userId]
      );

      if (result.rows.length > 0) {
        req.user = result.rows[0];
      }
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
};

export const requireHost = (req, res, next) => {
  if (!req.user?.is_host) {
    return res.status(403).json({ error: 'Must be a host to access this resource' });
  }
  next();
};

export const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
