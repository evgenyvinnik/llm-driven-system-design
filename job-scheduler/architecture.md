# Job Scheduler - Architecture Design

## System Overview

A distributed task scheduling system that provides reliable job execution with cron-like scheduling, priority queues, and at-least-once execution guarantees.

## Requirements

### Functional Requirements

- **Job submission**: Create jobs with execution parameters, scheduling, and configuration
- **Scheduling**: One-time, recurring (cron), and delayed execution
- **Priority queues**: High-priority jobs execute before low-priority ones
- **Retry logic**: Automatic retries with exponential backoff
- **Job management**: Pause, resume, cancel, and trigger jobs
- **Monitoring**: Job status, execution history, worker status, metrics

### Non-Functional Requirements

- **Reliability**: At-least-once execution guarantee
- **Scalability**: Horizontal worker scaling
- **Latency**: Job pickup within 1 second of scheduled time
- **Availability**: Leader election for scheduler high availability
- **Consistency**: No duplicate execution through distributed locking

### Out of Scope

- Complex workflow orchestration (DAGs beyond simple scheduling)
- Multi-tenant isolation
- Specific execution environments (Docker, Lambda)

## Capacity Estimation

**Target Scale (for local development):**

- Jobs: 100-1000 concurrent jobs
- Workers: 3-5 instances
- Executions: 10,000+ per day

**Storage:**

- Job record: ~2KB (metadata, parameters, history)
- Execution record: ~1KB
- Execution log: ~500 bytes per entry

## High-Level Architecture

```
                              ┌─────────────────────────────────┐
                              │         Frontend Dashboard      │
                              │    (React + TanStack Router)    │
                              └───────────────┬─────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │           API Server            │
                              │     (Express + TypeScript)      │
                              └───────────────┬─────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │     Scheduler     │          │     PostgreSQL    │          │       Redis       │
    │   (Leader-Elected)│          │                   │          │                   │
    │                   │          │ - Job definitions │          │ - Priority queue  │
    │ - Scans due jobs  │          │ - Executions      │          │ - Leader locks    │
    │ - Enqueues work   │          │ - Execution logs  │          │ - Job locks       │
    └─────────┬─────────┘          └───────────────────┘          │ - Worker registry │
              │                                                   └─────────┬─────────┘
              └───────────────────────────────┬───────────────────────────────┘
                                              │
    ┌───────────────────────────────────────────────────────────────────────────────┐
    │                              Worker Pool                                       │
    │                                                                               │
    │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
    │   │ Worker 1 │   │ Worker 2 │   │ Worker 3 │   │ Worker 4 │   │ Worker N │   │
    │   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   │
    └───────────────────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **API Server**
   - Handles job CRUD operations
   - Validates job definitions
   - Exposes metrics and monitoring endpoints
   - Serves frontend dashboard

2. **Scheduler Service**
   - Leader-elected component (only one active)
   - Scans for due jobs every second
   - Inserts jobs into priority queues
   - Recovers stalled executions
   - Schedules retries for failed jobs

3. **Priority Queue (Redis)**
   - Sorted set with priority as score
   - Visibility timeout for reliable processing
   - Dead letter queue for failed jobs

4. **Worker Pool**
   - Stateless job executors
   - Pull work from Redis queue
   - Execute handlers and report results
   - Support multiple concurrent jobs

5. **PostgreSQL**
   - Job definitions and metadata
   - Execution history and logs
   - Source of truth for job state

## Data Model

### Database Schema

```sql
-- Job definitions
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  handler VARCHAR(255) NOT NULL,
  payload JSONB DEFAULT '{}',
  schedule VARCHAR(100),           -- Cron expression
  next_run_time TIMESTAMP WITH TIME ZONE,
  priority INTEGER DEFAULT 50,
  max_retries INTEGER DEFAULT 3,
  initial_backoff_ms INTEGER DEFAULT 1000,
  max_backoff_ms INTEGER DEFAULT 3600000,
  timeout_ms INTEGER DEFAULT 300000,
  status job_status DEFAULT 'SCHEDULED',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Job executions
CREATE TABLE job_executions (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  status execution_status NOT NULL,
  attempt INTEGER DEFAULT 1,
  scheduled_at TIMESTAMP WITH TIME ZONE,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  result JSONB,
  error TEXT,
  worker_id VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Execution logs
CREATE TABLE execution_logs (
  id UUID PRIMARY KEY,
  execution_id UUID REFERENCES job_executions(id),
  level VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Redis Data Structures

```
Priority Queue:
  job_scheduler:queue → Sorted Set (job_data, priority_score)

Processing:
  job_scheduler:processing → Sorted Set (execution_id:worker_id, timeout)

Dead Letter:
  job_scheduler:dead_letter → List (failed_execution_data)

Locks:
  job_scheduler:scheduler:leader → String (instance_id)
  job_scheduler:lock:{job_id} → String (execution_id)

Workers:
  job_scheduler:workers → Hash (worker_id → worker_info_json)
```

## API Design

### Core Endpoints

```
# Job Management
POST   /api/v1/jobs                    - Create job
GET    /api/v1/jobs                    - List jobs
GET    /api/v1/jobs/{id}               - Get job details
PUT    /api/v1/jobs/{id}               - Update job
DELETE /api/v1/jobs/{id}               - Delete job
POST   /api/v1/jobs/{id}/pause         - Pause job
POST   /api/v1/jobs/{id}/resume        - Resume job
POST   /api/v1/jobs/{id}/trigger       - Trigger immediate execution

# Executions
GET    /api/v1/jobs/{id}/executions    - List job executions
GET    /api/v1/executions/{id}         - Get execution details
POST   /api/v1/executions/{id}/cancel  - Cancel running execution
POST   /api/v1/executions/{id}/retry   - Retry failed execution

# Monitoring
GET    /api/v1/health                  - Health check
GET    /api/v1/metrics                 - System metrics
GET    /api/v1/workers                 - List workers
GET    /api/v1/dead-letter             - Dead letter queue
```

## Key Design Decisions

### Distributed Coordination

**Leader Election:**
- Uses Redis `SET NX EX` for simple, reliable leader election
- Lock TTL of 30 seconds with heartbeat every 10 seconds
- Standby schedulers attempt to acquire lock continuously

**Job Deduplication:**
- Distributed lock per job ID during execution
- Prevents duplicate execution when job recovered

### At-Least-Once Execution

**Visibility Timeout:**
- Jobs moved to processing set with timeout
- If not completed within timeout, recovered and re-enqueued
- Default timeout: 5 minutes

**Retry Logic:**
- Exponential backoff: `min(initial * 2^attempt, max)`
- Default: 1s initial, 1h max, 3 retries
- Failed jobs moved to dead letter queue

### Priority Scheduling

**Priority Queue:**
- Redis sorted set with inverted priority as score
- Higher priority jobs (100) get lower scores, processed first
- ZPOPMIN atomically removes highest priority job

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 18 + TypeScript | Modern, type-safe UI |
| **Routing** | TanStack Router | Type-safe routing |
| **State** | Zustand | Simple, lightweight state management |
| **Styling** | Tailwind CSS | Utility-first, rapid development |
| **Backend** | Node.js + Express | JavaScript ecosystem, async I/O |
| **Database** | PostgreSQL 15 | ACID, complex queries, reliability |
| **Queue** | Redis 7 | Fast, sorted sets for priority queue |
| **Logging** | Winston | Structured logging |

## Scalability Considerations

### Horizontal Scaling

- **API Servers**: Stateless, scale with load balancer
- **Schedulers**: Leader-elected, only one active
- **Workers**: Scale based on queue depth

### Database Scaling

- Read replicas for execution history queries
- Partition executions by month
- Archive old executions to cold storage

### Queue Scaling

- Redis Cluster for high throughput
- Separate queues per priority level if needed

## Trade-offs and Alternatives

| Decision | Trade-off | Alternative |
|----------|-----------|-------------|
| Redis queues | Fast, memory-bound | Kafka (more durable) |
| Leader election | Simple, single scheduler | Distributed scheduling (complex) |
| Visibility timeout | At-least-once, possible duplicates | Distributed transactions (overhead) |
| PostgreSQL | ACID, scaling limits | Cassandra (better scale, less consistency) |

## Monitoring and Observability

### Key Metrics

- `jobs_enqueued_total`: Counter of jobs enqueued
- `jobs_completed_total`: Counter of completed jobs
- `jobs_failed_total`: Counter of failed jobs
- `job_queue_depth`: Current queue depth
- `job_execution_duration_seconds`: Execution time histogram
- `scheduler_lag_seconds`: Time behind schedule
- `workers_active`: Number of active workers

### Alerting

- Queue depth > 1000 for > 5 minutes
- Failure rate > 10% for > 5 minutes
- Scheduler lag > 60 seconds
- No active workers when queue > 0

## Security Considerations

- Input validation on all API endpoints
- Rate limiting on job creation
- No secrets in job payloads (use environment variables)
- Shell command handler disabled in production

## Future Optimizations

- Job dependencies (DAG workflows)
- Multi-tenancy with tenant isolation
- Job rate limiting per type/tenant
- Webhook notifications for job events
- Prometheus metrics endpoint
- Grafana dashboards
- Job timeout warnings
- Scheduled maintenance windows
