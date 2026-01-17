import { getSession, getUserById } from '../services/auth.js';

export async function authMiddleware(req, res, next) {
  const sessionId = req.cookies?.session;

  if (!sessionId) {
    req.user = null;
    return next();
  }

  try {
    const session = await getSession(sessionId);
    if (!session) {
      req.user = null;
      return next();
    }

    const user = await getUserById(session.userId);
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
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

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
