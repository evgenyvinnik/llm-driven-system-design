import type { Request, Response, NextFunction } from 'express';
import { MerchantService } from '../services/merchant.service.js';
import type { Merchant } from '../types/index.js';

// Extend Express Request to include merchant
declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
    }
  }
}

const merchantService = new MerchantService();

/**
 * API Key authentication middleware
 * Expects: Authorization: Bearer pk_xxx
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const apiKey = authHeader.substring(7); // Remove "Bearer "

    const merchant = await merchantService.authenticateByApiKey(apiKey);

    if (!merchant) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    if (merchant.status !== 'active') {
      res.status(403).json({ error: 'Merchant account is not active' });
      return;
    }

    req.merchant = merchant;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication - doesn't fail if no auth provided
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const apiKey = authHeader.substring(7);
      const merchant = await merchantService.authenticateByApiKey(apiKey);
      if (merchant && merchant.status === 'active') {
        req.merchant = merchant;
      }
    }

    next();
  } catch (error) {
    // Continue without auth on error
    next();
  }
}

/**
 * Idempotency key extraction middleware
 */
export function extractIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (idempotencyKey) {
    req.body.idempotency_key = idempotencyKey;
  }

  next();
}

/**
 * Request logging middleware
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );
  });

  next();
}

/**
 * Error handling middleware
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error('Error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}
