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

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
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

// Error handler wrapper
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// Health check endpoints
app.get('/api/v1/health', asyncHandler(async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);

  const healthy = dbOk && redisOk;
  const response: ApiResponse<{ db: boolean; redis: boolean }> = {
    success: healthy,
    data: { db: dbOk, redis: redisOk },
  };

  res.status(healthy ? 200 : 503).json(response);
}));

// === Job Management ===

// Create a job
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

// List jobs
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

// Get a job by ID
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

// Update a job
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

// Delete a job
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

// Pause a job
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

// Resume a job
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

// Trigger immediate execution
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

// === Execution Management ===

// List executions for a job
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

// Get execution details
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

// Cancel an execution
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

// Retry a failed execution
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

// === Metrics & Monitoring ===

// Get system metrics
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

// Get execution statistics
app.get('/api/v1/metrics/executions', asyncHandler(async (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const stats = await db.getExecutionStats(hours);

  res.json({
    success: true,
    data: stats,
  } as ApiResponse<typeof stats>);
}));

// Get workers
app.get('/api/v1/workers', asyncHandler(async (req, res) => {
  const { redis } = await import('../queue/redis');
  const workers = await redis.hgetall('job_scheduler:workers');

  const workerList = Object.values(workers).map((w) => JSON.parse(w));

  res.json({
    success: true,
    data: workerList,
  } as ApiResponse<typeof workerList>);
}));

// Get dead letter queue items
app.get('/api/v1/dead-letter', asyncHandler(async (req, res) => {
  const start = parseInt(req.query.start as string) || 0;
  const count = parseInt(req.query.count as string) || 100;

  const items = await queue.getDeadLetterItems(start, start + count - 1);

  res.json({
    success: true,
    data: items,
  } as ApiResponse<typeof items>);
}));

// Error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  } as ApiResponse<never>);
});

// Start server
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
