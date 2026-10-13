# Job Scheduler

A distributed task scheduling system with cron-like scheduling, priority queues, worker pools, and at-least-once execution guarantees.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 11,626 |
| Source Files | 73 |
| .ts | 6,833 |
| .md | 2,080 |
| .tsx | 1,781 |
| .sql | 435 |
| .yml | 196 |

## Features

- **Job Management**: Create, update, delete, pause, resume, and trigger jobs
- **Cron Scheduling**: Support for cron expressions for recurring jobs
- **Priority Queue in PostgreSQL**: executions are claimed highest priority first with `FOR UPDATE SKIP LOCKED`
- **Distributed Workers**: Scale horizontally with multiple worker instances
- **Retry Logic**: Exponential backoff with jitter; `max_retries` counts retries after the first attempt
- **Leader Election**: Scheduler uses Redis-based leader election for high availability
- **At-Least-Once Execution**: 30 s leases renewed by heartbeat, a reaper for lapsed leases, and fencing tokens
- **Missed-Run Policy**: runs missed by more than 60 s are fired once (`fire_once`) or skipped (`skip`), per job
- **Dead Letter**: runs that exhaust their retries (or fail permanently) wait in `DEAD_LETTER` for a redrive
- **Dashboard**: monitor jobs, executions, and workers (polling every few seconds)

## Architecture

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ React dashboard :5173    ├─▶│ API server :3001         ├─▶│ Redis                    │
└──────────────────────────┘  └────────────┬─────────────┘  │ leader lease, sessions   │
                                           │                └──────────────────────────┘
                                           │ jobs, triggers
                                           │
                                           ▼
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│ Scheduler (leader)       ├─▶│ PostgreSQL               │◀─┤ Workers 1..3             │
│ fires slots, reaps       │  │ job_executions = queue   │  │ claim, lease, fence      │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
```

The execution table in PostgreSQL is the work queue: the scheduler fires each due slot in one
transaction, and workers claim executions with `FOR UPDATE SKIP LOCKED`, hold them under a
renewable lease, and record outcomes with writes fenced on the lease's token. Redis only holds
coordination state that can be rebuilt. See [architecture.md](./architecture.md) for the design.

## Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

## Quick Start

### Option 1: Docker Compose (Full Stack)

Start everything — infrastructure *and* the application — with Docker:

```bash
# Start all services (the `app` profile adds api, scheduler, workers, frontend)
docker-compose --profile app up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose --profile app down
```

Access the dashboard at http://localhost:3000

> The application containers sit behind the `app` profile so that a plain
> `docker-compose up -d` brings up **only PostgreSQL and Redis**. Without that,
> the api container claims host port 3001 and the frontend container claims
> 3000, and the local dev servers in Option 2 can never bind — silently, because
> the containers answer on those ports.

### Option 2: Native Development

1. Start infrastructure (PostgreSQL + Redis):

```bash
docker-compose up -d
```

2. Install dependencies:

```bash
# Backend
cd backend
npm install
cp .env.example .env

# Frontend
cd ../frontend
npm install
```

3. Run migrations and seed data:

```bash
cd backend
npm run migrate
npm run seed
```

4. Start the backend and frontend in two terminals:

```bash
# Terminal 1: API + scheduler + 3 workers
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev
```

`npm run dev` runs the whole topology through `concurrently`, mirroring the
container layout. To run a role on its own instead, use `npm run dev:api`,
`npm run dev:scheduler`, or `npm run dev:worker1` / `dev:worker2` / `dev:worker3`.

Access the dashboard at http://localhost:5173 and sign in with **`admin` /
`admin123`** (created automatically on API startup; override with
`ADMIN_USERNAME` / `ADMIN_PASSWORD`).

### Tests

```bash
cd backend
npm test        # unit tests (offline): backoff, cron/misfire planning, validation,
                # Idempotency-Key middleware, leader election, password hashing

# PostgreSQL integration tests for claiming, leases, fencing and firing.
# They TRUNCATE tables, so point them at a throwaway database:
createdb -U scheduler job_scheduler_test
TEST_DATABASE_URL=postgres://scheduler:scheduler@localhost:5432/job_scheduler_test npm test
```

## Running Distributed Workers

To simulate a distributed environment, run multiple worker instances:

```bash
# Terminal 1
WORKER_ID=worker-1 npm run dev:worker1

# Terminal 2
WORKER_ID=worker-2 npm run dev:worker2

# Terminal 3
WORKER_ID=worker-3 npm run dev:worker3
```

Each worker will register with Redis and pull jobs from the shared queue.

## API Documentation

### Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/jobs` | Create a job (validated; optional `Idempotency-Key` header) |
| GET | `/api/v1/jobs` | List all jobs |
| GET | `/api/v1/jobs/:id` | Get job details |
| PUT | `/api/v1/jobs/:id` | Update a job |
| DELETE | `/api/v1/jobs/:id` | Delete a job |
| POST | `/api/v1/jobs/:id/pause` | Pause a job |
| POST | `/api/v1/jobs/:id/resume` | Resume a paused job |
| POST | `/api/v1/jobs/:id/trigger` | Run now (optional `Idempotency-Key`; `409` while paused) |

#### Create Job Example

```bash
curl -X POST http://localhost:3001/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-report",
    "description": "Generate daily sales report",
    "handler": "http.webhook",
    "payload": {
      "url": "https://api.example.com/reports/generate",
      "method": "POST"
    },
    "schedule": "0 6 * * *",
    "priority": 75,
    "max_retries": 3,
    "timeout_ms": 60000
  }'
```

### Executions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/jobs/:id/executions` | List job executions |
| GET | `/api/v1/executions/:id` | Get execution details |
| POST | `/api/v1/executions/:id/cancel` | Cancel a pending or running execution (`409` if finished) |
| POST | `/api/v1/executions/:id/retry` | Run a failed, cancelled or dead-lettered run again as its next attempt |

### Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health`, `/api/v1/health/ready`, `/api/v1/health/live` | Health checks |
| GET | `/api/v1/metrics/system` | Dashboard metrics (queue depth, workers, breakers) |
| GET | `/metrics` | Prometheus scrape endpoint (scheduler and workers: set `METRICS_PORT`) |
| GET | `/api/v1/metrics/executions` | Execution statistics |
| GET | `/api/v1/workers` | List active workers |
| GET | `/api/v1/dead-letter` | Executions in `DEAD_LETTER` |

## Built-in Job Handlers

| Handler | Description |
|---------|-------------|
| `http.webhook` | Call an HTTP endpoint |
| `shell.command` | Execute a shell command |
| `test.echo` | Echo the payload (testing) |
| `test.delay` | Delay for specified duration (testing) |
| `test.log` | Log a message (testing) |
| `system.cleanup` | Logs what a cleanup would delete (no-op) |
| `system.maintenance` | Deletes executions older than 30 days and logs older than 7 |

Jobs naming any other handler are rejected with `400` at creation.

### Handler Payloads

#### http.webhook
```json
{
  "url": "https://api.example.com/webhook",
  "method": "POST",
  "headers": {"Authorization": "Bearer token"},
  "timeout": 30000
}
```

#### shell.command
```json
{
  "command": "python",
  "args": ["script.py", "--flag"],
  "cwd": "/app/scripts",
  "env": {"DEBUG": "1"}
}
```

#### test.delay
```json
{
  "durationMs": 5000,
  "shouldFail": false,
  "failMessage": "Simulated failure"
}
```

## Cron Schedule Examples

| Expression | Description |
|------------|-------------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour |
| `0 0 * * *` | Daily at midnight |
| `0 6 * * *` | Daily at 6 AM |
| `0 0 * * 0` | Weekly on Sunday |
| `0 0 1 * *` | Monthly on the 1st |

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | API server port |
| `DATABASE_URL` | `postgres://scheduler:scheduler@localhost:5432/job_scheduler` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `SCHEDULER_INSTANCE_ID` | `scheduler-<pid>` | Unique scheduler ID (the leader lease value) |
| `LEADER_LOCK_TTL` | `30` | Leader lease TTL in seconds (renewed every third) |
| `SCAN_INTERVAL_MS` | `1000` | Scheduler tick |
| `MISFIRE_GRACE_MS` | `60000` | How late a slot may be and still count as on time |
| `REAPER_INTERVAL_MS` | `5000` | How often the leader reclaims lapsed leases |
| `WORKER_ID` | `worker-<pid>` | Unique worker ID |
| `MAX_CONCURRENT_JOBS` | `5` | Executions a worker holds at once |
| `POLL_INTERVAL_MS` | `500` | Claim interval when the queue is empty |
| `LEASE_DURATION_MS` | `30000` | Execution lease; renewed every third, reclaimed when it lapses |
| `SHUTDOWN_GRACE_MS` | `10000` | On SIGTERM, how long a worker drains before handing work back |
| `METRICS_PORT` | unset | Serve `/metrics` from a scheduler or worker process |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123` | Admin user created on API startup |

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer
- [x] API endpoints
- [x] Worker service
- [x] Scheduler service
- [x] Frontend dashboard
- [x] Docker support
- [x] Unit tests and PostgreSQL integration tests (vitest)
- [ ] Performance optimization
- [ ] Production hardening

## Key Design Decisions

1. **The execution table is the queue**: PostgreSQL rows claimed with `FOR UPDATE SKIP LOCKED`, so firing, retries and outcomes are single-database transactions (no Redis/PostgreSQL dual write)
2. **Leases + fencing tokens**: a 30 s lease renewed by heartbeat; every outcome write is conditional on the claim's token, so a stalled worker cannot overwrite a newer attempt
3. **Leader election is an optimization**: the Redis lease keeps one scheduler busy, but the firing transaction (row locks + unique `(job_id, scheduled_at, attempt)`) is what prevents double firing
4. **Retries**: equal-jitter exponential backoff, one row per attempt, `DEAD_LETTER` after the budget; a lapsed lease counts as a failed attempt

## Troubleshooting

### Jobs not running

1. Check if the scheduler is the leader:
   - Look for "became leader" in scheduler logs
   - Check Redis key `job_scheduler:scheduler:leader`

2. Verify workers are connected:
   - Check the Workers page in dashboard
   - Look for heartbeat updates in Redis

3. Check job status:
   - Job must be `SCHEDULED` with valid `next_run_time`
   - Paused jobs won't be scheduled

### Worker not processing

1. Check Redis connection
2. Check the queue: `SELECT status, count(*) FROM job_executions WHERE status IN ('PENDING','RUNNING','DEAD_LETTER') GROUP BY 1;`
   PENDING rows whose job is `PAUSED` are held until the job is resumed
3. Check worker logs for errors

### Database connection issues

1. Verify PostgreSQL is running: `docker-compose ps`
2. Check connection string in `.env`
3. Run migrations: `npm run migrate`

## License

MIT

## References & Inspiration

- [Uber's Schemaless Job Scheduler](https://www.uber.com/blog/cherami-message-queue-system/) - How Uber built a distributed task queue
- [Airflow Architecture Overview](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/overview.html) - Apache Airflow's DAG-based workflow scheduler
- [Designing a Distributed Job Scheduler](https://levelup.gitconnected.com/designing-a-distributed-job-scheduler-461ac0c3a9e8) - System design walkthrough for job scheduling
- [Redis as a Job Queue](https://redis.io/docs/manual/patterns/distributed-locks/) - Using Redis for distributed locks and queues
- [Celery Best Practices](https://docs.celeryq.dev/en/stable/userguide/tasks.html) - Task queue patterns from Python's Celery
- [How Robinhood Built a Distributed Job Scheduler](https://robinhood.engineering/how-we-built-a-distributed-job-scheduler-eff7e7caa95e) - Building reliable job scheduling at scale
- [Sidekiq in Practice](https://www.mikeperham.com/2015/11/05/sidekiq-job-best-practices/) - Best practices for background job processing
- [Temporal: Open Source Durable Execution](https://docs.temporal.io/concepts/what-is-temporal) - Modern approach to workflow orchestration
- [Cron at Scale: Pinterest's PinLater](https://medium.com/pinterest-engineering/pinlater-an-asynchronous-job-execution-system-b8664cb8aa7d) - Pinterest's async job execution system
