import type { Request, Response, NextFunction } from 'express';
import { MerchantService } from '../services/merchant.service.js';
import type { Merchant } from '../types/index.js';
import { logger, createChildLogger } from '../shared/index.js';

/**
 * Extends Express Request interface to include authenticated merchant.
 * The merchant property is populated by authentication middleware.
 */
declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
      requestId?: string;
    }
  }
}

const merchantService = new MerchantService();

/**
 * Generates a unique request ID for tracing.
 */
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Authenticates requests using API key in the Authorization header.
 * Required for all protected payment and merchant endpoints.
 * Expects format: "Authorization: Bearer pk_xxx"
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn(
        { path: req.path, ip: req.ip },
        'Missing or invalid Authorization header'
      );
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const apiKey = authHeader.substring(7); // Remove "Bearer "

    const merchant = await merchantService.authenticateByApiKey(apiKey);

    if (!merchant) {
      logger.warn(
        { path: req.path, ip: req.ip },
        'Invalid API key'
      );
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    if (merchant.status !== 'active') {
      logger.warn(
        { merchantId: merchant.id, status: merchant.status },
        'Merchant account is not active'
      );
      res.status(403).json({ error: 'Merchant account is not active' });
      return;
    }

    req.merchant = merchant;
    next();
  } catch (error) {
    logger.error({ error }, 'Authentication error');
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Optional authentication middleware that doesn't fail if no auth is provided.
 * Populates req.merchant if valid credentials are present, continues otherwise.
 * Useful for endpoints that behave differently for authenticated vs anonymous users.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
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
 * Extracts idempotency key from request headers and adds it to the request body.
 * Used to prevent duplicate payment processing on network retries.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
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
 * Logs all incoming requests with timing information using structured JSON logging.
 * Records HTTP method, path, status code, and response duration.
 *
 * Log format (JSON):
 * - time: ISO 8601 timestamp
 * - level: info/warn/error
 * - requestId: Unique request identifier
 * - method: HTTP method
 * - path: Request path
 * - statusCode: HTTP response status
 * - duration_ms: Response time in milliseconds
 * - merchantId: Authenticated merchant ID (if present)
 * - ip: Client IP address
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] as string || generateRequestId();

  // Attach request ID to request object
  req.requestId = requestId;

  // Add request ID to response headers for tracing
  res.setHeader('X-Request-ID', requestId);

  // Create child logger with request context
  const reqLogger = createChildLogger({
    requestId,
    method: req.method,
    path: req.path,
  });

  // Log request start at debug level
  reqLogger.debug({ ip: req.ip }, 'Request started');

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      statusCode: res.statusCode,
      duration_ms: duration,
      merchantId: req.merchant?.id,
      ip: req.ip,
    };

    // Log at different levels based on status code
    if (res.statusCode >= 500) {
      reqLogger.error(logData, 'Request completed with server error');
    } else if (res.statusCode >= 400) {
      reqLogger.warn(logData, 'Request completed with client error');
    } else {
      reqLogger.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Global error handler for uncaught exceptions in route handlers.
 * Returns sanitized error messages in production, detailed messages in development.
 *
 * Logs errors with full stack trace for debugging.
 *
 * @param err - Error object thrown by route handlers
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error(
    {
      error: err,
      stack: err.stack,
      requestId: req.requestId,
      path: req.path,
      method: req.method,
      merchantId: req.merchant?.id,
    },
    'Unhandled error'
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId,
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}
