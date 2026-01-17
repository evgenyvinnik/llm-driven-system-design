import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * Global error handler middleware for Express.
 * Catches all errors thrown in route handlers and returns appropriate HTTP responses.
 * Maps error messages to status codes (409 for conflicts, 400 for validation, 404 for not found).
 * @param err - The error object thrown
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function (unused but required by Express)
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error({ err, path: req.path, action: 'error' }, `Error: ${err.message}`);

  // Handle known error types
  if (err.message.includes('already')) {
    res.status(409).json({ error: err.message });
    return;
  }

  if (err.message.includes('Invalid') || err.message.includes('required')) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message.includes('not found')) {
    res.status(404).json({ error: err.message });
    return;
  }

  // Default error
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Handler for 404 Not Found responses.
 * Mounted after all routes to catch requests to undefined endpoints.
 * @param req - Express request object
 * @param res - Express response object
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: 'Endpoint not found' });
}

/**
 * Request logging middleware for monitoring and debugging.
 * Logs method, path, status code, duration, and client IP for each request.
 * Uses pino logger with structured output format.
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

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: duration,
        ip: req.ip,
        action: 'request',
      },
      `${req.method} ${req.path}`
    );
  });

  next();
}
