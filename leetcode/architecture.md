# LeetCode - Online Judge - Architecture Design

## System Overview

An online coding practice and evaluation platform that allows users to solve programming problems, submit code solutions, and receive automated feedback. The system executes user-submitted code in a secure sandbox environment and validates outputs against test cases. Core challenges include secure code execution at scale, fair resource allocation across users, and real-time feedback delivery.

**Learning Goals:**
- Sandboxed code execution with defense-in-depth security
- Asynchronous processing with status polling
- Circuit breaker and rate limiting for resource protection
- Idempotent submission handling
- Queue-based execution worker scaling

---

## Requirements

### Functional Requirements

1. **Problem Database**: CRUD operations for coding problems with descriptions, examples, constraints, and test cases
2. **Code Execution**: Run user-submitted code in isolated sandboxes with resource limits (Python, JavaScript, C++, Java)
3. **Test Case Validation**: Compare program output against expected results with tolerance for formatting differences
4. **User Progress Tracking**: Track solved problems, attempts, best runtime per user
5. **Leaderboards**: Display user rankings by problems solved and performance metrics
6. **Admin Interface**: Problem management, user administration, system monitoring

### Non-Functional Requirements (Production Scale)

| Requirement | Target |
|-------------|--------|
| Availability | 99.9% uptime |
| Latency | p95 < 200ms for API reads, p95 < 500ms for API writes |
| Execution Latency | p95 < 5s for easy problems, p95 < 15s for hard problems |
| Throughput | 500 submissions/second at peak (contests) |
| Consistency | Strong for submissions and progress; eventual for leaderboards |
| Security | Zero escape from sandbox; no network, filesystem, or privilege escalation |

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Daily Active Users | 50,000 |
| Submissions per user/day | 5-10 |
| Peak submissions/second | 500 (during contests) |
| Problem views/second | 5,000 |
| Problems in database | 3,000+ |
| Storage (submissions, 1 year) | ~2.5 TB |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 5-10 |
| Submissions/day | 50-200 |
| Problems | 15 (seeded) |
| Concurrent executions | 5 max |
| Total storage (6 months) | ~500 MB |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client (Browser)                           │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐              │
│  │  Problem   │  │ Code Editor  │  │  Progress  │              │
│  │  Catalog   │  │ (CodeMirror) │  │  Dashboard │              │
│  └────────────┘  └──────────────┘  └────────────┘              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS
                            ▼
                  ┌─────────────────────┐
                  │    API Gateway /    │
                  │   Load Balancer     │
                  └──────────┬──────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  API Server  │ │  API Server  │ │  API Server  │
      │  (Node.js)   │ │  (Node.js)   │ │  (Node.js)   │
      └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
             │                │                │
             └────────────────┼────────────────┘
                              │
       ┌──────────┬───────────┼───────────┬──────────┐
       ▼          ▼           ▼           ▼          ▼
┌───────────┐ ┌────────┐ ┌────────┐ ┌─────────┐ ┌─────────────┐
│PostgreSQL │ │ Redis/ │ │ Kafka  │ │Execution│ │  Execution  │
│(Problems, │ │ Valkey │ │(Submit │ │Worker 1 │ │  Worker N   │
│ Users,    │ │(Cache +│ │ Queue) │ │(Docker) │ │  (Docker)   │
│ Subs)     │ │Session)│ │        │ │         │ │             │
└───────────┘ └────────┘ └────────┘ └─────────┘ └─────────────┘
```

### Request Flow: Code Submission

```
1. User submits code via POST /api/v1/submissions
   │
2. API checks idempotency (same user + code + problem within 5 min)
   │
3. API validates request, creates submission record (status: pending)
   │
4. API returns 202 Accepted with submission ID immediately
   │
5. Submission published to Kafka topic (or processed in-process)
   │
6. Execution worker consumes from queue:
   │
   ├──► Update status to "running" in PostgreSQL + Redis cache
   │
   ├──► For each test case:
   │       ├──► Write code to temp file
   │       ├──► Spawn Docker container with security restrictions
   │       ├──► Pipe input, collect output with timeout
   │       ├──► Compare output to expected (with normalization)
   │       └──► Update progress in Redis cache
   │
   ├──► Update final status in PostgreSQL
   │
   └──► Update user_problem_status if accepted
   │
7. Frontend polls GET /api/v1/submissions/:id/status every 1-2 seconds
   │
8. Redis cache returns current progress until complete
```

---

## Core Components

### 1. API Server (Express.js)

Handles HTTP routing, session management, and business logic. Stateless design allows horizontal scaling behind a load balancer.

### 2. Code Executor (Docker + Dockerode)

Executes untrusted user code in isolated containers with defense-in-depth:

**Security layers:**
1. **Network isolation**: `NetworkMode: 'none'` prevents all network access
2. **Filesystem isolation**: Read-only mount, no access to host filesystem
3. **Resource limits**: 256MB memory, 50% CPU, 50 process limit
4. **Privilege dropping**: All Linux capabilities dropped, no privilege escalation
5. **Timeout enforcement**: Hard kill after time limit (2-10 seconds per test case)
6. **Cleanup**: Container auto-removed after execution

**Container configuration:**
- Memory: 256 MB hard limit, no swap
- CPU: 50% of one core
- PIDs: Max 50 processes
- Network: None
- Security: `no-new-privileges`, `CapDrop: ALL`
- Cleanup: `AutoRemove: true`

### 3. Kafka Queue (Optional Production Path)

Decouples submission API from execution workers. Provides backpressure handling, independent scaling, retry semantics, and priority queues for premium users.

### 4. Submission Status Cache (Redis)

Write-through cache for submission status. Frontend polls Redis for sub-millisecond responses during execution. Status entries have 5-minute TTL and are updated on every test case completion.

---

## Database Schema

```sql
-- Users: authentication and profile
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Problems: coding challenges
CREATE TABLE problems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT NOT NULL,
  examples TEXT,
  constraints TEXT,
  difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  time_limit_ms INTEGER DEFAULT 2000,
  memory_limit_mb INTEGER DEFAULT 256,
  starter_code_python TEXT,
  starter_code_javascript TEXT,
  solution_python TEXT,
  solution_javascript TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Test cases: inputs and expected outputs
CREATE TABLE test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  is_sample BOOLEAN DEFAULT FALSE,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Submissions: user code attempts
CREATE TABLE submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  language VARCHAR(20) NOT NULL,
  code TEXT NOT NULL,
  status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'accepted', 'wrong_answer',
    'time_limit_exceeded', 'memory_limit_exceeded',
    'runtime_error', 'compile_error', 'system_error'
  )),
  runtime_ms INTEGER,
  memory_kb INTEGER,
  test_cases_passed INTEGER DEFAULT 0,
  test_cases_total INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User progress: tracks solve status per problem
CREATE TABLE user_problem_status (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'unsolved' CHECK (status IN ('solved', 'attempted', 'unsolved')),
  best_runtime_ms INTEGER,
  best_memory_kb INTEGER,
  attempts INTEGER DEFAULT 0,
  solved_at TIMESTAMP,
  PRIMARY KEY (user_id, problem_id)
);

-- Performance indexes
CREATE INDEX idx_submissions_user_id ON submissions(user_id);
CREATE INDEX idx_submissions_problem_id ON submissions(problem_id);
CREATE INDEX idx_submissions_created_at ON submissions(created_at);
CREATE INDEX idx_test_cases_problem_id ON test_cases(problem_id);
CREATE INDEX idx_problems_slug ON problems(slug);
CREATE INDEX idx_problems_difficulty ON problems(difficulty);
```

### Caching Strategy

**Cache-aside pattern** for problem data:
1. Check Redis for `problem:{slug}`
2. On miss, query PostgreSQL, store in Redis with 5-minute TTL
3. On problem update/delete, invalidate cache key

**Write-through for submission status:**
1. Write status to Redis immediately on change
2. Write to PostgreSQL for persistence
3. Frontend polls Redis for low-latency updates

**Cache key patterns:**
```
session:{sessionId}           -> User session data (7 day TTL)
problem:{slug}                -> Problem JSON (5 min TTL)
submission:{id}:status        -> Submission progress JSON (5 min TTL)
```

---

## API Design

### Core Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| **Auth** | | | |
| POST | `/api/v1/auth/register` | None | Create new user account |
| POST | `/api/v1/auth/login` | None | Login, create session |
| POST | `/api/v1/auth/logout` | User | Destroy session |
| GET | `/api/v1/auth/me` | User | Get current user info |
| **Problems** | | | |
| GET | `/api/v1/problems` | None | List problems (paginated, filterable) |
| GET | `/api/v1/problems/:slug` | None | Get problem details + sample test cases |
| GET | `/api/v1/problems/:slug/submissions` | User | Get user's submissions for problem |
| POST | `/api/v1/problems` | Admin | Create new problem |
| **Submissions** | | | |
| POST | `/api/v1/submissions` | User | Submit code for judging |
| POST | `/api/v1/submissions/run` | User | Run code against sample tests only |
| GET | `/api/v1/submissions/:id` | User | Get submission details |
| GET | `/api/v1/submissions/:id/status` | User | Poll submission status (cached) |
| **Users** | | | |
| GET | `/api/v1/users/progress` | User | Get user's solve progress |
| **Admin** | | | |
| GET | `/api/v1/admin/stats` | Admin | System statistics |
| GET | `/api/v1/admin/users` | Admin | List all users |

---

## Key Design Decisions

### 1. Docker Containers for Code Execution

**Decision**: Use Docker containers with strict security restrictions instead of gVisor, Firecracker, or process-level sandboxing.

**Why it works**: Docker provides strong isolation through Linux namespaces and cgroups with mature, well-documented tooling. Each submission runs in a fresh container with no network, no host filesystem access, no capabilities, and hard resource limits. The `dockerode` library gives programmatic control over container lifecycle.

**Why gVisor/Firecracker fail for this context**: gVisor adds kernel-level isolation but introduces compatibility issues (some syscalls behave differently, breaking certain Python/Node.js operations). Firecracker provides VM-level isolation with fast boot times but is AWS-specific and overkill for a learning project. Both add significant operational complexity for marginal security gain over Docker with `CapDrop: ALL` and `no-new-privileges`.

**Why process sandboxing (seccomp) fails**: Process-level sandboxing with seccomp profiles requires writing and maintaining complex syscall allowlists per language runtime. A single missing syscall causes cryptic failures. Docker abstracts this complexity while still leveraging seccomp under the hood.

**Trade-off**: Docker adds ~100-200ms overhead per execution vs. raw process spawning. For an online judge where executions take 2-15 seconds, this overhead is negligible. The isolation guarantee is worth the cost.

### 2. Polling vs. WebSocket for Status Updates

**Decision**: HTTP polling with Redis-cached status instead of WebSocket push.

**Why it works**: Submission execution takes 2-15 seconds. Polling every 1-2 seconds means the user sees at most 2 seconds of stale data. Redis returns cached status in sub-millisecond time, so the polling load is negligible.

**Why WebSocket fails here**: WebSocket requires persistent connections, connection lifecycle management, and reconnection logic. For a workflow where the user submits, waits a few seconds, and gets a result, the complexity of maintaining bidirectional channels is unjustified. WebSocket connections also consume server memory proportional to concurrent users, while polling requests are stateless.

**Trade-off**: Slight latency (1-2s) compared to instant WebSocket push. The user experience difference is imperceptible when the total execution takes 5+ seconds. Easy to upgrade to WebSocket later if contests require sub-second updates.

### 3. Idempotency via Content-Hash Deduplication

**Decision**: Hash-based deduplication using `hash(userId + problemSlug + normalizedCode + language)` with 5-minute TTL in Redis.

**Why it works**: When a user double-clicks submit or refreshes during a pending submission, the same code is submitted again. The content hash matches the in-flight submission, and the server returns the existing submission ID instead of spawning a duplicate container. This saves expensive Docker resources and prevents duplicate entries in the submissions table.

**Why client-generated idempotency keys fail here**: Unlike email (where compose opens once), code editors allow rapid re-submissions of the same code. A client-generated UUID would be different each time, defeating deduplication. Content-hashing catches semantically identical submissions regardless of when they were triggered.

**Trade-off**: The 5-minute TTL means intentional resubmissions of identical code within 5 minutes return the cached result. This is acceptable because identical code produces identical results. If the user changes even one character, the hash changes and a new submission is created.

---

## Security

### Authentication and Authorization

**Session-based auth with Redis store:**
- HTTP-only cookies, SameSite=lax, secure in production
- 7-day session TTL
- bcrypt password hashing

**Role-based access control (RBAC):**

| Role | Permissions |
|------|-------------|
| Anonymous | View problems, view leaderboard |
| User | Submit code, run tests, view own submissions, track progress |
| Admin | All user permissions + create/edit problems, view all users, system stats |

### Input Validation

- Code size limit: 1 MB max via `express.json({ limit: '1mb' })`
- Language whitelist: Only `python`, `javascript`, `cpp`, `java` accepted
- Slug validation: Alphanumeric + hyphens only
- SQL injection prevention: Parameterized queries throughout

### Rate Limiting

Per-user rate limits protect expensive execution resources:

| Endpoint | Window | Max | Rationale |
|----------|--------|-----|-----------|
| Submissions | 1 min | 10 | Protects Docker resources (256MB per container) |
| Code runs | 1 min | 30 | Less expensive, sample tests only |
| General API | 1 min | 100 | Prevents scraping/abuse |
| Auth | 15 min | 5 | Prevents brute force |

---

## Observability

### Prometheus Metrics

| Metric | Type | Alert Threshold |
|--------|------|-----------------|
| `http_requests_total` | Counter | N/A |
| `http_request_duration_seconds` | Histogram | p95 > 2s |
| `submissions_total` | Counter | N/A |
| `submission_duration_seconds` | Histogram | p95 > 15s |
| `submission_status` | Counter (by status) | `system_error` rate > 5% |
| `code_execution_duration_seconds` | Histogram | p95 > 10s |
| `docker_containers_active` | Gauge | > 10 (resource exhaustion) |
| `postgresql_connections` | Gauge | > 80% of pool |
| `redis_memory_used_bytes` | Gauge | > 80% of limit |

### Structured Logging (Pino)

- JSON format for log aggregation
- Contextual fields: userId, submissionId, problemSlug, durationMs
- Log levels: ERROR (system failures), WARN (rate limits, slow queries), INFO (submissions), DEBUG (request details)

### Health Check Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Detailed check (PostgreSQL + Redis latency) |
| `GET /health/live` | Liveness probe (process alive) |
| `GET /health/ready` | Readiness probe (dependencies healthy) |

---

## Failure Handling

### Circuit Breaker Pattern (Opossum)

Applied to Docker execution to prevent cascading failures when the Docker daemon is unavailable:
- **Error threshold**: 50% failure rate with minimum 5 requests
- **Reset timeout**: 30 seconds before half-open test
- **Timeout**: 60 seconds per execution
- **Fallback**: Return 503 immediately with "retry later" message

When the circuit is open, users can still browse problems, view previous submissions, check leaderboards, and access their profile. Only new submissions fail fast.

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Database queries | 3 | Exponential (100ms, 200ms, 400ms) | Safe for reads; writes use transactions |
| Redis operations | 2 | Fixed 50ms | Safe (all operations idempotent) |
| Docker container spawn | 2 | Fixed 500ms | Submission ID ensures single execution |
| Image pull | 1 | N/A | Cached locally after first pull |

### Graceful Degradation

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis down | Sessions lost, slower status polling | Fall back to PostgreSQL for status |
| PostgreSQL slow | API latency increases | Return cached data where available |
| Docker unavailable | Submissions fail | Return `system_error`, circuit breaker opens |
| Container timeout | Single submission fails | Return `time_limit_exceeded` |
| Container OOM | Single submission fails | Return `memory_limit_exceeded` |

---

## Scalability Considerations

### Horizontal Scaling Path

```
┌──────────┐    ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│  Browser │───▶│    Load     │───▶│  API Server  │───▶│  PostgreSQL     │
│          │    │  Balancer   │    │  (N instances)│    │  (Primary +     │
│          │    │             │    │              │    │   Read Replicas) │
└──────────┘    └─────────────┘    └──────┬───────┘    └─────────────────┘
                                          │
                                    ┌─────▼──────┐
                                    │   Kafka    │
                                    │  (Submit   │
                                    │   Queue)   │
                                    └─────┬──────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                   ┌────────────┐  ┌────────────┐  ┌────────────┐
                   │  Exec      │  │  Exec      │  │  Exec      │
                   │  Worker 1  │  │  Worker 2  │  │  Worker N  │
                   │  (Docker)  │  │  (Docker)  │  │  (Docker)  │
                   └────────────┘  └────────────┘  └────────────┘
```

### Bottleneck Analysis

| Component | Bottleneck | Solution |
|-----------|------------|----------|
| API Server | CPU-bound request handling | Add instances behind load balancer |
| PostgreSQL | Connection limits, write throughput | Read replicas, connection pooling (PgBouncer) |
| Redis | Single-threaded, memory-bound | Redis Cluster for sharding |
| Code Execution | Memory per container (256MB x N) | Dedicated execution workers on separate hosts |
| Kafka | Partition count limits parallelism | Add partitions, key by problem difficulty |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Code execution | Docker containers | gVisor, Firecracker, seccomp | Strong isolation, mature tooling, acceptable overhead |
| Status updates | HTTP polling + Redis | WebSocket | Simpler for short-lived workflows, negligible latency |
| Deduplication | Content-hash idempotency | Client-generated UUID | Catches identical code resubmissions |
| Database | PostgreSQL | SQLite, MongoDB | ACID compliance, relational queries for leaderboards |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Execution queue | Kafka (optional) | In-process async | Independent scaling of API vs. workers |
| Languages | Alpine Docker images | Full images | 50-100MB vs. 500MB+, faster pulls |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Architecture

```
┌─────────────────────────────────┐
│     Browser (localhost:5173)    │
│  React + CodeMirror + Tailwind │
│  Problem list (virtualized)    │
└───────────────┬─────────────────┘
                │ HTTP
                ▼
┌─────────────────────────────────┐       ┌──────────────────────┐
│  Express API (localhost:3001)   │──────▶│  Kafka (optional)    │
│  Routes: auth, problems,       │       │  localhost:9092       │
│  submissions, admin, users     │       └──────────┬───────────┘
│  + /metrics + /health          │                  │
└──────┬──────┬──────┬────────────┘                  ▼
       │      │      │               ┌──────────────────────────┐
       ▼      ▼      ▼               │  Execution Worker        │
┌────────┐ ┌──────┐ ┌─────────┐     │  (Docker containers via  │
│Postgres│ │Valkey│ │ Docker  │     │   dockerode)             │
│ :5432  │ │:6379 │ │ Daemon  │     └──────────────────────────┘
└────────┘ └──────┘ └─────────┘
```

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breakers | opossum | `backend/src/shared/circuitBreaker.ts` | Wraps Docker execution; opens after 50% failure rate to prevent cascading failures |
| Rate limiting | express-rate-limit | `backend/src/shared/rateLimiter.ts` | Per-endpoint limits protect Docker resources from abuse |
| Idempotency | custom content-hash | `backend/src/shared/idempotency.ts` | Deduplicates identical submissions within 5-minute window |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | HTTP, submission, execution, circuit breaker, and cache metrics at `/metrics` |
| Structured logging | pino | `backend/src/shared/logger.ts` | JSON logs with contextual fields, request timing |
| Health checks | custom | `backend/src/routes/` | Liveness, readiness, dependency checks |
| Kafka queue | kafkajs | `backend/src/shared/kafka.ts` | Optional queue-based execution for production-scale decoupling |
| Virtualized list | @tanstack/react-virtual | `frontend/src/` | Problem catalog renders only visible rows for 60fps scrolling |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Dedicated execution worker hosts | Docker containers on same machine | Max 5 concurrent executions (1.25 GB) |
| Kafka cluster with partitions | Optional single-broker Kafka | Can also run in-process without Kafka |
| Load balancer + N API servers | Single Express server (can run 3 via npm scripts) | No automatic load distribution |
| PostgreSQL with read replicas | Single PostgreSQL 16 instance | All queries hit one node |
| Redis Cluster | Single Valkey instance | No sharding needed at dev scale |
| Container image registry | Local Docker image cache | Images built/pulled on first use |

### What Was Omitted

- CDN for static assets
- Multi-region deployment
- Kubernetes orchestration
- WebSocket for real-time contest updates
- Contest mode with time-limited competitions
- Code plagiarism detection (MOSS algorithm)
- Additional languages beyond Python, JavaScript, C++, Java
- Pre-warmed container pools for cold-start reduction
- Code complexity analysis and style linting
