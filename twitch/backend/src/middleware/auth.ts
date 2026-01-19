import { Request, Response, NextFunction } from 'express';
import { getSession } from '../services/redis.js';
import { query } from '../services/database.js';

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.cookies.session as string | undefined;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const userId = await getSession(sessionId);
  if (!userId) {
    res.clearCookie('session');
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  req.userId = userId;
  next();
}

async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.cookies.session as string | undefined;

  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const userId = await getSession(sessionId);
  if (!userId) {
    res.clearCookie('session');
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  const result = await query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  req.userId = userId;
  req.userRole = 'admin';
  next();
}

async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sessionId = req.cookies.session as string | undefined;

  if (sessionId) {
    const userId = await getSession(sessionId);
    if (userId) {
      req.userId = userId;
    }
  }

  next();
}

export {
  requireAuth,
  requireAdmin,
  optionalAuth
};
