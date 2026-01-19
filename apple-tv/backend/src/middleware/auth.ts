import { Request, Response, NextFunction } from 'express';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId: string;
    email: string;
    name: string;
    role: string;
    subscriptionTier: string;
    subscriptionExpiresAt: Date | string;
    profileId?: string;
    profileName?: string;
    isKids?: boolean;
  }
}

export const isAuthenticated = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.session && req.session.userId) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
};

export const isAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.session && req.session.role === 'admin') {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden' });
};

export const hasSubscription = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.session && req.session.subscriptionTier && req.session.subscriptionTier !== 'free') {
    const expiresAt = new Date(req.session.subscriptionExpiresAt as string);
    if (expiresAt > new Date()) {
      next();
      return;
    }
  }
  res.status(403).json({ error: 'Subscription required' });
};
