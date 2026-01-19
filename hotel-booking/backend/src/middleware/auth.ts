import { Request, Response, NextFunction } from 'express';
import authService, { User } from '../services/authService.js';
import { query } from '../models/db.js';

// Extend Express Request to include user and token properties
declare global {
  namespace Express {
    interface Request {
      user?: User;
      token?: string;
    }
  }
}

// Authentication middleware
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const user = await authService.validateSession(token);

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// Optional authentication middleware
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.substring(7);

  try {
    const user = await authService.validateSession(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
}

// Role-based authorization middleware
export function requireRole(
  ...roles: string[]
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

// Hotel admin middleware (must own the hotel or be admin)
export function requireHotelOwner(
  hotelIdParam: string = 'hotelId'
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // System admin can access all hotels
    if (req.user.role === 'admin') {
      next();
      return;
    }

    // Hotel admin must own the hotel
    if (req.user.role !== 'hotel_admin') {
      res.status(403).json({ error: 'Hotel admin access required' });
      return;
    }

    // hotelIdParam can be in params or body
    const hotelId = req.params[hotelIdParam] || (req.body as Record<string, unknown>).hotelId;

    if (!hotelId) {
      res.status(400).json({ error: 'Hotel ID required' });
      return;
    }

    const result = await query<{ id: string }>(
      'SELECT id FROM hotels WHERE id = $1 AND owner_id = $2',
      [hotelId, req.user.id]
    );

    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Access denied to this hotel' });
      return;
    }

    next();
  };
}

export default {
  authenticate,
  optionalAuth,
  requireRole,
  requireHotelOwner,
};
