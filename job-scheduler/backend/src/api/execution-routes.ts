/**
 * Execution handling routes for the job scheduler API.
 * Handles listing, viewing, cancelling, and retrying job executions.
 * @module api/execution-routes
 */

import { Router } from 'express';
import { asyncHandler } from './types';
import { authenticate, authorize } from '../shared/auth';
import * as db from '../db/repository';
import { queue } from '../queue/reliable-queue';
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
 * @returns {ApiResponse<Execution>} 200 - Updated execution with cancelled status
 * @returns {ApiResponse} 400 - Execution cannot be cancelled in current state
 * @returns {ApiResponse} 404 - Execution not found
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
    const execution = await db.getExecution(req.params.id);

    if (!execution) {
      res.status(404).json({
        success: false,
        error: 'Execution not found',
      } as ApiResponse<never>);
      return;
    }

    if (
      execution.status !== ExecutionStatus.PENDING &&
      execution.status !== ExecutionStatus.RUNNING
    ) {
      res.status(400).json({
        success: false,
        error: 'Execution cannot be cancelled in current state',
      } as ApiResponse<never>);
      return;
    }

    const updated = await db.updateExecution(req.params.id, {
      status: ExecutionStatus.CANCELLED,
      completed_at: new Date(),
      error: 'Cancelled by user',
    });

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
 * @description Creates a new execution for the same job and enqueues it for processing.
 * Only failed or cancelled executions can be retried. The original execution remains
 * unchanged in the history. Requires authentication.
 *
 * @route POST /api/v1/executions/:id/retry
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the execution to retry
 *
 * @returns {ApiResponse<Execution>} 200 - Newly created execution
 * @returns {ApiResponse} 400 - Execution is not in a retriable state
 * @returns {ApiResponse} 404 - Execution or associated job not found
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/executions/660e8400-e29b-41d4-a716-446655440001/retry
 * ```
 */
router.post(
  '/executions/:id/retry',
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

    if (
      execution.status !== ExecutionStatus.FAILED &&
      execution.status !== ExecutionStatus.CANCELLED
    ) {
      res.status(400).json({
        success: false,
        error: 'Only failed or cancelled executions can be retried',
      } as ApiResponse<never>);
      return;
    }

    const job = await db.getJob(execution.job_id);
    if (!job) {
      res.status(404).json({
        success: false,
        error: 'Job not found',
      } as ApiResponse<never>);
      return;
    }

    // Create a new execution
    const newExecution = await db.createExecution(job.id, new Date());
    await queue.enqueue(newExecution.id, job.id, job.priority);

    res.json({
      success: true,
      data: newExecution,
      message: 'Retry scheduled successfully',
    } as ApiResponse<typeof newExecution>);
  })
);

export { router as executionRoutes };
