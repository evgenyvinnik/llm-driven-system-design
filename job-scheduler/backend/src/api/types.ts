/**
 * Shared types and interfaces for the API module.
 * Provides route-specific types and utility functions.
 * @module api/types
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Express async route handler type.
 * Wraps handlers that return Promises for proper error catching.
 */
export type AsyncHandler = (
  req: Request,
  res: Response
) => Promise<void>;

/**
 * Express middleware type for route handlers.
 */
export type RouteMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => void;

/**
 * Wraps async route handlers to properly catch and forward errors.
 * Prevents unhandled promise rejections by forwarding them to Express error middleware.
 *
 * @description Wraps an async Express route handler to ensure any rejected promises
 * are caught and passed to the next() error handler, enabling centralized error handling.
 *
 * @param fn - The async route handler function to wrap
 * @returns Express middleware function that catches promise rejections and forwards to error handler
 *
 * @example
 * ```typescript
 * router.get('/users', asyncHandler(async (req, res) => {
 *   const users = await db.getUsers();
 *   res.json({ success: true, data: users });
 * }));
 * ```
 */
export function asyncHandler(
  fn: AsyncHandler
): RouteMiddleware {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Health check response data structure.
 */
export interface HealthCheckData {
  db: boolean;
  redis: boolean;
  uptime: number;
  version: string;
}

/**
 * Worker info as returned from Redis.
 */
export interface WorkerData {
  id: string;
  status: 'idle' | 'busy';
  current_execution_id: string | null;
  last_heartbeat: string;
  jobs_completed: number;
  jobs_failed: number;
}

/**
 * System metrics response data structure for the dashboard.
 */
export interface SystemMetricsData {
  jobs: {
    total_jobs: number;
    active_jobs: number;
    queued_executions: number;
    running_executions: number;
    completed_24h: number;
    failed_24h: number;
  };
  queue: {
    queued: number;
    processing: number;
    deadLetter: number;
  };
  workers: {
    active: number;
    total: number;
  };
  circuitBreakers: Record<string, unknown>;
}
