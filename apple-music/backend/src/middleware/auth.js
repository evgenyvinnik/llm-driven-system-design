import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';

export async function authenticate(req, res, next) {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check Redis for session
    const sessionData = await redis.get(`session:${token}`);

    if (!sessionData) {
      // Fallback to database
      const result = await pool.query(
        `SELECT s.*, u.id as user_id, u.email, u.username, u.display_name, u.role,
                u.subscription_tier, u.preferred_quality
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      const session = result.rows[0];

      // Cache in Redis
      await redis.setex(
        `session:${token}`,
        3600, // 1 hour
        JSON.stringify({
          userId: session.user_id,
          email: session.email,
          username: session.username,
          displayName: session.display_name,
          role: session.role,
          subscriptionTier: session.subscription_tier,
          preferredQuality: session.preferred_quality
        })
      );

      req.user = {
        id: session.user_id,
        email: session.email,
        username: session.username,
        displayName: session.display_name,
        role: session.role,
        subscriptionTier: session.subscription_tier,
        preferredQuality: session.preferred_quality
      };
    } else {
      req.user = JSON.parse(sessionData);
      req.user.id = req.user.userId;
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies.session_token || req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const sessionData = await redis.get(`session:${token}`);

      if (sessionData) {
        req.user = JSON.parse(sessionData);
        req.user.id = req.user.userId;
      }
    }

    next();
  } catch (error) {
    // Continue without auth
    next();
  }
}

export async function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
