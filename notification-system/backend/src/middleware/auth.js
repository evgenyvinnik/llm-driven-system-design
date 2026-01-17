import { query } from '../utils/database.js';
import { redis } from '../utils/redis.js';

export async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);

    // Check session in Redis first
    let session = await redis.get(`session:${token}`);

    if (session) {
      session = JSON.parse(session);
    } else {
      // Fall back to database
      const result = await query(
        `SELECT s.*, u.email, u.name, u.role
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      session = result.rows[0];

      // Cache in Redis for 5 minutes
      await redis.setex(
        `session:${token}`,
        300,
        JSON.stringify(session)
      );
    }

    req.user = {
      id: session.user_id,
      email: session.email,
      name: session.name,
      role: session.role,
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

export function adminMiddleware(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
