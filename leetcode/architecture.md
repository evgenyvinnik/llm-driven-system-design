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

### Frontend Architecture

The frontend is a React + TypeScript application built with Vite, using React Router DOM v6 for routing, Zustand for state management, and Tailwind CSS for styling. It replicates LeetCode's dark-themed coding workspace with a split-pane layout: problem description on the left, code editor on the right.

**Component Hierarchy:**

```
main.tsx (RootLayout -- Navbar + Outlet, auth check on mount)
├── HomePage (landing page with stats and call-to-action)
├── ProblemsPage (virtualized problem catalog)
│   └── DifficultyBadge (Easy/Medium/Hard color-coded pill)
├── ProblemPage (split-pane coding workspace)
│   ├── Left Panel: problem description + submissions tab
│   │   ├── ReactMarkdown (renders problem description, examples, constraints)
│   │   ├── DifficultyBadge
│   │   └── StatusBadge (Accepted/Wrong Answer/TLE/etc.)
│   └── Right Panel: code editor + test results
│       ├── CodeEditor (CodeMirror with VS Code dark theme)
│       ├── TestResults (per-test-case pass/fail display)
│       └── Action buttons (Run / Submit)
├── ProgressPage (user solve progress with difficulty breakdown)
├── AdminPage (platform stats, leaderboard, user management)
├── LoginPage
└── RegisterPage
```

**Zustand Stores:**

1. **`useAuthStore`**: Manages authentication state. Holds the current user (id, username, role), loading flag, and authentication status. The `checkAuth` action calls `GET /api/v1/auth/me` on mount (triggered from the `RootLayout`'s `useEffect`) to validate the session cookie. Login and register actions update the store and redirect on success.

2. **`useEditorStore`**: Manages the code editor state across the problem workspace. Holds the selected language (`python` or `javascript`), current code, original starter code (for reset), and loading flags for run/submit operations. The `resetCode` action restores the code to the original starter code, and `setOriginalCode` updates both the original and current code simultaneously (used when switching languages).

**Data Fetching Pattern:**

All API calls are centralized in `services/api.ts`, which exports domain-specific API objects (`authApi`, `problemsApi`, `submissionsApi`, `usersApi`, `adminApi`). A shared `request` helper handles JSON serialization, cookie-based credentials, and error responses. Notably, it includes a custom `RateLimitError` class that captures the `retryAfter` value from HTTP 429 responses, allowing the UI to display how long the user must wait before retrying.

**Problem List Virtualization:**

The `ProblemsPage` uses `@tanstack/react-virtual` to render only the visible problem rows. Each row is estimated at 48px with 10 rows of overscan. The virtualizer positions items absolutely within a container whose height equals `rowVirtualizer.getTotalSize()`. This enables smooth 60fps scrolling even with thousands of problems. Client-side search filtering runs on the full problem list, and the virtualizer re-renders based on the filtered count.

**Split-Pane Problem Workspace:**

The `ProblemPage` uses a 50/50 horizontal split layout (`w-1/2` on each panel). The left panel has tabbed navigation between "Description" (rendered with `react-markdown`) and "Submissions" (the user's submission history for this problem). The right panel contains the code editor, a fixed-height test results panel (256px), and action buttons.

**Code Editor Integration:**

The `CodeEditor` component wraps `@uiw/react-codemirror` with the VS Code dark theme. It dynamically loads the correct language extension (`@codemirror/lang-python` or `@codemirror/lang-javascript`) based on the selected language. The editor supports line numbers, bracket matching, auto-completion, code folding, and multiple selections. The component is controlled: code content flows through the `value` prop and changes via the `onChange` callback.

**Submission Polling:**

When a user submits code, the API returns a 202 Accepted with a submission ID. The frontend then polls `GET /api/v1/submissions/:id/status` every 1 second to check execution progress. The polling displays real-time updates: "Running test 3 of 10..." during execution, "Accepted! Runtime: 45ms" on success, or the error status (Wrong Answer, TLE, Runtime Error) on failure. Polling stops when the status is no longer `pending` or `running`, with a maximum of 60 attempts as a safety limit. After completion, the submissions list is automatically refreshed.

**Routing:**

React Router DOM v6 with a `createBrowserRouter` configuration (not TanStack Router, a deliberate deviation from the repository default documented in the project CLAUDE.md). Routes: `/` (home), `/problems` (catalog), `/problems/:slug` (workspace), `/progress` (user stats), `/admin` (admin dashboard), `/login`, `/register`. The `RootLayout` component wraps all routes with a `Navbar` and triggers `checkAuth` on mount.

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

### Production Pattern Deep Dives

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before.

**Circuit Breaker (`backend/src/shared/circuitBreaker.ts`):**

A circuit breaker prevents an application from repeatedly calling a failing service, avoiding resource waste and cascading failures. The analogy is electrical: when current exceeds a safe threshold, the breaker trips and cuts the circuit to prevent damage.

In this project, the circuit breaker wraps Docker container execution -- the most failure-prone operation. The Docker daemon can become unavailable (out of memory, disk full, daemon crash), and without a breaker, every submission would spawn a container that hangs for 60 seconds before timing out. With 50 concurrent users submitting, that means 50 threads blocked for 60 seconds each, exhausting the API server's capacity.

The breaker has three states: **Closed** (requests flow normally, Docker containers are spawned), **Open** (requests are rejected immediately with a 503 response and "retry later" message), and **Half-Open** (after a 30-second cooldown, one test submission is allowed through to check if Docker has recovered). The breaker opens when the failure rate exceeds 50% with at least 5 requests in the measurement window.

When the breaker is open, the user experience degrades gracefully: users can still browse problems, view their submission history, check the leaderboard, and access their profile. Only new code submissions fail fast. The breaker state is exposed as a Prometheus gauge (`circuit_breaker_state`), enabling operations teams to detect and respond to Docker outages.

**Rate Limiting (`backend/src/shared/rateLimiter.ts`):**

Rate limiting restricts how many requests a client can make within a time window. Without it, a single user could submit code thousands of times per minute, spawning thousands of Docker containers and exhausting system resources (each container uses 256MB of memory).

This project implements per-endpoint rate limiting with four tiers:

- **Submissions (10/minute)**: The most expensive operation. Each submission spawns a Docker container with 256MB memory, runs user code against all test cases, and writes results to the database. Allowing unlimited submissions would let a single user consume 2.5GB+ of memory.
- **Code runs (30/minute)**: Less expensive than submissions because they only run against sample test cases and do not persist results.
- **General API (100/minute)**: Prevents scraping of problem descriptions and solutions.
- **Auth endpoints (5/15 minutes)**: Brute-force protection for login attempts.

The implementation uses `express-rate-limit`, which stores request counts in memory by default. For multi-instance deployments, a Redis-backed store would be needed to enforce limits globally. When a client exceeds the limit, the server returns HTTP 429 (Too Many Requests). The frontend's API client has a custom `RateLimitError` class that parses the `retryAfter` value, allowing the UI to display "Please wait X seconds before trying again."

**Idempotency (`backend/src/shared/idempotency.ts`):**

Idempotency ensures that performing the same operation multiple times has the same effect as performing it once. For a code submission platform, the critical scenario is: a user clicks "Submit," the network is slow, they click again. Without idempotency protection, two identical Docker containers are spawned, two submission records are created, and the user sees duplicate entries in their history.

This project uses content-hash-based deduplication rather than client-generated idempotency keys. The hash is computed from `userId + problemSlug + normalizedCode + language`. Before creating a new submission, the server checks Redis for a matching hash (with a 5-minute TTL via `SET NX EX 300`). If found, the server returns the existing submission ID without spawning a new container.

Content hashing is preferred over client-generated UUIDs because the deduplication target is identical code. A client-generated UUID would be different on each click, defeating the purpose. The 5-minute TTL is a trade-off: within 5 minutes, identical code returns the cached result (which is correct because identical code produces identical output). After 5 minutes, the hash expires and a fresh submission can be created.

**Prometheus Metrics (`backend/src/shared/metrics.ts`):**

Prometheus is a pull-based monitoring system. The application exposes metrics at `GET /metrics` in a text format that a Prometheus server scrapes at regular intervals (typically every 15 seconds). The scraped data is stored as time series for graphing, dashboarding (Grafana), and alerting.

Metrics come in four types, each suited for different measurement needs:

- **Counters** (only go up): `submissions_total` (labeled by status: accepted, wrong_answer, TLE, etc.), `http_requests_total` (by method, route, status code). Used to track throughput and error rates.
- **Histograms** (bucket values into ranges): `http_request_duration_seconds` (with buckets at 10ms, 50ms, 100ms, 500ms, 1s, 5s), `code_execution_duration_seconds`, `submission_duration_seconds`. Used to compute percentiles: "what is the p95 execution time?"
- **Gauges** (go up and down): `docker_containers_active` (how many containers are currently running), `postgresql_connections` (current pool utilization), `circuit_breaker_state`. Used to track current system state and set capacity alerts.

These metrics enable critical alerts: if `docker_containers_active` exceeds 10, the system is approaching resource exhaustion and should stop accepting submissions. If `submission_status{status="system_error"}` rate exceeds 5%, Docker may be failing and the operations team should investigate.

**Structured Logging (`backend/src/shared/logger.ts`):**

Structured logging emits log entries as machine-parsable JSON objects rather than free-form text strings. Instead of `"User alice submitted Python solution for two-sum, took 234ms, accepted"`, the logger emits `{"level":"info","event":"submission_complete","userId":"abc","problemSlug":"two-sum","language":"python","durationMs":234,"status":"accepted","testsPassed":5,"testsTotal":5}`.

This project uses the Pino library, chosen for its speed. Pino avoids synchronous string formatting and instead serializes JSON directly. Each log entry includes contextual fields: `userId` (who triggered the action), `submissionId` (which submission), `problemSlug` (which problem), and `durationMs` (how long it took).

Log levels are used deliberately: **ERROR** for system failures (Docker daemon unreachable, database connection lost), **WARN** for rate limit hits and slow queries (>1s), **INFO** for business events (submission created, user registered), and **DEBUG** for request-level details (disabled in production). In a production environment, these JSON logs would be shipped to a log aggregation service where engineers can search, filter, and build dashboards.

**RBAC -- Role-Based Access Control (Security section):**

RBAC is an authorization model where permissions are assigned to roles, and users are assigned to roles. Rather than checking "can user X access endpoint Y" for every user individually, the system defines roles with specific permission sets and assigns users to those roles.

This project has two roles:

| Role | Permissions |
|------|-------------|
| `user` | View problems, submit code, run tests, view own submissions, track own progress |
| `admin` | All user permissions + create/edit/delete problems, view all users, access system stats, view leaderboard |

Role checking happens in Express middleware. The `requireAuth` middleware verifies the session and attaches the user to the request. Route-specific middleware (e.g., `requireAdmin`) checks `req.user.role === 'admin'` and returns 403 Forbidden if the check fails. Anonymous users (no session) can still view problem descriptions and the leaderboard, but cannot submit code or access user-specific features.

The RBAC model is stored in the database (`users.role` column with a CHECK constraint: `role IN ('user', 'admin')`). This is simpler than a full permission table but sufficient for this domain. A more complex system (like GitHub's repository-level permissions) would need a separate `permissions` table with `(user_id, resource_type, resource_id, permission_level)` tuples.

**Health Checks (`backend/src/routes/`):**

Health check endpoints report whether the application and its dependencies are functioning correctly. They serve three distinct purposes with three different endpoints:

- **`GET /health`** (detailed check): Measures PostgreSQL and Redis connectivity with round-trip latency. Returns a JSON object with individual dependency statuses, connection pool usage, and uptime. Used by operations dashboards and on-call engineers to diagnose issues.

- **`GET /health/live`** (liveness probe): Returns HTTP 200 if the server process is alive. Used by Kubernetes to detect hung processes (deadlock, infinite loop, unresponsive event loop). If this fails, the orchestrator kills and restarts the container. This endpoint intentionally does not check external dependencies: a PostgreSQL outage should not trigger container restarts across the entire fleet.

- **`GET /health/ready`** (readiness probe): Checks whether PostgreSQL and Redis are reachable. Used by the load balancer to decide whether to route traffic to this instance. During startup (while the server is establishing database connections) and during dependency outages, this returns unhealthy and the load balancer stops routing traffic -- but the container is not restarted.

The liveness/readiness distinction prevents a common failure mode: if PostgreSQL goes down and the health check triggers container restarts, all API instances restart simultaneously, creating a thundering herd that overwhelms PostgreSQL when it comes back up. With separate probes, the instances stay alive (liveness = healthy) but stop accepting traffic (readiness = unhealthy), and resume gracefully when PostgreSQL recovers.

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
