import { getSession } from '../redis.js';
import { query } from '../db.js';

export async function authenticateRequest(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);
    const session = await getSession(token);

    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Get user details
    const result = await query(
      'SELECT id, username, email, display_name, avatar_url FROM users WHERE id = $1',
      [session.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = result.rows[0];
    req.session = session;
    req.deviceId = session.deviceId;

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

export async function authenticateWs(token) {
  if (!token) {
    return null;
  }

  const session = await getSession(token);
  if (!session) {
    return null;
  }

  const result = await query(
    'SELECT id, username, email, display_name, avatar_url FROM users WHERE id = $1',
    [session.userId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return {
    user: result.rows[0],
    session,
    deviceId: session.deviceId,
  };
}
