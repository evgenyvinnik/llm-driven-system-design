/**
 * Job CRUD routes for the job scheduler API.
 * Handles creation, listing, updating, and deletion of jobs.
 * @module api/job-routes
 */

import { Router, Response } from 'express';
import { asyncHandler } from './types';
import { authenticate, authorize } from '../shared/auth';
import { idempotencyMiddleware } from '../shared/idempotency';
import { jobsScheduledTotal } from '../shared/metrics';
import * as db from '../db/repository';
import { ApiResponse, JobStatus } from '../types/index';
import { validateCreateJob, validateUpdateJob } from './validation';

const router = Router();

/**
 * Sends a 404 response when a job is not found.
 *
 * @description Helper function to standardize job not found responses across route handlers.
 *
 * @param res - Express response object to send the 404 response
 */
function notFound(res: Response): void {
  res.status(404).json({ success: false, error: 'Job not found' } as ApiResponse<never>);
}

/** Sends a 400 with the validation problems found in the request body. */
function invalid(res: Response, errors: string[]): void {
  res.status(400).json({ success: false, error: 'Invalid job definition', details: errors });
}

/** True for a PostgreSQL unique-constraint violation (here: jobs.name). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

/**
 * POST /api/v1/jobs - Create a new scheduled job.
 *
 * @description Creates a new job definition with the specified handler, schedule, and configuration.
 * Requires admin authorization. Supports idempotency via the Idempotency-Key header to prevent
 * duplicate job creation on retries.
 *
 * @route POST /api/v1/jobs
 * @access Admin only
 *
 * @param {CreateJobInput} req.body - Job creation parameters
 * @param {string} req.body.name - Unique job name
 * @param {string} req.body.handler - Registered handler identifier
 * @param {string} [req.body.schedule] - Cron expression (UTC) for a recurring job
 * @param {string} [req.body.scheduled_at] - ISO timestamp for a one-time job
 * @param {number} [req.body.priority] - Job priority 0-100 (higher = more urgent)
 * @param {object} [req.body.payload] - JSON payload passed to handler
 * @param {string} [req.body.misfire_policy] - 'fire_once' (default) or 'skip'
 *
 * @returns {ApiResponse<Job>} 201 - Created job object
 * @returns {ApiResponse} 400 - Invalid definition (details lists each problem)
 * @returns {ApiResponse} 409 - Job with same name already exists
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/jobs \
 *   -H "Idempotency-Key: 4f9c2a1e-..." \
 *   -d '{"name": "daily-report", "handler": "http.webhook", "schedule": "0 9 * * *"}'
 * ```
 */
router.post('/', authenticate, authorize('admin'), idempotencyMiddleware(), asyncHandler(async (req, res) => {
  const validation = validateCreateJob(req.body);
  if (!validation.ok) { invalid(res, validation.errors); return; }
  const input = validation.value;

  const conflict = (existingJobId?: string) => {
    res.status(409).json({
      success: false,
      error: `Job with name "${input.name}" already exists`,
      data: existingJobId ? { existingJobId } : undefined,
    } as ApiResponse<{ existingJobId: string }>);
  };

  const existingJob = await db.getJobByName(input.name);
  if (existingJob) { conflict(existingJob.id); return; }

  try {
    const job = await db.createJob(input);
    res.status(201).json({ success: true, data: job, message: 'Job created successfully' } as ApiResponse<typeof job>);
  } catch (error) {
    // Two concurrent creates can both pass the lookup; the unique index decides.
    if (isUniqueViolation(error)) { conflict(); return; }
    throw error;
  }
}));

/**
 * GET /api/v1/jobs - List jobs with pagination and optional filtering.
 *
 * @description Retrieves a paginated list of jobs. Optionally filter by status and include
 * execution statistics for each job. Requires authentication.
 *
 * @route GET /api/v1/jobs
 * @access Authenticated users
 *
 * @param {string} [req.query.page=1] - Page number for pagination
 * @param {string} [req.query.limit=20] - Number of items per page (max 100)
 * @param {JobStatus} [req.query.status] - Filter by job status (active, paused, etc.)
 * @param {string} [req.query.withStats=false] - Include execution statistics if 'true'
 *
 * @returns {ApiResponse<PaginatedResult<Job>>} 200 - Paginated list of jobs
 *
 * @example
 * ```bash
 * # List active jobs with stats
 * curl -X GET '/api/v1/jobs?status=active&withStats=true&page=1&limit=10'
 * ```
 */
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const status = req.query.status as JobStatus | undefined;
  const withStats = req.query.withStats === 'true';

  const result = withStats ? await db.listJobsWithStats(page, limit) : await db.listJobs(page, limit, status);
  res.json({ success: true, data: result } as ApiResponse<typeof result>);
}));

/**
 * GET /api/v1/jobs/:id - Get a single job by ID.
 *
 * @description Retrieves the full details of a specific job including its configuration,
 * schedule, and current status. Requires authentication.
 *
 * @route GET /api/v1/jobs/:id
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the job to retrieve
 *
 * @returns {ApiResponse<Job>} 200 - Job details
 * @returns {ApiResponse} 404 - Job not found
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
 * ```
 */
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job) { notFound(res); return; }
  res.json({ success: true, data: job } as ApiResponse<typeof job>);
}));

/**
 * PUT /api/v1/jobs/:id - Update an existing job.
 *
 * @description Updates a job's configuration including name, handler, schedule, priority,
 * and payload. Partial updates are supported. Requires admin authorization.
 *
 * @route PUT /api/v1/jobs/:id
 * @access Admin only
 *
 * @param {string} req.params.id - UUID of the job to update
 * @param {UpdateJobInput} req.body - Fields to update
 * @param {string} [req.body.name] - Updated job name
 * @param {string} [req.body.handler] - Updated handler identifier
 * @param {string} [req.body.schedule] - Updated cron schedule (next run recomputed)
 * @param {number} [req.body.priority] - Updated priority
 * @param {object} [req.body.payload] - Updated payload
 *
 * @returns {ApiResponse<Job>} 200 - Updated job object
 * @returns {ApiResponse} 400 - Invalid field values
 * @returns {ApiResponse} 404 - Job not found
 *
 * @example
 * curl -X PUT /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000 -d '{"priority": 10}'
 */
router.put('/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const validation = validateUpdateJob(req.body);
  if (!validation.ok) { invalid(res, validation.errors); return; }

  try {
    const job = await db.updateJob(req.params.id, validation.value);
    if (!job) { notFound(res); return; }
    res.json({ success: true, data: job, message: 'Job updated successfully' } as ApiResponse<typeof job>);
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ success: false, error: `Job with name "${validation.value.name}" already exists` });
      return;
    }
    throw error;
  }
}));

/**
 * DELETE /api/v1/jobs/:id - Delete a job and all its executions.
 *
 * @description Permanently deletes a job definition and all associated execution history.
 * Also clears any idempotency keys associated with the job. Requires admin authorization.
 *
 * @route DELETE /api/v1/jobs/:id
 * @access Admin only
 *
 * @param {string} req.params.id - UUID of the job to delete
 *
 * @returns {ApiResponse} 200 - Deletion confirmation
 * @returns {ApiResponse} 404 - Job not found
 *
 * @example
 * ```bash
 * curl -X DELETE /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
 * ```
 */
router.delete('/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job) { notFound(res); return; }

  await db.deleteJob(req.params.id);
  res.json({ success: true, message: 'Job deleted successfully' } as ApiResponse<never>);
}));

/**
 * POST /api/v1/jobs/:id/pause - Pause a scheduled job.
 *
 * @description Pauses a job to prevent it from being scheduled for new executions.
 * The job remains in the database but will not be picked up by the scheduler.
 * Requires admin authorization.
 *
 * @route POST /api/v1/jobs/:id/pause
 * @access Admin only
 *
 * @param {string} req.params.id - UUID of the job to pause
 *
 * @returns {ApiResponse<Job>} 200 - Updated job with paused status
 * @returns {ApiResponse} 404 - Job not found
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/pause
 * ```
 */
router.post('/:id/pause', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const job = await db.pauseJob(req.params.id);
  if (!job) {
    const existing = await db.getJob(req.params.id);
    if (!existing) { notFound(res); return; }
    res.status(409).json({ success: false, error: `Job cannot be paused while ${existing.status}` } as ApiResponse<never>);
    return;
  }
  res.json({ success: true, data: job, message: 'Job paused successfully' } as ApiResponse<typeof job>);
}));

/**
 * POST /api/v1/jobs/:id/resume - Resume a paused job.
 *
 * @description Resumes a previously paused job, allowing it to be scheduled again.
 * Only works on jobs that are currently in paused status.
 * Requires admin authorization.
 *
 * @route POST /api/v1/jobs/:id/resume
 * @access Admin only
 *
 * @param {string} req.params.id - UUID of the job to resume
 *
 * @returns {ApiResponse<Job>} 200 - Updated job with active status
 * @returns {ApiResponse} 404 - Job not found or not in paused state
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/resume
 * ```
 */
router.post('/:id/resume', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const job = await db.resumeJob(req.params.id);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found or not paused' } as ApiResponse<never>);
    return;
  }
  res.json({ success: true, data: job, message: 'Job resumed successfully' } as ApiResponse<typeof job>);
}));

/**
 * POST /api/v1/jobs/:id/trigger - Trigger immediate job execution.
 *
 * @description Manually triggers an immediate execution of the specified job,
 * bypassing the normal cron schedule. Creates a new execution record and enqueues
 * it for immediate processing by workers. Requires authentication.
 *
 * @route POST /api/v1/jobs/:id/trigger
 * @access Authenticated users
 *
 * @param {string} req.params.id - UUID of the job to trigger
 *
 * @returns {ApiResponse<{job: Job, execution: Execution}>} 200 - Job and new execution details
 * @returns {ApiResponse} 404 - Job not found
 *
 * @example
 * ```bash
 * curl -X POST /api/v1/jobs/550e8400-e29b-41d4-a716-446655440000/trigger
 * ```
 */
router.post('/:id/trigger', authenticate, idempotencyMiddleware(), asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);
  if (!job) { notFound(res); return; }
  if (job.status === JobStatus.PAUSED) {
    // Executions of a paused job are held by the claim query; queuing one would only
    // make it run later, on resume, which is not what "Trigger now" means.
    res.status(409).json({ success: false, error: 'Job is paused; resume it before triggering' } as ApiResponse<never>);
    return;
  }

  // The execution row is the queue entry; workers claim it from PostgreSQL.
  const execution = await db.enqueueManualRun(job.id, job.priority);
  jobsScheduledTotal.inc({ handler: job.handler, priority: job.priority.toString() });

  res.json({
    success: true,
    data: { job, execution },
    message: 'Job triggered successfully',
  } as ApiResponse<{ job: typeof job; execution: typeof execution }>);
}));

export { router as jobRoutes };
