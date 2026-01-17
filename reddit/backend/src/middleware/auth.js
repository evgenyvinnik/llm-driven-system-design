import { getSession, findUserById } from '../models/user.js';

export const authenticate = async (req, res, next) => {
  const sessionId = req.cookies?.session || req.headers['x-session-id'];

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

    const user = await findUserById(session.userId);
    req.user = user || null;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    req.user = null;
    next();
  }
};

export const requireAuth = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
