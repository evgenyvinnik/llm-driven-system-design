/**
 * Execution handling routes for the job scheduler API.
 * Handles listing, viewing, cancelling, and retrying job executions.
 * @module api/execution-routes
 */

import { Router } from 'express';
import { asyncHandler } from './types';
import { authenticate, authorize } from '../shared/auth';
import { idempotencyMiddleware } from '../shared/idempotency';
import * as db from '../db/repository';
import { ApiResponse, ExecutionStatus } from '../types/index';

const router = Router();

/**
 * GET /api/v1/jobs/:id/executions - List executions for a specific job.
 *
 * @description Retrieves a paginated list of execution records for a given job.
 * Optionally filter by execution status. Requires authentication.
 *
 * @route GET /api/v1/jobs/:id/executions
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the job to list executions for
 * @param {string} [req.query.page=1] - Page number for pagination
 * @param {string} [req.query.limit=20] - Number of items per page (max 100)
 * @param {ExecutionStatus} [req.query.status] - Filter by execution status
 *
 * @returns {ApiResponse<PaginatedResult<Execution>>} 200 - Paginated list of executions
 *
 * @example
 * ```bash
 * curl -X GET '/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/executions?status=completed&page=1'
 * ```
 */
router.get(
  '/jobs/:id/executions',
  authenticate,
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const status = req.query.status as ExecutionStatus | undefined;

    const result = await db.listExecutions(req.params.id, page, limit, status);

    res.json({
      success: true,
      data: result,
    } as ApiResponse<typeof result>);
  })
);

/**
 * GET /api/v1/executions/:id - Get execution details with logs.
 *
 * @description Retrieves detailed information about a specific execution including
 * status, timing, error messages, and execution logs. Requires authentication.
 *
 * @route GET /api/v1/executions/:id
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the execution to retrieve
 *
 * @returns {ApiResponse<Execution & {logs: ExecutionLog[]}>} 200 - Execution details with logs
 * @returns {ApiResponse} 404 - Execution not found
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/executions/660e8400-e29b-41d4-a716-446655440001
 * ```
 */
router.get(
  '/executions/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const execution = await db.getExecution(req.params.id);

    if (!execution) {
      res.status(404).json({
        success: false,
        error: 'Execution not found',
      } as ApiResponse<never>);
      return;
    }

    // Get logs
    const logs = await db.getExecutionLogs(req.params.id);

    res.json({
      success: true,
      data: { ...execution, logs },
    } as ApiResponse<typeof execution & { logs: typeof logs }>);
  })
);

/**
 * POST /api/v1/executions/:id/cancel - Cancel a pending or running execution.
 *
 * @description Cancels an execution that is currently pending or running. Cannot cancel
 * executions that have already completed, failed, or been cancelled. Requires admin
 * authorization.
 *
 * @route POST /api/v1/executions/:id/cancel
 * @access Admin only
 *
 * @param {string} req.params.id - UUID of the execution to cancel
 *
 * A RUNNING execution is stopped cooperatively: its worker's next lease renewal finds
 * the row CANCELLED, aborts the handler, and any result it still produces is rejected
 * by the fenced completion write.
 *
 * @returns {ApiResponse<Execution>} 200 - Updated execution with cancelled status
 * @returns {ApiResponse} 404 - Execution not found
 * @returns {ApiResponse} 409 - Execution is not PENDING or RUNNING
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/executions/660e8400-e29b-41d4-a716-446655440001/cancel
 * ```
 */
router.post(
  '/executions/:id/cancel',
  authenticate,
  authorize('admin'),
  asyncHandler(async (req, res) => {
    // One guarded UPDATE: the state check and the write cannot be split by a worker
    // completing the execution in between.
    const updated = await db.cancelExecution(req.params.id);

    if (!updated) {
      const execution = await db.getExecution(req.params.id);
      res.status(execution ? 409 : 404).json({
        success: false,
        error: execution
          ? `Execution cannot be cancelled while ${execution.status}`
          : 'Execution not found',
      } as ApiResponse<never>);
      return;
    }

    res.json({
      success: true,
      data: updated,
      message: 'Execution cancelled successfully',
    } as ApiResponse<typeof updated>);
  })
);

/**
 * POST /api/v1/executions/:id/retry - Retry a failed or cancelled execution.
 *
 * @description Runs the same scheduled run again as its next attempt (same job and slot,
 * attempt + 1). Works on the latest FAILED, CANCELLED or DEAD_LETTER attempt; a
 * dead-lettered row leaves the dead-letter state. Accepts an Idempotency-Key header, and
 * a second request for an already-redriven run gets 409. Requires authentication.
 *
 * @route POST /api/v1/executions/:id/retry
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the execution to retry
 *
 * @returns {ApiResponse<Execution>} 200 - Newly created attempt
 * @returns {ApiResponse} 404 - Execution not found
 * @returns {ApiResponse} 409 - Not in a retryable state, or a newer attempt exists
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/executions/660e8400-e29b-41d4-a716-446655440001/retry
 * ```
 */
router.post(
  '/executions/:id/retry',
  authenticate,
  idempotencyMiddleware(),
  asyncHandler(async (req, res) => {
    const result = await db.redriveExecution(req.params.id);

    if (!result.ok) {
      const errors = {
        not_found: [404, 'Execution not found'],
        not_retryable: [409, 'Only failed, cancelled or dead-lettered executions can be retried'],
        superseded: [409, 'A newer attempt of this run already exists; retry that one instead'],
      } as const;
      const [status, error] = errors[result.reason];
      res.status(status).json({ success: false, error } as ApiResponse<never>);
      return;
    }

    res.json({
      success: true,
      data: result.execution,
      message: 'Retry scheduled successfully',
    } as ApiResponse<typeof result.execution>);
  })
);

export { router as executionRoutes };
