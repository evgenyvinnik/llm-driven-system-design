/**
 * REST API server for the job scheduler.
 * Provides endpoints for managing jobs, executions, workers, and system metrics.
 * Used by the frontend dashboard and can be consumed by external clients.
 * @module api/server
 */

import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { logger } from '../utils/logger';
import { migrate } from '../db/migrate';
import { healthCheck as dbHealthCheck } from '../db/pool';
import { healthCheck as redisHealthCheck } from '../queue/redis';
import * as db from '../db/repository';
import { queue } from '../queue/reliable-queue';
import {
  ApiResponse,
  CreateJobInput,
  UpdateJobInput,
  JobStatus,
  ExecutionStatus,
} from '../types';

/** Express application instance */
const app = express();
/** API server port from environment */
const PORT = process.env.PORT || 3001;

// Middleware configuration
app.use(cors());
app.use(express.json());

/**
 * Request logging middleware.
 * Logs method, URL, status, and response time for all requests.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration,
    });
  });
  next();
});

/**
 * Wraps async route handlers to properly catch and forward errors.
 * @param fn - Async route handler function
 * @returns Express middleware that catches promise rejections
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// === Health Check Endpoints ===

/** GET /api/v1/health - Check database and Redis connectivity */
app.get('/api/v1/health', asyncHandler(async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);

  const healthy = dbOk && redisOk;
  const response: ApiResponse<{ db: boolean; redis: boolean }> = {
    success: healthy,
    data: { db: dbOk, redis: redisOk },
  };

  res.status(healthy ? 200 : 503).json(response);
}));

// === Job Management Endpoints ===

/** POST /api/v1/jobs - Create a new job */
app.post('/api/v1/jobs', asyncHandler(async (req, res) => {
  const input: CreateJobInput = req.body;

  // Validate required fields
  if (!input.name || !input.handler) {
    res.status(400).json({
      success: false,
      error: 'Name and handler are required',
    } as ApiResponse<never>);
    return;
  }

  const job = await db.createJob(input);
  res.status(201).json({
    success: true,
    data: job,
    message: 'Job created successfully',
  } as ApiResponse<typeof job>);
}));

/** GET /api/v1/jobs - List jobs with pagination and optional filtering */
app.get('/api/v1/jobs', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const status = req.query.status as JobStatus | undefined;
  const withStats = req.query.withStats === 'true';

  const result = withStats
    ? await db.listJobsWithStats(page, limit)
    : await db.listJobs(page, limit, status);

  res.json({
    success: true,
    data: result,
  } as ApiResponse<typeof result>);
}));

/** GET /api/v1/jobs/:id - Get a single job by ID */
app.get('/api/v1/jobs/:id', asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  res.json({
    success: true,
    data: job,
  } as ApiResponse<typeof job>);
}));

/** PUT /api/v1/jobs/:id - Update an existing job */
app.put('/api/v1/jobs/:id', asyncHandler(async (req, res) => {
  const input: UpdateJobInput = req.body;
  const job = await db.updateJob(req.params.id, input);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  res.json({
    success: true,
    data: job,
    message: 'Job updated successfully',
  } as ApiResponse<typeof job>);
}));

/** DELETE /api/v1/jobs/:id - Delete a job and its executions */
app.delete('/api/v1/jobs/:id', asyncHandler(async (req, res) => {
  const deleted = await db.deleteJob(req.params.id);

  if (!deleted) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  res.json({
    success: true,
    message: 'Job deleted successfully',
  } as ApiResponse<never>);
}));

/** POST /api/v1/jobs/:id/pause - Pause a job */
app.post('/api/v1/jobs/:id/pause', asyncHandler(async (req, res) => {
  const job = await db.pauseJob(req.params.id);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  res.json({
    success: true,
    data: job,
    message: 'Job paused successfully',
  } as ApiResponse<typeof job>);
}));

/** POST /api/v1/jobs/:id/resume - Resume a paused job */
app.post('/api/v1/jobs/:id/resume', asyncHandler(async (req, res) => {
  const job = await db.resumeJob(req.params.id);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found or not paused',
    } as ApiResponse<never>);
    return;
  }

  res.json({
    success: true,
    data: job,
    message: 'Job resumed successfully',
  } as ApiResponse<typeof job>);
}));

/** POST /api/v1/jobs/:id/trigger - Trigger immediate job execution */
app.post('/api/v1/jobs/:id/trigger', asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  // Create an execution
  const execution = await db.createExecution(job.id, new Date());

  // Enqueue it immediately
  await queue.enqueue(execution.id, job.id, job.priority);

  // Update job status
  await db.updateJobStatus(job.id, JobStatus.QUEUED);

  res.json({
    success: true,
    data: { job, execution },
    message: 'Job triggered successfully',
  } as ApiResponse<{ job: typeof job; execution: typeof execution }>);
}));

// === Execution Management Endpoints ===

/** GET /api/v1/jobs/:id/executions - List executions for a specific job */
app.get('/api/v1/jobs/:id/executions', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const status = req.query.status as ExecutionStatus | undefined;

  const result = await db.listExecutions(req.params.id, page, limit, status);

  res.json({
    success: true,
    data: result,
  } as ApiResponse<typeof result>);
}));

/** GET /api/v1/executions/:id - Get execution details with logs */
app.get('/api/v1/executions/:id', asyncHandler(async (req, res) => {
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
}));

/** POST /api/v1/executions/:id/cancel - Cancel a pending or running execution */
app.post('/api/v1/executions/:id/cancel', asyncHandler(async (req, res) => {
  const execution = await db.getExecution(req.params.id);

  if (!execution) {
    res.status(404).json({
      success: false,
      error: 'Execution not found',
    } as ApiResponse<never>);
    return;
  }

  if (execution.status !== ExecutionStatus.PENDING && execution.status !== ExecutionStatus.RUNNING) {
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
}));

/** POST /api/v1/executions/:id/retry - Retry a failed or cancelled execution */
app.post('/api/v1/executions/:id/retry', asyncHandler(async (req, res) => {
  const execution = await db.getExecution(req.params.id);

  if (!execution) {
    res.status(404).json({
      success: false,
      error: 'Execution not found',
    } as ApiResponse<never>);
    return;
  }

  if (execution.status !== ExecutionStatus.FAILED && execution.status !== ExecutionStatus.CANCELLED) {
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
}));

// === Metrics & Monitoring Endpoints ===

/** GET /api/v1/metrics - Get aggregated system metrics */
app.get('/api/v1/metrics', asyncHandler(async (req, res) => {
  const [dbMetrics, queueStats] = await Promise.all([
    db.getSystemMetrics(),
    queue.getStats(),
  ]);

  // Get worker count from Redis
  const { redis } = await import('../queue/redis');
  const workers = await redis.hgetall('job_scheduler:workers');
  const activeWorkers = Object.values(workers).filter((w) => {
    const worker = JSON.parse(w);
    const lastHeartbeat = new Date(worker.last_heartbeat);
    const isRecent = Date.now() - lastHeartbeat.getTime() < 60000; // 1 minute
    return isRecent;
  }).length;

  res.json({
    success: true,
    data: {
      jobs: dbMetrics,
      queue: queueStats,
      workers: {
        active: activeWorkers,
        total: Object.keys(workers).length,
      },
    },
  } as ApiResponse<{
    jobs: typeof dbMetrics;
    queue: typeof queueStats;
    workers: { active: number; total: number };
  }>);
}));

/** GET /api/v1/metrics/executions - Get hourly execution statistics */
app.get('/api/v1/metrics/executions', asyncHandler(async (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const stats = await db.getExecutionStats(hours);

  res.json({
    success: true,
    data: stats,
  } as ApiResponse<typeof stats>);
}));

/** GET /api/v1/workers - Get list of registered workers */
app.get('/api/v1/workers', asyncHandler(async (req, res) => {
  const { redis } = await import('../queue/redis');
  const workers = await redis.hgetall('job_scheduler:workers');

  const workerList = Object.values(workers).map((w) => JSON.parse(w));

  res.json({
    success: true,
    data: workerList,
  } as ApiResponse<typeof workerList>);
}));

/** GET /api/v1/dead-letter - Get items from the dead letter queue */
app.get('/api/v1/dead-letter', asyncHandler(async (req, res) => {
  const start = parseInt(req.query.start as string) || 0;
  const count = parseInt(req.query.count as string) || 100;

  const items = await queue.getDeadLetterItems(start, start + count - 1);

  res.json({
    success: true,
    data: items,
  } as ApiResponse<typeof items>);
}));

/**
 * Global error handler middleware.
 * Logs unhandled errors and returns a standardized error response.
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  } as ApiResponse<never>);
});

/**
 * Starts the API server.
 * Runs database migrations before listening for requests.
 */
async function start() {
  // Run migrations
  await migrate();

  app.listen(PORT, () => {
    logger.info(`API server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  logger.error('Failed to start API server', error);
  process.exit(1);
});

export { app };
