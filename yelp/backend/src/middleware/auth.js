import { sessions } from '../utils/redis.js';
import { pool } from '../utils/db.js';

// Authenticate user from session token
export async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    const session = await sessions.get(token);
    if (!session) {
      return res.status(401).json({ error: { message: 'Invalid or expired session' } });
    }

    // Get user from database
    const result = await pool.query(
      'SELECT id, email, name, avatar_url, role, review_count FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: { message: 'User not found' } });
    }

    req.user = result.rows[0];
    req.sessionToken = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: { message: 'Authentication failed' } });
  }
}

// Optional authentication - doesn't fail if not authenticated
export async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies?.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const session = await sessions.get(token);
      if (session) {
        const result = await pool.query(
          'SELECT id, email, name, avatar_url, role, review_count FROM users WHERE id = $1',
          [session.userId]
        );
        if (result.rows.length > 0) {
          req.user = result.rows[0];
          req.sessionToken = token;
        }
      }
    }
    next();
  } catch (error) {
    console.error('Optional auth error:', error);
    next();
  }
}

// Require specific roles
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { message: 'Insufficient permissions' } });
    }

    next();
  };
}

// Require admin role
export const requireAdmin = requireRole('admin');

// Require business owner or admin
export const requireBusinessOwner = requireRole('business_owner', 'admin');
