# Job Scheduler

A distributed task scheduling system with cron-like scheduling, priority queues, worker pools, and at-least-once execution guarantees.

## Features

- **Job Management**: Create, update, delete, pause, resume, and trigger jobs
- **Cron Scheduling**: Support for cron expressions for recurring jobs
- **Priority Queues**: Jobs are executed based on priority (0-100)
- **Distributed Workers**: Scale horizontally with multiple worker instances
- **Retry Logic**: Exponential backoff with configurable max retries
- **Leader Election**: Scheduler uses Redis-based leader election for high availability
- **At-Least-Once Execution**: Guaranteed job execution with visibility timeouts
- **Dead Letter Queue**: Failed jobs are moved to DLQ for investigation
- **Real-time Dashboard**: Monitor jobs, executions, and workers in real-time

## Architecture

```
                    ┌─────────────────┐
                    │   Frontend      │
                    │   Dashboard     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   API Server    │
                    │   (Express)     │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐        ┌─────▼─────┐       ┌─────▼─────┐
    │ Scheduler│        │PostgreSQL │       │   Redis   │
    │ (Leader) │        │  (Jobs)   │       │  (Queue)  │
    └────┬─────┘        └───────────┘       └─────┬─────┘
         │                                        │
         └──────────────┬─────────────────────────┘
                        │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
┌───▼────┐         ┌────▼───┐          ┌────▼───┐
│Worker 1│         │Worker 2│          │Worker N│
└────────┘         └────────┘          └────────┘
```

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

## Quick Start

### Option 1: Docker Compose (Full Stack)

Start everything with Docker:

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

Access the dashboard at http://localhost:3000

### Option 2: Native Development

1. Start infrastructure (PostgreSQL + Redis):

```bash
docker-compose -f docker-compose.dev.yml up -d
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

4. Start services in separate terminals:

```bash
# Terminal 1: API Server
cd backend
npm run dev:api

# Terminal 2: Scheduler
cd backend
npm run dev:scheduler

# Terminal 3: Worker 1
cd backend
npm run dev:worker1

# Terminal 4: Worker 2 (optional)
cd backend
npm run dev:worker2

# Terminal 5: Frontend
cd frontend
npm run dev
```

Access the dashboard at http://localhost:3000

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
| POST | `/api/v1/jobs` | Create a new job |
| GET | `/api/v1/jobs` | List all jobs |
| GET | `/api/v1/jobs/:id` | Get job details |
| PUT | `/api/v1/jobs/:id` | Update a job |
| DELETE | `/api/v1/jobs/:id` | Delete a job |
| POST | `/api/v1/jobs/:id/pause` | Pause a job |
| POST | `/api/v1/jobs/:id/resume` | Resume a paused job |
| POST | `/api/v1/jobs/:id/trigger` | Trigger immediate execution |

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
| POST | `/api/v1/executions/:id/cancel` | Cancel a running execution |
| POST | `/api/v1/executions/:id/retry` | Retry a failed execution |

### Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | Health check |
| GET | `/api/v1/metrics` | System metrics |
| GET | `/api/v1/metrics/executions` | Execution statistics |
| GET | `/api/v1/workers` | List active workers |
| GET | `/api/v1/dead-letter` | Dead letter queue items |

## Built-in Job Handlers

| Handler | Description |
|---------|-------------|
| `http.webhook` | Call an HTTP endpoint |
| `shell.command` | Execute a shell command |
| `test.echo` | Echo the payload (testing) |
| `test.delay` | Delay for specified duration (testing) |
| `test.log` | Log a message (testing) |
| `system.cleanup` | Clean up old executions |

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
| `DATABASE_URL` | - | PostgreSQL connection string |
| `REDIS_URL` | - | Redis connection string |
| `SCHEDULER_INSTANCE_ID` | `scheduler-1` | Unique scheduler ID |
| `LEADER_LOCK_TTL` | `30` | Leader lock TTL in seconds |
| `SCAN_INTERVAL_MS` | `1000` | Job scan interval |
| `WORKER_ID` | `worker-1` | Unique worker ID |
| `MAX_CONCURRENT_JOBS` | `5` | Max jobs per worker |
| `VISIBILITY_TIMEOUT_MS` | `300000` | Job visibility timeout |

## Implementation Status

- [x] Initial architecture design
- [x] Core functionality implementation
- [x] Database/Storage layer
- [x] API endpoints
- [x] Worker service
- [x] Scheduler service
- [x] Frontend dashboard
- [x] Docker support
- [ ] Comprehensive testing
- [ ] Performance optimization
- [ ] Production hardening

## Key Design Decisions

1. **Leader Election**: Uses Redis `SET NX EX` for simple, reliable leader election
2. **At-Least-Once Delivery**: Jobs in processing have visibility timeouts; stalled jobs are recovered
3. **Priority Queue**: Redis sorted sets with inverted priority scores
4. **Exponential Backoff**: `min(initial * 2^attempt, max)` formula for retries

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
2. Verify queue has items: `redis-cli ZCARD job_scheduler:queue`
3. Check worker logs for errors

### Database connection issues

1. Verify PostgreSQL is running: `docker-compose ps`
2. Check connection string in `.env`
3. Run migrations: `npm run migrate`

## License

MIT
