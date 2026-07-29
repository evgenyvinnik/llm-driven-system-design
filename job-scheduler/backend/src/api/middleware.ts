/**
 * Express middleware for the job scheduler API.
 * Includes logging, error handling, and request tracking.
 * @module api/middleware
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ApiResponse } from '../types/index';

/**
 * Request logging middleware.
 * Logs HTTP method, URL path, status code, and response time for all requests.
 *
 * @description Attaches a listener to the response 'finish' event to capture
 * timing information and log request details once the response is complete.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function to pass control to the next middleware
 *
 * @example
 * ```typescript
 * app.use(requestLogger);
 * ```
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
        duration,
        userId: req.user?.userId,
      },
      `${req.method} ${req.path}`
    );
  });
  next();
}

/**
 * Global error handler middleware.
 * Logs unhandled errors and returns a standardized JSON error response.
 *
 * @description Catches any errors that propagate through the Express middleware chain,
 * logs them with context, and returns a 500 response. In development mode, the error
 * message is included in the response.
 *
 * @param err - The error object that was thrown or passed to next()
 * @param req - Express request object
 * @param res - Express response object
 * @param _next - Express next function (unused but required for Express error handler signature)
 *
 * @example
 * ```typescript
 * // Must be registered after all routes
 * app.use(errorHandler);
 * ```
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  } as ApiResponse<never>);
}

/**
 * Not found handler for unmatched routes.
 *
 * @description Returns a 404 JSON response when a request does not match any defined route.
 * Should be registered after all other routes in the Express application.
 *
 * @param req - Express request object containing the unmatched route info
 * @param res - Express response object used to send the 404 response
 *
 * @example
 * ```typescript
 * // Register after all routes, before error handler
 * app.use(notFoundHandler);
 * ```
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
  } as ApiResponse<never>);
}
