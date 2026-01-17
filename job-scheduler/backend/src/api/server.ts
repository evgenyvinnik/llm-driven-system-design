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
import cookieParser from 'cookie-parser';
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

// Import shared modules
import {
  authenticate,
  authorize,
  ensureAdminUser,
  createSession,
  destroySession,
  validateCredentials,
  createUser,
} from '../shared/auth';
import {
  metricsMiddleware,
  metricsHandler,
  updateQueueMetrics,
  jobsScheduledTotal,
} from '../shared/metrics';
import { idempotencyMiddleware, markJobCreated, clearJobIdempotency } from '../shared/idempotency';
import { getCircuitBreakerStates, resetAllCircuitBreakers } from '../shared/circuit-breaker';
import { runCleanup, getCleanupPreview, getStorageStats, retentionConfig } from '../shared/archival';

/** Express application instance */
const app = express();
/** API server port from environment */
const PORT = process.env.PORT || 3001;

// Middleware configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Metrics middleware - track all requests
app.use(metricsMiddleware);

/**
 * Request logging middleware.
 * Logs method, URL, status, and response time for all requests.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      userId: req.user?.userId,
    }, `${req.method} ${req.path}`);
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

// === Public Endpoints (No Auth Required) ===

/** GET /metrics - Prometheus metrics endpoint */
app.get('/metrics', metricsHandler);

/** GET /api/v1/health - Check database and Redis connectivity */
app.get('/api/v1/health', asyncHandler(async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);

  const healthy = dbOk && redisOk;
  const response: ApiResponse<{
    db: boolean;
    redis: boolean;
    uptime: number;
    version: string;
  }> = {
    success: healthy,
    data: {
      db: dbOk,
      redis: redisOk,
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
    },
  };

  res.status(healthy ? 200 : 503).json(response);
}));

/** GET /api/v1/health/ready - Readiness check for k8s */
app.get('/api/v1/health/ready', asyncHandler(async (req, res) => {
  const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);
  const ready = dbOk && redisOk;
  res.status(ready ? 200 : 503).json({ ready, db: dbOk, redis: redisOk });
}));

/** GET /api/v1/health/live - Liveness check for k8s */
app.get('/api/v1/health/live', (_req, res) => {
  res.status(200).json({ alive: true });
});

// === Authentication Endpoints ===

/** POST /api/auth/login - Create session */
app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({
      success: false,
      error: 'Username and password are required',
    });
    return;
  }

  const user = await validateCredentials(username, password);

  if (!user) {
    res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    });
    return;
  }

  const sessionId = await createSession(user);

  res.cookie('session_id', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 86400000, // 24 hours
  });

  res.json({
    success: true,
    data: { user: { id: user.id, username: user.username, role: user.role } },
    message: 'Login successful',
  });
}));

/** POST /api/auth/logout - Destroy session */
app.post('/api/auth/logout', authenticate, asyncHandler(async (req, res) => {
  if (req.sessionId) {
    await destroySession(req.sessionId);
  }

  res.clearCookie('session_id');
  res.json({
    success: true,
    message: 'Logout successful',
  });
}));

/** GET /api/auth/me - Get current user */
app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    success: true,
    data: {
      id: req.user?.userId,
      username: req.user?.username,
      role: req.user?.role,
    },
  });
});

// === Job Management Endpoints (Authenticated) ===

/** POST /api/v1/jobs - Create a new job (Admin only, with idempotency) */
app.post('/api/v1/jobs',
  authenticate,
  authorize('admin'),
  idempotencyMiddleware(),
  asyncHandler(async (req, res) => {
    const input: CreateJobInput = req.body;

    // Validate required fields
    if (!input.name || !input.handler) {
      res.status(400).json({
        success: false,
        error: 'Name and handler are required',
      } as ApiResponse<never>);
      return;
    }

    // Check if job with same name already exists
    const existingJob = await db.getJobByName(input.name);
    if (existingJob) {
      res.status(409).json({
        success: false,
        error: `Job with name "${input.name}" already exists`,
        data: { existingJobId: existingJob.id },
      } as ApiResponse<{ existingJobId: string }>);
      return;
    }

    const job = await db.createJob(input);

    // Mark for idempotency
    await markJobCreated(input.name, job.id);

    // Update metrics
    jobsScheduledTotal.inc({
      handler: job.handler,
      priority: job.priority.toString(),
    });

    res.status(201).json({
      success: true,
      data: job,
      message: 'Job created successfully',
    } as ApiResponse<typeof job>);
  }));

/** GET /api/v1/jobs - List jobs with pagination and optional filtering */
app.get('/api/v1/jobs', authenticate, asyncHandler(async (req, res) => {
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
app.get('/api/v1/jobs/:id', authenticate, asyncHandler(async (req, res) => {
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

/** PUT /api/v1/jobs/:id - Update an existing job (Admin only) */
app.put('/api/v1/jobs/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
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

/** DELETE /api/v1/jobs/:id - Delete a job and its executions (Admin only) */
app.delete('/api/v1/jobs/:id', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const job = await db.getJob(req.params.id);

  if (!job) {
    res.status(404).json({
      success: false,
      error: 'Job not found',
    } as ApiResponse<never>);
    return;
  }

  const deleted = await db.deleteJob(req.params.id);

  if (deleted) {
    // Clear idempotency marker
    await clearJobIdempotency(job.name);
  }

  res.json({
    success: true,
    message: 'Job deleted successfully',
  } as ApiResponse<never>);
}));

/** POST /api/v1/jobs/:id/pause - Pause a job (Admin only) */
app.post('/api/v1/jobs/:id/pause', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
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

/** POST /api/v1/jobs/:id/resume - Resume a paused job (Admin only) */
app.post('/api/v1/jobs/:id/resume', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
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
app.post('/api/v1/jobs/:id/trigger', authenticate, asyncHandler(async (req, res) => {
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

  // Update metrics
  jobsScheduledTotal.inc({
    handler: job.handler,
    priority: job.priority.toString(),
  });

  res.json({
    success: true,
    data: { job, execution },
    message: 'Job triggered successfully',
  } as ApiResponse<{ job: typeof job; execution: typeof execution }>);
}));

// === Execution Management Endpoints ===

/** GET /api/v1/jobs/:id/executions - List executions for a specific job */
app.get('/api/v1/jobs/:id/executions', authenticate, asyncHandler(async (req, res) => {
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
app.get('/api/v1/executions/:id', authenticate, asyncHandler(async (req, res) => {
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

/** POST /api/v1/executions/:id/cancel - Cancel a pending or running execution (Admin only) */
app.post('/api/v1/executions/:id/cancel', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
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
app.post('/api/v1/executions/:id/retry', authenticate, asyncHandler(async (req, res) => {
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
app.get('/api/v1/metrics/system', authenticate, asyncHandler(async (req, res) => {
  const [dbMetrics, queueStats] = await Promise.all([
    db.getSystemMetrics(),
    queue.getStats(),
  ]);

  // Update queue metrics for Prometheus
  await updateQueueMetrics(queueStats);

  // Get worker count from Redis
  const { redis } = await import('../queue/redis');
  const workers = await redis.hgetall('job_scheduler:workers');
  const activeWorkers = Object.values(workers).filter((w) => {
    const worker = JSON.parse(w);
    const lastHeartbeat = new Date(worker.last_heartbeat);
    const isRecent = Date.now() - lastHeartbeat.getTime() < 60000; // 1 minute
    return isRecent;
  }).length;

  // Get circuit breaker states
  const circuitBreakers = Object.fromEntries(getCircuitBreakerStates());

  res.json({
    success: true,
    data: {
      jobs: dbMetrics,
      queue: queueStats,
      workers: {
        active: activeWorkers,
        total: Object.keys(workers).length,
      },
      circuitBreakers,
    },
  } as ApiResponse<{
    jobs: typeof dbMetrics;
    queue: typeof queueStats;
    workers: { active: number; total: number };
    circuitBreakers: Record<string, unknown>;
  }>);
}));

/** GET /api/v1/metrics/executions - Get hourly execution statistics */
app.get('/api/v1/metrics/executions', authenticate, asyncHandler(async (req, res) => {
  const hours = parseInt(req.query.hours as string) || 24;
  const stats = await db.getExecutionStats(hours);

  res.json({
    success: true,
    data: stats,
  } as ApiResponse<typeof stats>);
}));

/** GET /api/v1/workers - Get list of registered workers */
app.get('/api/v1/workers', authenticate, asyncHandler(async (req, res) => {
  const { redis } = await import('../queue/redis');
  const workers = await redis.hgetall('job_scheduler:workers');

  const workerList = Object.values(workers).map((w) => JSON.parse(w));

  res.json({
    success: true,
    data: workerList,
  } as ApiResponse<typeof workerList>);
}));

/** GET /api/v1/dead-letter - Get items from the dead letter queue */
app.get('/api/v1/dead-letter', authenticate, asyncHandler(async (req, res) => {
  const start = parseInt(req.query.start as string) || 0;
  const count = parseInt(req.query.count as string) || 100;

  const items = await queue.getDeadLetterItems(start, start + count - 1);

  res.json({
    success: true,
    data: items,
  } as ApiResponse<typeof items>);
}));

// === Admin Endpoints ===

/** POST /api/v1/admin/users - Create a new user (Admin only) */
app.post('/api/v1/admin/users', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    res.status(400).json({
      success: false,
      error: 'Username and password are required',
    });
    return;
  }

  const user = await createUser(username, password, role || 'user');

  res.status(201).json({
    success: true,
    data: user,
    message: 'User created successfully',
  });
}));

/** POST /api/v1/admin/cleanup - Run data cleanup (Admin only) */
app.post('/api/v1/admin/cleanup', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const { dryRun } = req.body;

  if (dryRun) {
    const preview = await getCleanupPreview();
    res.json({
      success: true,
      data: preview,
      message: 'Cleanup preview (dry run)',
    });
    return;
  }

  const stats = await runCleanup();

  res.json({
    success: true,
    data: stats,
    message: 'Cleanup completed successfully',
  });
}));

/** GET /api/v1/admin/storage - Get storage statistics (Admin only) */
app.get('/api/v1/admin/storage', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const stats = await getStorageStats();

  res.json({
    success: true,
    data: {
      stats,
      retentionConfig,
    },
  });
}));

/** POST /api/v1/admin/circuit-breakers/reset - Reset all circuit breakers (Admin only) */
app.post('/api/v1/admin/circuit-breakers/reset', authenticate, authorize('admin'), asyncHandler(async (_req, res) => {
  resetAllCircuitBreakers();

  res.json({
    success: true,
    message: 'All circuit breakers reset',
  });
}));

/**
 * Global error handler middleware.
 * Logs unhandled errors and returns a standardized error response.
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  } as ApiResponse<never>);
});

/**
 * Starts the API server.
 * Runs database migrations and ensures admin user before listening for requests.
 */
async function start() {
  // Run migrations
  await migrate();

  // Ensure default admin user exists
  await ensureAdminUser();

  app.listen(PORT, () => {
    logger.info({ port: PORT }, `API server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  logger.error({ err: error }, 'Failed to start API server');
  process.exit(1);
});

export { app };
