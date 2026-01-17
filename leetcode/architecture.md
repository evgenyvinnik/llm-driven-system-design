# LeetCode - Online Judge - Architecture Design

## System Overview

An online coding practice and evaluation platform that allows users to solve programming problems, submit code solutions, and receive automated feedback. The system executes user-submitted code in a secure sandbox environment and validates outputs against test cases.

## Requirements

### Functional Requirements

- **Problem database**: CRUD operations for coding problems with descriptions, examples, constraints, and test cases
- **Code execution**: Run user-submitted code in isolated sandboxes with resource limits (Python, JavaScript)
- **Test case validation**: Compare program output against expected results with tolerance for formatting differences
- **User progress tracking**: Track solved problems, attempts, best runtime per user
- **Leaderboards**: Display user rankings by problems solved and performance metrics
- **Admin interface**: Problem management, user administration, system monitoring

### Non-Functional Requirements

- **Scalability**: Support 10-50 concurrent users for local development; design patterns support horizontal scaling
- **Availability**: 99% uptime target (acceptable for learning project); ~7 hours downtime/month
- **Latency**:
  - API responses: p95 < 200ms for reads, p95 < 500ms for writes
  - Code execution: p95 < 5 seconds for simple problems, p95 < 15 seconds for complex problems
- **Consistency**: Strong consistency for submissions and user progress; eventual consistency acceptable for leaderboards and statistics

## Capacity Estimation

*Sized for local development with production-like patterns:*

### Traffic Estimates

| Metric | Local Dev Target | Production Equivalent |
|--------|-----------------|----------------------|
| Daily Active Users (DAU) | 5-10 | 10,000-50,000 |
| Submissions per user/day | 10-20 | 5-10 |
| Peak submissions/second | 2-3 | 100-500 |
| Problem views/second | 5-10 | 1,000-5,000 |
| Code runs (test only)/second | 3-5 | 200-1,000 |

### Storage Estimates

| Data Type | Size Per Item | Count (Local) | Total (Local) | Growth Rate |
|-----------|--------------|---------------|---------------|-------------|
| Problems | ~10 KB (description + code) | 100 | 1 MB | +5/week |
| Test cases | ~500 B per case | 500 (5 per problem) | 250 KB | +25/week |
| Submissions | ~5 KB (code + metadata) | 10,000 | 50 MB | +100/day |
| Users | ~500 B | 50 | 25 KB | +1/day |
| User progress | ~100 B per problem | 5,000 | 500 KB | +50/day |

**Total storage (6 months)**: ~500 MB PostgreSQL, ~50 MB Redis cache

### Resource Limits

| Resource | Limit | Rationale |
|----------|-------|-----------|
| Code execution memory | 256 MB per container | Sufficient for algorithm problems |
| Code execution time | 2-10 seconds | Prevents infinite loops |
| Code file size | 1 MB | Prevents abuse |
| Container CPU | 50% of 1 core | Fair sharing |
| Concurrent executions | 5 per instance | Memory-bound on 8GB dev machine |

## High-Level Architecture

```
                                    +-----------------+
                                    |   Frontend      |
                                    |   (React SPA)   |
                                    +--------+--------+
                                             |
                                             | HTTP/HTTPS
                                             v
+------------------+              +----------+----------+
|   Redis          |<------------>|    API Server       |
|   - Sessions     |              |    (Express.js)     |
|   - Cache        |              +----------+----------+
|   - Status poll  |                         |
+------------------+                         |
                                            / \
                               +-----------+   +-----------+
                               |                           |
                               v                           v
                    +----------+----------+     +----------+----------+
                    |     PostgreSQL      |     |   Code Executor     |
                    |   - Problems        |     |   (Docker Sandbox)  |
                    |   - Users           |     |   - python:3.11     |
                    |   - Submissions     |     |   - node:20         |
                    |   - Progress        |     +---------------------+
                    +---------------------+
```

### Request Flow: Code Submission

```
1. User submits code via POST /api/v1/submissions
   |
2. API validates request, creates submission record (status: pending)
   |
3. API returns 202 Accepted with submission ID immediately
   |
4. Background process starts:
   |
   +---> Update status to "running" in PostgreSQL + Redis cache
   |
   +---> For each test case:
   |       |
   |       +---> Write code to temp file
   |       +---> Spawn Docker container with security restrictions
   |       +---> Pipe input, collect output with timeout
   |       +---> Compare output to expected (with normalization)
   |       +---> Update progress in Redis cache
   |
   +---> Update final status in PostgreSQL
   |
   +---> Update user_problem_status if accepted
   |
5. Frontend polls GET /api/v1/submissions/:id/status every 1-2 seconds
   |
6. Redis cache returns current progress until complete
```

### Core Components

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| **API Server** | Express.js (Node.js) | HTTP routing, session management, business logic |
| **Database** | PostgreSQL 16 | Persistent storage for all entities |
| **Cache** | Redis 7 | Session store, submission status cache, problem cache |
| **Code Executor** | Docker + dockerode | Secure code execution in isolated containers |
| **Frontend** | React + TypeScript | User interface, code editor, results display |

## Data Model

### Database Schema

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
  slug VARCHAR(100) UNIQUE NOT NULL,          -- URL-friendly identifier
  description TEXT NOT NULL,                   -- Markdown content
  examples TEXT,                               -- Input/output examples
  constraints TEXT,                            -- Problem constraints
  difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  time_limit_ms INTEGER DEFAULT 2000,          -- Per test case
  memory_limit_mb INTEGER DEFAULT 256,
  starter_code_python TEXT,
  starter_code_javascript TEXT,
  solution_python TEXT,                        -- Reference solution (admin only)
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
  is_sample BOOLEAN DEFAULT FALSE,             -- Show to users or hidden
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

### Storage Strategy

| Data | Storage | TTL/Retention | Rationale |
|------|---------|---------------|-----------|
| Problems | PostgreSQL | Permanent | Core content, rarely changes |
| Problem cache | Redis | 5 minutes | Reduce DB load for reads |
| User sessions | Redis | 7 days | Standard session duration |
| Submission status | Redis | 5 minutes | Fast polling during execution |
| Submissions | PostgreSQL | 1 year | Historical record, can archive older |
| User progress | PostgreSQL | Permanent | Core user data |

### Caching Strategy

**Cache-aside pattern** for problem data:
1. Check Redis for `problem:{slug}`
2. On miss, query PostgreSQL, store in Redis with 5-minute TTL
3. On problem update/delete, invalidate cache key

**Write-through for submission status**:
1. Write status to Redis immediately on change
2. Write to PostgreSQL for persistence
3. Frontend polls Redis for low-latency updates

**Cache key patterns**:
```
session:{sessionId}           -> User session data (7 day TTL)
problem:{slug}                -> Problem JSON (5 min TTL)
submission:{id}:status        -> Submission progress JSON (5 min TTL)
```

## API Design

### Core Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| **Auth** |
| POST | `/api/v1/auth/register` | None | Create new user account |
| POST | `/api/v1/auth/login` | None | Login, create session |
| POST | `/api/v1/auth/logout` | User | Destroy session |
| GET | `/api/v1/auth/me` | User | Get current user info |
| **Problems** |
| GET | `/api/v1/problems` | None | List problems (paginated, filterable) |
| GET | `/api/v1/problems/:slug` | None | Get problem details + sample test cases |
| GET | `/api/v1/problems/:slug/submissions` | User | Get user's submissions for problem |
| POST | `/api/v1/problems` | Admin | Create new problem |
| **Submissions** |
| POST | `/api/v1/submissions` | User | Submit code for judging |
| POST | `/api/v1/submissions/run` | User | Run code against sample tests only |
| GET | `/api/v1/submissions/:id` | User | Get submission details |
| GET | `/api/v1/submissions/:id/status` | User | Poll submission status (cached) |
| **Users** |
| GET | `/api/v1/users/progress` | User | Get user's solve progress |
| **Admin** |
| GET | `/api/v1/admin/stats` | Admin | System statistics |
| GET | `/api/v1/admin/users` | Admin | List all users |

### Request/Response Examples

**Submit code:**
```http
POST /api/v1/submissions
Content-Type: application/json
Cookie: connect.sid=...

{
  "problemSlug": "two-sum",
  "language": "python",
  "code": "def twoSum(nums, target):\n    ..."
}

Response (202 Accepted):
{
  "submissionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "message": "Submission received, processing..."
}
```

**Poll status:**
```http
GET /api/v1/submissions/550e8400-e29b-41d4-a716-446655440000/status

Response:
{
  "status": "running",
  "test_cases_passed": 3,
  "test_cases_total": 10,
  "current_test": 4
}
```

## Key Design Decisions

### Sandboxed Code Execution

**Problem**: Execute untrusted user code safely without allowing system access or resource abuse.

**Solution**: Docker containers with strict security restrictions:

```javascript
// Container configuration
{
  HostConfig: {
    Binds: [`${workDir}:/code:ro`],           // Read-only code mount
    Memory: 256 * 1024 * 1024,                 // 256MB memory limit
    MemorySwap: 256 * 1024 * 1024,             // No swap
    CpuPeriod: 100000,
    CpuQuota: 50000,                           // 50% of one CPU
    PidsLimit: 50,                             // Max 50 processes
    NetworkMode: 'none',                       // No network access
    SecurityOpt: ['no-new-privileges'],        // No privilege escalation
    CapDrop: ['ALL'],                          // Drop all Linux capabilities
    AutoRemove: true                           // Clean up on exit
  }
}
```

**Defense in depth layers**:
1. **Network isolation**: `NetworkMode: 'none'` prevents all network access
2. **Filesystem isolation**: Read-only mount, no access to host filesystem
3. **Resource limits**: Memory, CPU, process count caps
4. **Privilege dropping**: No capabilities, no privilege escalation
5. **Timeout enforcement**: Hard kill after time limit
6. **Cleanup**: Container auto-removed after execution

**Trade-off**: Docker adds ~100-200ms overhead per execution vs. raw process spawning, but provides much stronger isolation than process-level sandboxing.

### Polling vs. WebSocket for Status Updates

**Choice**: HTTP polling with Redis-cached status

**Rationale**:
- Simpler implementation for learning project
- Submission execution is seconds, not hours (polling overhead acceptable)
- Redis caching makes polling nearly free (sub-millisecond responses)
- Easy to upgrade to WebSocket later if needed

**Implementation**: Frontend polls every 1-2 seconds, Redis returns cached status with < 1ms latency.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 18 + TypeScript + Vite | Fast dev experience, type safety |
| **Code Editor** | CodeMirror 6 | Syntax highlighting, language modes |
| **Styling** | Tailwind CSS | Rapid UI development |
| **API Server** | Express.js (Node.js) | Simple, well-documented, async-friendly |
| **Database** | PostgreSQL 16 | ACID compliance, JSON support, mature |
| **Cache** | Redis 7 | Session store, fast status polling |
| **Code Execution** | Docker + dockerode | Secure isolation, language flexibility |
| **Container Images** | python:3.11-alpine, node:20-alpine | Small footprint, quick startup |

## Security Considerations

### Authentication and Authorization

**Session-based auth with Redis store**:
```javascript
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
    httpOnly: true,                                  // No JS access
    maxAge: 1000 * 60 * 60 * 24 * 7                 // 7 days
  }
}));
```

**Role-based access control (RBAC)**:
| Role | Permissions |
|------|-------------|
| Anonymous | View problems, view leaderboard |
| User | Submit code, run tests, view own submissions, track progress |
| Admin | All user permissions + create/edit problems, view all users, system stats |

**Middleware implementation**:
```javascript
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

const requireAdmin = async (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const user = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
  if (user.rows[0]?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
```

### Input Validation

- **Code size limit**: 1 MB max via `express.json({ limit: '1mb' })`
- **Language whitelist**: Only `python` and `javascript` accepted
- **Slug validation**: Alphanumeric + hyphens only
- **SQL injection prevention**: Parameterized queries throughout

### Rate Limiting (Future Enhancement)

*Not currently implemented, but recommended for production:*
```javascript
// Per-user rate limits
const rateLimits = {
  submissions: { window: '1m', max: 10 },      // 10 submissions/minute
  codeRuns: { window: '1m', max: 30 },         // 30 test runs/minute
  apiGeneral: { window: '1m', max: 100 }       // 100 API calls/minute
};
```

## Observability

### Metrics to Track

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

### Logging Strategy

**Log levels**:
- `ERROR`: System errors, failed submissions due to infrastructure
- `WARN`: Rate limit hits, slow queries (> 1s), container timeouts
- `INFO`: Submissions, logins, problem creates
- `DEBUG`: Request details, query timing (dev only)

**Log format** (structured JSON for production):
```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "INFO",
  "message": "Submission completed",
  "submissionId": "550e8400-...",
  "userId": "user-uuid",
  "problemSlug": "two-sum",
  "status": "accepted",
  "durationMs": 1234
}
```

### Health Check Endpoint

```javascript
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');        // Check PostgreSQL
    await redis.ping();                   // Check Redis
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'error', message: error.message });
  }
});
```

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Database queries | 3 | Exponential (100ms, 200ms, 400ms) | Safe for reads; writes use transactions |
| Redis operations | 2 | Fixed 50ms | Safe (all operations idempotent) |
| Docker container spawn | 2 | Fixed 500ms | Submission ID ensures single execution |
| Image pull | 1 | N/A | Cached locally after first pull |

### Circuit Breaker Pattern (Future Enhancement)

*Recommended for production code execution:*
```javascript
const circuitBreaker = {
  state: 'closed',           // closed, open, half-open
  failureCount: 0,
  failureThreshold: 5,       // Open after 5 consecutive failures
  resetTimeout: 30000,       // Try again after 30s

  async execute(fn) {
    if (this.state === 'open') {
      throw new Error('Circuit breaker open - code execution temporarily unavailable');
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
};
```

### Graceful Degradation

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Redis down | Sessions lost, slower status polling | Fall back to PostgreSQL for status |
| PostgreSQL slow | API latency increases | Return cached data where available |
| Docker unavailable | Submissions fail | Return `system_error`, notify admin |
| Container timeout | Single submission fails | Return `time_limit_exceeded` |
| Container OOM | Single submission fails | Return `memory_limit_exceeded` |

### Disaster Recovery (Local Dev Context)

**Backup strategy**:
- PostgreSQL: `pg_dump` daily to local backup folder
- Redis: AOF persistence enabled (`appendonly yes`)
- Code/problems: Git repository (already versioned)

**Recovery procedure**:
1. Restore PostgreSQL from dump: `psql < backup.sql`
2. Redis rebuilds from AOF on restart
3. Re-seed problems if needed: `npm run db:seed`

## Scalability Considerations

### Horizontal Scaling Path

**Current (single instance)**:
```
Browser --> API Server --> PostgreSQL
                |
                +--> Redis
                +--> Docker (local)
```

**Scaled (multiple instances)**:
```
Browser --> Load Balancer --> API Server 1 --> PostgreSQL (primary)
                          --> API Server 2         |
                          --> API Server 3     Read replicas
                                  |
                                  +--> Redis Cluster
                                  +--> Execution Workers (separate hosts)
```

### Bottleneck Analysis

| Component | Bottleneck | Solution |
|-----------|------------|----------|
| API Server | CPU-bound request handling | Add instances behind load balancer |
| PostgreSQL | Connection limits, write throughput | Read replicas, connection pooling |
| Redis | Single-threaded, memory-bound | Redis Cluster for sharding |
| Code Execution | Memory per container (256MB x N) | Dedicated execution workers |

### Queue-Based Execution (Future Enhancement)

*For production scale, decouple submission handling from execution:*

```
API Server --> RabbitMQ --> Execution Worker 1
                        --> Execution Worker 2
                        --> Execution Worker N
                                   |
                                   v
                              Redis (status updates)
```

Benefits:
- Backpressure handling (queue depth monitoring)
- Independent scaling of API vs. execution
- Retry semantics for failed executions
- Priority queues for premium users

## Trade-offs and Alternatives

### Code Execution Approaches

| Approach | Pros | Cons | Chosen |
|----------|------|------|--------|
| **Docker containers** | Strong isolation, mature tooling | ~200ms overhead | Yes |
| gVisor | Kernel-level isolation | Complex setup, compatibility issues | No |
| Firecracker | VM-level isolation, fast boot | AWS-specific, overkill for local | No |
| Process sandboxing (seccomp) | Low overhead | Weaker isolation, complex rules | No |

### Database Options

| Option | Pros | Cons | Chosen |
|--------|------|------|--------|
| **PostgreSQL** | ACID, JSON support, mature | Requires setup | Yes |
| SQLite | Zero setup, embedded | No concurrent writes | No |
| MongoDB | Flexible schema | Overkill for structured data | No |

### Real-time Updates

| Option | Pros | Cons | Chosen |
|--------|------|------|--------|
| **HTTP Polling + Redis** | Simple, stateless, cacheable | Slight latency (1-2s) | Yes |
| WebSocket | True real-time | Connection management overhead | No |
| Server-Sent Events | Simpler than WebSocket | Less browser support | No |

## Cost Tradeoffs (Local Development)

| Resource | Recommendation | Rationale |
|----------|---------------|-----------|
| **Docker images** | Alpine variants (50-100MB) | Faster pulls, less disk |
| **Container memory** | 256MB limit | Balance between capability and concurrency |
| **Redis memory** | 50MB max | Sessions + cache fit easily |
| **PostgreSQL** | Default config | Sufficient for dev workloads |
| **Concurrent executions** | Max 5 | 5 x 256MB = 1.25GB, safe for 8GB dev machine |

## Future Optimizations

1. **Worker pool for execution**: Pre-warmed containers reduce cold start
2. **WebSocket for live updates**: Reduce polling overhead
3. **Code similarity detection**: Hash-based plagiarism detection
4. **Additional languages**: C++, Java, Go, Rust with language-specific images
5. **Contest mode**: Time-limited competitions with leaderboards
6. **Code analysis**: Runtime complexity estimation, style linting
7. **Caching compiled code**: For languages with compilation step
8. **CDN for static assets**: Faster frontend loading
