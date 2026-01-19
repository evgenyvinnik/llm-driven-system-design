import { getSession } from '../services/redis.js';
import { query } from '../services/database.js';

export async function authMiddleware(req, res, next) {
  try {
    const sessionId = req.headers['x-session-id'] || req.headers.authorization?.replace('Bearer ', '');

    if (!sessionId) {
      req.user = null;
      return next();
    }

    const session = await getSession(sessionId);
    if (!session) {
      req.user = null;
      return next();
    }

    // Get fresh user data
    const result = await query(
      'SELECT id, email, name, role FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      req.user = null;
      return next();
    }

    req.user = result.rows[0];
    req.sessionId = sessionId;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    req.user = null;
    next();
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export function requireSeller(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'seller' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Seller access required' });
  }
  next();
}
