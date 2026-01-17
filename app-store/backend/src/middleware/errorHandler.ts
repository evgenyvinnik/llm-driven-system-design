/**
 * @fileoverview Error handling middleware for Express.
 * Provides centralized error handling and async wrapper utilities.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Global error handler middleware.
 * Maps error messages to appropriate HTTP status codes.
 * @param err - Error object thrown by route handlers
 * @param req - Express request
 * @param res - Express response
 * @param _next - Next function (unused but required for Express error handlers)
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  console.error('Error:', err);

  if (err.message.includes('already exists') || err.message.includes('already reviewed')) {
    res.status(409).json({ error: err.message });
    return;
  }

  if (err.message.includes('Invalid') || err.message.includes('not found')) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message.includes('Not authorized') || err.message.includes('Insufficient')) {
    res.status(403).json({ error: err.message });
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}

/**
 * Wraps async route handlers to automatically catch errors.
 * Eliminates try-catch boilerplate in route handlers.
 * @param fn - Async route handler function
 * @returns Wrapped function that forwards errors to Express error handler
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Not Found handler for unmatched routes.
 * Should be registered after all other routes.
 * @param req - Express request
 * @param res - Express response
 */
export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
