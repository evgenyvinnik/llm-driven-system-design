# Job Scheduler - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement

"Today I'll design a distributed job scheduler, covering both the backend distributed coordination and the frontend dashboard experience. The key fullstack challenges are real-time execution status updates across the stack, type-safe API contracts between frontend and backend, end-to-end job lifecycle management, and integrating the priority queue system with responsive UI feedback."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Job Management** - Create, edit, delete, pause, resume, trigger jobs
2. **Scheduling** - One-time, recurring (cron), and delayed execution
3. **Priority Queues** - Higher priority jobs execute first
4. **Retry Logic** - Automatic retries with exponential backoff
5. **Real-time Monitoring** - Live execution status updates
6. **Worker Dashboard** - View active workers and health

### Non-Functional Requirements

- **Reliability**: At-least-once execution guarantee
- **Responsiveness**: UI reflects job status within 1 second
- **Type Safety**: Shared types between frontend and backend
- **Consistency**: Optimistic updates with proper rollback

### Fullstack Deep Dive Areas

- End-to-end job lifecycle (create -> schedule -> execute -> display)
- WebSocket architecture for real-time updates
- Shared type contracts
- Error handling across the stack

---

## Step 2: Shared Type Contracts

### Type Definitions

```typescript
// shared/types.ts

// Job status enum used across the stack
export const JobStatus = {
  SCHEDULED: 'SCHEDULED',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
} as const;
export type JobStatus = typeof JobStatus[keyof typeof JobStatus];

export const ExecutionStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PENDING_RETRY: 'PENDING_RETRY',
  CANCELLED: 'CANCELLED',
  DEDUPLICATED: 'DEDUPLICATED',
} as const;
export type ExecutionStatus = typeof ExecutionStatus[keyof typeof ExecutionStatus];

// Job definition
export interface Job {
  id: string;
  name: string;
  description?: string;
  handler: string;
  payload: Record<string, unknown>;
  schedule?: string;
  nextRunTime?: string;
  priority: number;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
  status: JobStatus;
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
}

// Execution record
export interface Execution {
  id: string;
  jobId: string;
  status: ExecutionStatus;
  attempt: number;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  nextRetryAt?: string;
  result?: Record<string, unknown>;
  error?: string;
  workerId?: string;
  createdAt: string;
}

// Worker status
export interface Worker {
  id: string;
  status: 'active' | 'inactive';
  concurrency: number;
  activeJobs: number;
  startedAt: string;
  lastHeartbeat: string;
}

// API request/response types
export interface CreateJobRequest {
  name: string;
  description?: string;
  handler: string;
  payload?: Record<string, unknown>;
  schedule?: string;
  runAt?: string;
  delay?: number;
  priority?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface JobListResponse {
  jobs: Job[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ExecutionListResponse {
  executions: Execution[];
  total: number;
}

// WebSocket message types
export type WebSocketMessage =
  | { type: 'execution_started'; execution: Execution }
  | { type: 'execution_updated'; execution: Execution }
  | { type: 'job_updated'; job: Job }
  | { type: 'worker_updated'; worker: Worker }
  | { type: 'worker_joined'; worker: Worker }
  | { type: 'worker_left'; workerId: string };
```

---

## Step 3: End-to-End Job Lifecycle

### Create Job Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           CREATE JOB FLOW                                 │
└──────────────────────────────────────────────────────────────────────────┘

Frontend                    API Server                    Database/Redis
────────                    ──────────                    ──────────────
    │                            │                              │
    │  POST /api/v1/jobs         │                              │
    │  + Idempotency-Key header  │                              │
    │ ──────────────────────────►│                              │
    │                            │                              │
    │                            │ Check idempotency cache      │
    │                            │ ─────────────────────────────►
    │                            │                              │
    │                            │ Validate & insert job        │
    │                            │ ─────────────────────────────►
    │                            │                              │
    │                            │ Calculate next_run_time      │
    │                            │                              │
    │                            │ Cache idempotency response   │
    │                            │ ─────────────────────────────►
    │                            │                              │
    │  201 Created { job }       │                              │
    │ ◄──────────────────────────│                              │
    │                            │                              │
    │  Update local state        │                              │
    │  (optimistic add)          │                              │
    │                            │                              │
```

### Frontend Job Creation

```tsx
// routes/jobs/new.tsx
import { useNavigate } from '@tanstack/react-router';
import { JobForm } from '@/components/jobs/JobForm';
import { useJobStore } from '@/stores/jobStore';
import { useHandlerStore } from '@/stores/handlerStore';
import { toast } from '@/components/ui/Toast';

export function NewJobPage() {
  const navigate = useNavigate();
  const { createJob } = useJobStore();
  const { handlers } = useHandlerStore();

  const handleSubmit = async (data: CreateJobRequest) => {
    try {
      // Generate idempotency key for this submission
      const idempotencyKey = crypto.randomUUID();

      const job = await createJob(data, idempotencyKey);

      toast.success(`Job "${job.name}" created successfully`);
      navigate({ to: '/jobs/$jobId', params: { jobId: job.id } });
    } catch (error) {
      if (error.status === 409) {
        toast.error('A job with this name already exists');
      } else {
        toast.error('Failed to create job');
      }
      throw error;
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Create New Job</h1>
      <JobForm
        handlers={handlers}
        onSubmit={handleSubmit}
        onCancel={() => navigate({ to: '/jobs' })}
      />
    </div>
  );
}
```

### Backend Job Creation with Idempotency

```typescript
// backend/src/api/routes/jobs.ts
import { Router } from 'express';
import { z } from 'zod';
import cronParser from 'cron-parser';
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';
import { authenticate, authorize } from '../shared/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';

const createJobSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  handler: z.string().min(1),
  payload: z.record(z.unknown()).optional().default({}),
  schedule: z.string().optional(),
  runAt: z.string().datetime().optional(),
  delay: z.number().positive().optional(),
  priority: z.number().min(0).max(100).optional().default(50),
  maxRetries: z.number().min(0).max(10).optional().default(3),
  timeoutMs: z.number().min(1000).max(3600000).optional().default(300000),
});

const router = Router();

router.post('/',
  authenticate,
  authorize('admin'),
  idempotencyMiddleware({ ttl: 3600 }),
  async (req, res) => {
    // Validate request body
    const result = createJobSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues,
      });
    }

    const data = result.data;

    // Check for duplicate name
    const existing = await pool.query(
      'SELECT id FROM jobs WHERE name = $1',
      [data.name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Job with this name already exists' });
    }

    // Validate handler exists
    const handlerExists = await validateHandler(data.handler);
    if (!handlerExists) {
      return res.status(400).json({ error: `Unknown handler: ${data.handler}` });
    }

    // Calculate next run time
    let nextRunTime: Date | null = null;
    if (data.schedule) {
      try {
        const interval = cronParser.parseExpression(data.schedule);
        nextRunTime = interval.next().toDate();
      } catch {
        return res.status(400).json({ error: 'Invalid cron expression' });
      }
    } else if (data.runAt) {
      nextRunTime = new Date(data.runAt);
    } else if (data.delay) {
      nextRunTime = new Date(Date.now() + data.delay * 1000);
    }

    // Insert job
    const jobId = crypto.randomUUID();
    const insertResult = await pool.query(`
      INSERT INTO jobs (
        id, name, description, handler, payload, schedule,
        next_run_time, priority, max_retries, initial_backoff_ms,
        max_backoff_ms, timeout_ms, status, owner_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `, [
      jobId,
      data.name,
      data.description,
      data.handler,
      JSON.stringify(data.payload),
      data.schedule,
      nextRunTime,
      data.priority,
      data.maxRetries,
      1000, // initial_backoff_ms
      3600000, // max_backoff_ms
      data.timeoutMs,
      'SCHEDULED',
      req.user.id,
    ]);

    const job = mapDbJobToResponse(insertResult.rows[0]);

    // Broadcast job creation
    await publishEvent('jobs', { type: 'job_created', job });

    res.status(201).json(job);
  }
);

export default router;
```

---

## Step 4: Execution Flow with Real-Time Updates

### Complete Execution Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         EXECUTION FLOW                                    │
└──────────────────────────────────────────────────────────────────────────┘

Scheduler           Queue           Worker          API/WS          Frontend
─────────           ─────           ──────          ──────          ────────
    │                 │                │               │                │
    │ Scan due jobs   │                │               │                │
    │ ───────────────►│                │               │                │
    │                 │                │               │                │
    │ ZADD (priority) │                │               │                │
    │ ───────────────►│                │               │                │
    │                 │                │               │                │
    │                 │  ZPOPMIN       │               │                │
    │                 │ ◄──────────────│               │                │
    │                 │                │               │                │
    │                 │  execution_id  │               │                │
    │                 │ ───────────────►               │                │
    │                 │                │               │                │
    │                 │                │ Update status │                │
    │                 │                │ to RUNNING    │                │
    │                 │                │ ─────────────►│                │
    │                 │                │               │                │
    │                 │                │               │ WS: execution  │
    │                 │                │               │ _started       │
    │                 │                │               │ ───────────────►
    │                 │                │               │                │
    │                 │                │               │      Update UI │
    │                 │                │               │      (running) │
    │                 │                │               │                │
    │                 │                │ Execute job   │                │
    │                 │                │ (handler)     │                │
    │                 │                │               │                │
    │                 │                │ Update status │                │
    │                 │                │ to COMPLETED  │                │
    │                 │                │ ─────────────►│                │
    │                 │                │               │                │
    │                 │                │               │ WS: execution  │
    │                 │                │               │ _updated       │
    │                 │                │               │ ───────────────►
    │                 │                │               │                │
    │                 │                │               │      Update UI │
    │                 │                │               │     (complete) │
```

### Backend Execution with Status Broadcasting

```typescript
// backend/src/worker/executor.ts
import { pool } from '../shared/db.js';
import { redis, publishEvent } from '../shared/cache.js';
import { queue } from '../shared/queue.js';
import { handlers } from './handlers/index.js';
import { CircuitBreaker } from 'opossum';

export class JobExecutor {
  private readonly workerId: string;
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  async execute(executionData: ExecutionData): Promise<void> {
    const { executionId, jobId, handler, payload, timeout } = executionData;

    // Update to RUNNING and broadcast
    const execution = await this.updateExecutionStatus(executionId, {
      status: 'RUNNING',
      startedAt: new Date(),
      workerId: this.workerId,
    });

    // Broadcast execution started
    await publishEvent(`job:${jobId}:executions`, {
      type: 'execution_started',
      execution,
    });
    await publishEvent('executions', {
      type: 'execution_started',
      execution,
    });

    try {
      // Execute through circuit breaker
      const breaker = this.getOrCreateBreaker(handler);
      const result = await breaker.fire(payload);

      // Update to COMPLETED and broadcast
      const completedExecution = await this.updateExecutionStatus(executionId, {
        status: 'COMPLETED',
        completedAt: new Date(),
        result,
      });

      await queue.complete(executionId, this.workerId);

      // Broadcast completion
      await this.broadcastExecutionUpdate(jobId, completedExecution);

      // Update job for recurring schedule
      await this.handleRecurringJob(jobId);

    } catch (error) {
      await this.handleExecutionFailure(executionId, jobId, error);
    }
  }

  private async handleExecutionFailure(
    executionId: string,
    jobId: string,
    error: Error
  ): Promise<void> {
    const execution = await pool.queryRow(`
      SELECT e.*, j.max_retries, j.initial_backoff_ms, j.max_backoff_ms
      FROM job_executions e
      JOIN jobs j ON e.job_id = j.id
      WHERE e.id = $1
    `, [executionId]);

    if (execution.attempt < execution.max_retries) {
      // Schedule retry
      const backoff = Math.min(
        execution.initial_backoff_ms * Math.pow(2, execution.attempt),
        execution.max_backoff_ms
      );
      const nextRetryAt = new Date(Date.now() + backoff);

      const retryExecution = await this.updateExecutionStatus(executionId, {
        status: 'PENDING_RETRY',
        nextRetryAt,
        error: error.message,
      });

      await this.broadcastExecutionUpdate(jobId, retryExecution);

    } else {
      // Max retries exceeded
      const failedExecution = await this.updateExecutionStatus(executionId, {
        status: 'FAILED',
        completedAt: new Date(),
        error: error.message,
      });

      await queue.moveToDeadLetter(executionId, error.message);
      await this.broadcastExecutionUpdate(jobId, failedExecution);
    }
  }

  private async broadcastExecutionUpdate(
    jobId: string,
    execution: Execution
  ): Promise<void> {
    await publishEvent(`job:${jobId}:executions`, {
      type: 'execution_updated',
      execution,
    });
    await publishEvent('executions', {
      type: 'execution_updated',
      execution,
    });
  }

  private async updateExecutionStatus(
    executionId: string,
    updates: Partial<Execution>
  ): Promise<Execution> {
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
      const snakeKey = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
      setClauses.push(`${snakeKey} = $${paramIndex}`);
      values.push(value instanceof Date ? value : value);
      paramIndex++;
    }

    values.push(executionId);

    const result = await pool.query(`
      UPDATE job_executions
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `, values);

    return mapDbExecutionToResponse(result.rows[0]);
  }
}
```

---

## Step 5: WebSocket Architecture

### Backend WebSocket Hub

```typescript
// backend/src/api/websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { redis, subscribeToPattern } from '../shared/cache.js';
import { verifySession } from '../shared/auth.js';

interface Client {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
}

export class WebSocketHub {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, Client>();

  constructor(server: any) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Subscribe to Redis pub/sub for cross-instance messaging
    this.subscribeToRedis();
  }

  private async handleConnection(ws: WebSocket, req: any) {
    // Authenticate via cookie
    const sessionId = this.extractSessionFromCookie(req.headers.cookie);
    const session = await verifySession(sessionId);

    if (!session) {
      ws.close(4001, 'Authentication required');
      return;
    }

    const client: Client = {
      ws,
      userId: session.userId,
      subscriptions: new Set(),
    };
    this.clients.set(ws, client);

    ws.on('message', (data) => this.handleMessage(client, data));
    ws.on('close', () => this.handleDisconnect(client));

    // Send welcome message
    ws.send(JSON.stringify({ type: 'connected', userId: session.userId }));
  }

  private handleMessage(client: Client, data: any) {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(client, message.channel);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(client, message.channel);
          break;
      }
    } catch (error) {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  }

  private handleSubscribe(client: Client, channel: string) {
    // Validate channel access based on user role
    if (this.canAccessChannel(client.userId, channel)) {
      client.subscriptions.add(channel);
      client.ws.send(JSON.stringify({ type: 'subscribed', channel }));
    } else {
      client.ws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
    }
  }

  private handleUnsubscribe(client: Client, channel: string) {
    client.subscriptions.delete(channel);
  }

  private handleDisconnect(client: Client) {
    this.clients.delete(client.ws);
  }

  private async subscribeToRedis() {
    // Subscribe to all job scheduler events
    await subscribeToPattern('job_scheduler:*', (channel, message) => {
      const eventChannel = channel.replace('job_scheduler:', '');
      this.broadcast(eventChannel, JSON.parse(message));
    });
  }

  private broadcast(channel: string, data: any) {
    for (const [ws, client] of this.clients) {
      if (client.subscriptions.has(channel) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ channel, data }));
      }
    }
  }

  private canAccessChannel(userId: string, channel: string): boolean {
    // All authenticated users can access these channels
    const publicChannels = ['executions', 'workers'];
    if (publicChannels.includes(channel)) return true;

    // Job-specific channels require ownership check (simplified for example)
    if (channel.startsWith('job:')) return true;

    return false;
  }
}

// Redis pub/sub helpers
export async function publishEvent(channel: string, data: any): Promise<void> {
  await redis.publish(`job_scheduler:${channel}`, JSON.stringify(data));
}
```

### Frontend WebSocket Integration

```tsx
// hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';

interface WebSocketState {
  connected: boolean;
  error: string | null;
}

interface UseWebSocketOptions {
  channels: string[];
  onMessage: (channel: string, data: any) => void;
}

export function useWebSocket({ channels, onMessage }: UseWebSocketOptions) {
  const { isAuthenticated } = useAuthStore();
  const [state, setState] = useState<WebSocketState>({ connected: false, error: null });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const subscribedChannelsRef = useRef<Set<string>>(new Set());

  const connect = useCallback(() => {
    if (!isAuthenticated) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setState({ connected: true, error: null });

      // Subscribe to channels
      channels.forEach(channel => {
        ws.send(JSON.stringify({ type: 'subscribe', channel }));
        subscribedChannelsRef.current.add(channel);
      });
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'error') {
        console.error('WebSocket error:', message.message);
        return;
      }

      if (message.channel && message.data) {
        onMessage(message.channel, message.data);
      }
    };

    ws.onclose = (event) => {
      setState({ connected: false, error: null });
      subscribedChannelsRef.current.clear();

      // Reconnect unless intentionally closed
      if (event.code !== 1000) {
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      setState(prev => ({ ...prev, error: 'Connection error' }));
      ws.close();
    };

    wsRef.current = ws;
  }, [isAuthenticated, channels, onMessage]);

  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.close(1000, 'Component unmounting');
      }
    };
  }, [connect]);

  // Handle channel changes
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const currentChannels = subscribedChannelsRef.current;
    const newChannels = new Set(channels);

    // Subscribe to new channels
    for (const channel of newChannels) {
      if (!currentChannels.has(channel)) {
        wsRef.current.send(JSON.stringify({ type: 'subscribe', channel }));
        currentChannels.add(channel);
      }
    }

    // Unsubscribe from removed channels
    for (const channel of currentChannels) {
      if (!newChannels.has(channel)) {
        wsRef.current.send(JSON.stringify({ type: 'unsubscribe', channel }));
        currentChannels.delete(channel);
      }
    }
  }, [channels]);

  return state;
}
```

---

## Step 6: Job Detail Page Integration

### Fullstack Job Detail View

```tsx
// routes/jobs/$jobId.tsx
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Job, Execution } from '@/shared/types';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ExecutionTimeline } from '@/components/executions/ExecutionTimeline';
import { JobActions } from '@/components/jobs/JobActions';
import { StatusBadge } from '@/components/ui/StatusBadge';

export function JobDetailPage() {
  const { jobId } = useParams({ from: '/jobs/$jobId' });
  const [job, setJob] = useState<Job | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch job and executions
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      const [jobRes, execRes] = await Promise.all([
        fetch(`/api/v1/jobs/${jobId}`),
        fetch(`/api/v1/jobs/${jobId}/executions?limit=20`),
      ]);

      setJob(await jobRes.json());
      setExecutions((await execRes.json()).executions);
      setLoading(false);
    }
    fetchData();
  }, [jobId]);

  // Real-time updates
  useWebSocket({
    channels: [`job:${jobId}:executions`, 'jobs'],
    onMessage: (channel, data) => {
      if (data.type === 'execution_started') {
        setExecutions(prev => [data.execution, ...prev]);
      } else if (data.type === 'execution_updated') {
        setExecutions(prev =>
          prev.map(e => e.id === data.execution.id ? data.execution : e)
        );
      } else if (data.type === 'job_updated' && data.job.id === jobId) {
        setJob(data.job);
      }
    },
  });

  if (loading) {
    return <JobDetailSkeleton />;
  }

  if (!job) {
    return <NotFound message="Job not found" />;
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      {/* Job Header */}
      <div className="bg-white rounded-lg shadow-sm border p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{job.name}</h1>
              <StatusBadge status={job.status} />
            </div>
            {job.description && (
              <p className="mt-2 text-gray-600">{job.description}</p>
            )}
          </div>

          <JobActions
            job={job}
            onUpdate={setJob}
          />
        </div>

        {/* Job details grid */}
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          <DetailItem label="Handler" value={job.handler} />
          <DetailItem label="Priority" value={job.priority.toString()} />
          <DetailItem label="Max Retries" value={job.maxRetries.toString()} />
          <DetailItem
            label="Timeout"
            value={formatDuration(job.timeoutMs)}
          />
          {job.schedule && (
            <DetailItem
              label="Schedule"
              value={formatCronExpression(job.schedule)}
            />
          )}
          {job.nextRunTime && (
            <DetailItem
              label="Next Run"
              value={<TimeAgo date={job.nextRunTime} />}
            />
          )}
        </div>

        {/* Payload preview */}
        {Object.keys(job.payload).length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 mb-2">Payload</h3>
            <pre className="p-3 bg-gray-50 rounded text-sm font-mono overflow-x-auto">
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Execution History */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Execution History
        </h2>
        <ExecutionTimeline
          executions={executions}
          onRetry={async (executionId) => {
            await fetch(`/api/v1/executions/${executionId}/retry`, { method: 'POST' });
          }}
        />
      </div>
    </div>
  );
}
```

### JobActions Component with Trigger Feedback

```tsx
// components/jobs/JobActions.tsx
import { useState } from 'react';
import { Job } from '@/shared/types';
import { toast } from '@/components/ui/Toast';

interface JobActionsProps {
  job: Job;
  onUpdate: (job: Job) => void;
}

export function JobActions({ job, onUpdate }: JobActionsProps) {
  const [triggering, setTriggering] = useState(false);
  const [pausing, setPausing] = useState(false);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      const response = await fetch(`/api/v1/jobs/${job.id}/trigger`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to trigger job');
      }

      const { execution } = await response.json();
      toast.success(`Job triggered - Execution ${execution.id.slice(0, 8)}`);
      // Execution will appear in timeline via WebSocket
    } catch (error) {
      toast.error('Failed to trigger job');
    } finally {
      setTriggering(false);
    }
  };

  const handlePauseResume = async () => {
    setPausing(true);
    const action = job.status === 'PAUSED' ? 'resume' : 'pause';

    try {
      const response = await fetch(`/api/v1/jobs/${job.id}/${action}`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Failed to ${action} job`);
      }

      const updatedJob = await response.json();
      onUpdate(updatedJob);
      toast.success(`Job ${action}d successfully`);
    } catch (error) {
      toast.error(`Failed to ${action} job`);
    } finally {
      setPausing(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Button
        onClick={handleTrigger}
        disabled={triggering || job.status === 'PAUSED'}
        variant="primary"
      >
        {triggering ? (
          <>
            <Spinner className="w-4 h-4 mr-2" />
            Triggering...
          </>
        ) : (
          <>
            <PlayIcon className="w-4 h-4 mr-2" />
            Trigger Now
          </>
        )}
      </Button>

      <Button
        onClick={handlePauseResume}
        disabled={pausing}
        variant="outline"
      >
        {pausing ? (
          <Spinner className="w-4 h-4" />
        ) : job.status === 'PAUSED' ? (
          <>
            <PlayIcon className="w-4 h-4 mr-2" />
            Resume
          </>
        ) : (
          <>
            <PauseIcon className="w-4 h-4 mr-2" />
            Pause
          </>
        )}
      </Button>

      <DropdownMenu>
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost">
            <MoreVerticalIcon className="w-4 h-4" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item asChild>
            <Link to="/jobs/$jobId/edit" params={{ jobId: job.id }}>
              Edit Job
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            className="text-red-600"
            onClick={async () => {
              if (confirm('Are you sure you want to delete this job?')) {
                await fetch(`/api/v1/jobs/${job.id}`, { method: 'DELETE' });
                navigate({ to: '/jobs' });
              }
            }}
          >
            Delete Job
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  );
}
```

---

## Step 7: Dead Letter Queue Management

### Backend Dead Letter API

```typescript
// backend/src/api/routes/deadLetter.ts
import { Router } from 'express';
import { redis } from '../shared/cache.js';
import { pool } from '../shared/db.js';
import { authenticate, authorize } from '../shared/auth.js';

const router = Router();

router.get('/',
  authenticate,
  async (req, res) => {
    const items = await redis.lrange('job_scheduler:dead_letter', 0, 99);

    const deadLetterItems = items.map(item => JSON.parse(item));

    res.json({
      items: deadLetterItems,
      total: await redis.llen('job_scheduler:dead_letter'),
    });
  }
);

router.post('/:executionId/retry',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    const { executionId } = req.params;

    // Find item in dead letter queue
    const items = await redis.lrange('job_scheduler:dead_letter', 0, -1);
    const itemIndex = items.findIndex(item => {
      const parsed = JSON.parse(item);
      return parsed.executionId === executionId;
    });

    if (itemIndex === -1) {
      return res.status(404).json({ error: 'Item not found in dead letter queue' });
    }

    const item = JSON.parse(items[itemIndex]);

    // Create new execution
    const newExecutionId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO job_executions (id, job_id, status, attempt, scheduled_at)
      VALUES ($1, $2, 'PENDING', 1, NOW())
    `, [newExecutionId, item.jobId]);

    // Enqueue for processing
    await redis.zadd('job_scheduler:queue', 0, JSON.stringify({
      executionId: newExecutionId,
      jobId: item.jobId,
      handler: item.handler,
      payload: item.payload,
    }));

    // Remove from dead letter
    await redis.lrem('job_scheduler:dead_letter', 1, items[itemIndex]);

    res.json({
      message: 'Retry scheduled',
      newExecutionId,
    });
  }
);

router.delete('/:executionId',
  authenticate,
  authorize('admin'),
  async (req, res) => {
    const { executionId } = req.params;

    const items = await redis.lrange('job_scheduler:dead_letter', 0, -1);
    const item = items.find(i => {
      const parsed = JSON.parse(i);
      return parsed.executionId === executionId;
    });

    if (item) {
      await redis.lrem('job_scheduler:dead_letter', 1, item);
    }

    res.status(204).end();
  }
);

export default router;
```

### Frontend Dead Letter View

```tsx
// routes/dead-letter.tsx
import { useEffect, useState } from 'react';
import { toast } from '@/components/ui/Toast';

interface DeadLetterItem {
  executionId: string;
  jobId: string;
  handler: string;
  payload: Record<string, unknown>;
  error: string;
  failedAt: string;
}

export function DeadLetterPage() {
  const [items, setItems] = useState<DeadLetterItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchDeadLetter();
  }, []);

  async function fetchDeadLetter() {
    setLoading(true);
    const response = await fetch('/api/v1/dead-letter');
    const data = await response.json();
    setItems(data.items);
    setLoading(false);
  }

  async function handleRetry(executionId: string) {
    setRetrying(prev => new Set(prev).add(executionId));

    try {
      const response = await fetch(`/api/v1/dead-letter/${executionId}/retry`, {
        method: 'POST',
      });

      if (!response.ok) throw new Error('Failed to retry');

      const { newExecutionId } = await response.json();
      toast.success(`Retry scheduled: ${newExecutionId.slice(0, 8)}`);

      // Remove from local state
      setItems(prev => prev.filter(i => i.executionId !== executionId));
    } catch {
      toast.error('Failed to schedule retry');
    } finally {
      setRetrying(prev => {
        const next = new Set(prev);
        next.delete(executionId);
        return next;
      });
    }
  }

  async function handleDismiss(executionId: string) {
    await fetch(`/api/v1/dead-letter/${executionId}`, { method: 'DELETE' });
    setItems(prev => prev.filter(i => i.executionId !== executionId));
    toast.success('Item dismissed');
  }

  if (loading) {
    return <DeadLetterSkeleton />;
  }

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dead Letter Queue</h1>
        <span className="text-sm text-gray-500">{items.length} items</span>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={CheckCircleIcon}
          title="No failed jobs"
          description="All jobs are processing successfully"
        />
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <div
              key={item.executionId}
              className="bg-white border border-red-200 rounded-lg p-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {item.handler}
                    </span>
                    <Link
                      to="/jobs/$jobId"
                      params={{ jobId: item.jobId }}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      View Job
                    </Link>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">
                    Failed <TimeAgo date={item.failedAt} />
                  </p>
                </div>

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRetry(item.executionId)}
                    disabled={retrying.has(item.executionId)}
                  >
                    {retrying.has(item.executionId) ? (
                      <Spinner className="w-4 h-4" />
                    ) : (
                      'Retry'
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDismiss(item.executionId)}
                  >
                    Dismiss
                  </Button>
                </div>
              </div>

              <div className="mt-3 p-2 bg-red-50 rounded text-sm font-mono text-red-700">
                {item.error}
              </div>

              {Object.keys(item.payload).length > 0 && (
                <details className="mt-3">
                  <summary className="text-sm text-gray-500 cursor-pointer">
                    View payload
                  </summary>
                  <pre className="mt-2 p-2 bg-gray-50 rounded text-xs font-mono overflow-x-auto">
                    {JSON.stringify(item.payload, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Step 8: Metrics Dashboard Integration

### Backend Metrics Endpoint

```typescript
// backend/src/api/routes/metrics.ts
import { Router } from 'express';
import { redis } from '../shared/cache.js';
import { pool } from '../shared/db.js';
import { authenticate } from '../shared/auth.js';

const router = Router();

router.get('/summary',
  authenticate,
  async (req, res) => {
    // Aggregate metrics from various sources
    const [queueDepth, processingCount, deadLetterCount, recentStats] = await Promise.all([
      redis.zcard('job_scheduler:queue'),
      redis.zcard('job_scheduler:processing'),
      redis.llen('job_scheduler:dead_letter'),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed,
          COUNT(*) FILTER (WHERE status = 'FAILED') as failed,
          COUNT(*) FILTER (WHERE status = 'RUNNING') as running,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE status = 'COMPLETED') as avg_duration
        FROM job_executions
        WHERE created_at > NOW() - INTERVAL '1 hour'
      `),
    ]);

    const stats = recentStats.rows[0];

    res.json({
      queue: {
        depth: queueDepth,
        processing: processingCount,
        deadLetter: deadLetterCount,
      },
      executions: {
        completed: parseInt(stats.completed) || 0,
        failed: parseInt(stats.failed) || 0,
        running: parseInt(stats.running) || 0,
        averageDuration: parseFloat(stats.avg_duration) || 0,
      },
      workers: await getWorkerSummary(),
    });
  }
);

async function getWorkerSummary() {
  const workers = await redis.hgetall('job_scheduler:workers');
  const workerList = Object.entries(workers).map(([id, data]) => ({
    id,
    ...JSON.parse(data),
  }));

  const activeWorkers = workerList.filter(w =>
    Date.now() - new Date(w.lastHeartbeat).getTime() < 30000
  );

  return {
    total: workerList.length,
    active: activeWorkers.length,
    totalCapacity: activeWorkers.reduce((sum, w) => sum + w.concurrency, 0),
    activeJobs: activeWorkers.reduce((sum, w) => sum + w.activeJobs, 0),
  };
}

export default router;
```

### Frontend Dashboard Overview

```tsx
// routes/index.tsx
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { MetricCard } from '@/components/metrics/MetricCard';
import { ThroughputChart } from '@/components/metrics/ThroughputChart';
import { RecentExecutions } from '@/components/executions/RecentExecutions';

interface DashboardMetrics {
  queue: {
    depth: number;
    processing: number;
    deadLetter: number;
  };
  executions: {
    completed: number;
    failed: number;
    running: number;
    averageDuration: number;
  };
  workers: {
    total: number;
    active: number;
    totalCapacity: number;
    activeJobs: number;
  };
}

export function DashboardPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [recentExecutions, setRecentExecutions] = useState<Execution[]>([]);

  // Fetch metrics
  useEffect(() => {
    async function fetchMetrics() {
      const [metricsRes, executionsRes] = await Promise.all([
        fetch('/api/v1/metrics/summary'),
        fetch('/api/v1/executions?limit=10'),
      ]);

      setMetrics(await metricsRes.json());
      setRecentExecutions((await executionsRes.json()).executions);
    }

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, []);

  // Real-time execution updates
  useWebSocket({
    channels: ['executions'],
    onMessage: (channel, data) => {
      if (data.type === 'execution_started') {
        setRecentExecutions(prev => [data.execution, ...prev.slice(0, 9)]);
        setMetrics(prev => prev ? {
          ...prev,
          executions: { ...prev.executions, running: prev.executions.running + 1 },
          queue: { ...prev.queue, processing: prev.queue.processing + 1 },
        } : null);
      } else if (data.type === 'execution_updated') {
        setRecentExecutions(prev =>
          prev.map(e => e.id === data.execution.id ? data.execution : e)
        );
      }
    },
  });

  if (!metrics) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Dashboard</h1>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <MetricCard
          label="Queue Depth"
          value={metrics.queue.depth}
          trend={metrics.queue.depth > 100 ? 'warning' : 'normal'}
          icon={LayersIcon}
        />
        <MetricCard
          label="Processing"
          value={metrics.queue.processing}
          icon={CogIcon}
        />
        <MetricCard
          label="Completed (1h)"
          value={metrics.executions.completed}
          trend="positive"
          icon={CheckCircleIcon}
        />
        <MetricCard
          label="Failed (1h)"
          value={metrics.executions.failed}
          trend={metrics.executions.failed > 0 ? 'negative' : 'normal'}
          icon={XCircleIcon}
        />
      </div>

      {/* Workers and Dead Letter */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium text-gray-900 mb-3">Workers</h3>
          <div className="flex items-center justify-between">
            <span className="text-2xl font-bold">
              {metrics.workers.active} / {metrics.workers.total}
            </span>
            <span className="text-sm text-gray-500">
              {metrics.workers.activeJobs} / {metrics.workers.totalCapacity} capacity
            </span>
          </div>
          <div className="mt-2 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500"
              style={{
                width: `${(metrics.workers.activeJobs / metrics.workers.totalCapacity) * 100}%`,
              }}
            />
          </div>
        </div>

        <div className="bg-white rounded-lg border p-4">
          <h3 className="font-medium text-gray-900 mb-3">Dead Letter Queue</h3>
          <div className="flex items-center justify-between">
            <span className={`text-2xl font-bold ${metrics.queue.deadLetter > 0 ? 'text-red-600' : ''}`}>
              {metrics.queue.deadLetter}
            </span>
            {metrics.queue.deadLetter > 0 && (
              <Link to="/dead-letter" className="text-sm text-blue-600 hover:underline">
                View queue
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Recent Executions */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-gray-900">Recent Executions</h3>
          <Link to="/executions" className="text-sm text-blue-600 hover:underline">
            View all
          </Link>
        </div>
        <RecentExecutions executions={recentExecutions} />
      </div>
    </div>
  );
}
```

---

## Closing Summary

"I've designed a fullstack job scheduler with:

1. **Shared type contracts** ensuring type safety between frontend and backend
2. **End-to-end job lifecycle** from creation through execution with real-time feedback
3. **WebSocket architecture** with Redis pub/sub for cross-instance real-time updates
4. **Optimistic UI updates** with proper error handling and rollback
5. **Dead letter queue management** for failed job inspection and retry
6. **Integrated metrics dashboard** showing queue health, worker status, and recent executions

The key fullstack insight is maintaining a single source of truth in the backend while providing responsive UI feedback. WebSockets ensure all connected clients see execution updates immediately, while the shared types prevent API contract drift. The dead letter queue provides operational visibility into failures with one-click retry capability."
