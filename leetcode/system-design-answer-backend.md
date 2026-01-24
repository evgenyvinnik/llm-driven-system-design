# LeetCode (Online Judge) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 🎯 Problem Statement

Design the backend infrastructure for an online coding practice and evaluation platform that allows users to:
- Browse and solve coding problems
- Submit code in multiple programming languages
- Execute user code securely in sandboxed environments
- Validate outputs against test cases with resource limits
- Track progress and maintain leaderboards

---

## 📋 Requirements Clarification

### Functional Requirements

1. **Problem Management**: CRUD operations for coding problems with descriptions, test cases, constraints
2. **Code Submission**: Accept code in multiple languages (Python, JavaScript, Java, C++)
3. **Sandboxed Execution**: Run untrusted code safely with resource limits
4. **Test Validation**: Compare outputs against expected results with tolerance for formatting
5. **User Progress**: Track solved problems, attempts, best runtime per user
6. **Leaderboards**: Rankings by problems solved and performance metrics

### Non-Functional Requirements

1. **Security**: Sandboxed execution preventing system access, network calls, resource exhaustion
2. **Latency**: Results within 5 seconds for simple problems, 15 seconds for complex
3. **Fairness**: Consistent evaluation across all users and submissions
4. **Scale**: Support 100K concurrent users, 10K submissions/minute during contests

### Scale Estimates

- 10 million registered users
- 500K daily active users
- Normal: 1M submissions/day = 12/second
- Contest peak: 10K submissions/minute = 170/second
- Average execution time: 2 seconds
- Concurrent executions needed at peak: ~340

---

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Load Balancer (nginx)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │ API Server  │ │ API Server  │ │ API Server  │
            │   (Node)    │ │   (Node)    │ │   (Node)    │
            └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                   │               │               │
                   └───────────────┼───────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
    │  PostgreSQL  │      │    Kafka     │      │    Valkey    │
    │  (Primary)   │      │  (Submission │      │   (Cache +   │
    │              │      │    Queue)    │      │   Sessions)  │
    └──────────────┘      └──────┬───────┘      └──────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           ▼                     ▼                     ▼
    ┌─────────────┐      ┌─────────────┐       ┌─────────────┐
    │ Judge Worker│      │ Judge Worker│       │ Judge Worker│
    │  (Python)   │      │   (Java)    │       │   (C++)     │
    │ ┌─────────┐ │      │ ┌─────────┐ │       │ ┌─────────┐ │
    │ │ gVisor  │ │      │ │ gVisor  │ │       │ │ gVisor  │ │
    │ │ Sandbox │ │      │ │ Sandbox │ │       │ │ Sandbox │ │
    │ └─────────┘ │      │ └─────────┘ │       │ └─────────┘ │
    └─────────────┘      └─────────────┘       └─────────────┘
```

---

## 🔒 Deep Dive: Sandboxed Code Execution

### Security Requirements

User code is untrusted. We must prevent:
1. **System access**: Reading files, executing commands
2. **Network access**: Making external requests
3. **Resource exhaustion**: Infinite loops, memory bombs
4. **Process escape**: Breaking out of sandbox

### Sandbox Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Host Machine                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Container Runtime (gVisor)                   │ │
│  │                                                                 │ │
│  │  ┌──────────────────────────────────────────────────────────┐  │ │
│  │  │                 Sandbox Container                         │  │ │
│  │  │                                                           │  │ │
│  │  │  ┌─────────────────────────────────────────────────────┐  │  │ │
│  │  │  │              User Process                           │  │  │ │
│  │  │  │                                                     │  │  │ │
│  │  │  │  - No network access                                │  │  │ │
│  │  │  │  - Read-only filesystem                             │  │  │ │
│  │  │  │  - No fork/exec beyond limits                       │  │  │ │
│  │  │  │  - Memory limit: 256MB                              │  │  │ │
│  │  │  │  - CPU limit: 2 seconds                             │  │  │ │
│  │  │  │  - No /proc, /sys access                            │  │  │ │
│  │  │  └─────────────────────────────────────────────────────┘  │  │ │
│  │  │                                                           │  │ │
│  │  │  Seccomp: Whitelist of allowed syscalls                   │  │ │
│  │  │  AppArmor: Mandatory access control                       │  │ │
│  │  └──────────────────────────────────────────────────────────┘  │ │
│  │                                                                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  cgroups: Resource limits enforced at kernel level                   │
└──────────────────────────────────────────────────────────────────────┘
```

### Trade-off 1: gVisor vs Docker vs Firecracker

| Approach | Pros | Cons |
|----------|------|------|
| ✅ gVisor | Strong isolation, syscall filtering, user-space kernel | 10-20% performance overhead |
| ❌ Docker alone | Simple, fast startup, wide tooling support | Shared kernel, escape vulnerabilities |
| ❌ Firecracker | VM-level isolation, used by AWS Lambda | 125MB memory per VM, 150ms cold start |

> "I chose gVisor over plain Docker or Firecracker for code execution sandboxing. Docker containers share the host kernel, so a kernel exploit could escape the sandbox—this happened with CVE-2019-5736 where a malicious container could overwrite the host runc binary. For an online judge running arbitrary user code, kernel-level vulnerabilities are unacceptable. Firecracker provides true VM isolation but adds 125MB memory overhead per microVM and 150ms cold start—with 340 concurrent executions at peak, that's 42GB just for VM overhead, plus we'd need to pre-warm VMs extensively to hide latency. gVisor runs a user-space kernel (called Sentry) that intercepts syscalls and reimplements them safely. A kernel exploit in user code can only compromise Sentry, not the host. The trade-off is 10-20% execution slowdown, but since we control the time limits, we adjust multipliers per language to compensate. For the specific threat model of untrusted code execution, gVisor's syscall-level isolation is the right balance of security and performance."

### Security Configuration Layers

| Layer | Configuration | Purpose |
|-------|---------------|---------|
| Network | network_mode: none | Block all external requests |
| Filesystem | read_only: true | Prevent persistent changes |
| Capabilities | cap_drop: ALL | No privilege escalation |
| Memory | mem_limit: 256m | Prevent memory bombs |
| CPU | cpus: 0.5 | Limit compute usage |
| Processes | pids_limit: 50 | Prevent fork bombs |
| Privileges | no-new-privileges: true | Block privilege escalation |
| Seccomp | custom profile | Whitelist allowed syscalls |

---

## 🔧 Deep Dive: Test Execution Strategy

### Trade-off 2: Sequential vs Parallel Test Execution

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Sequential | Fair timing, predictable resources, early termination | Slower total time |
| ❌ Parallel | Faster completion, better throughput | Resource contention, unfair timing, no early exit |

> "I chose sequential test case execution over parallel execution, and this is a critical fairness decision. If we run 50 test cases in parallel, they compete for CPU and memory—a solution's measured runtime depends on what other test cases are doing simultaneously, introducing non-determinism. User A's submission might report 45ms while User B's identical code reports 62ms due to resource contention. For a platform where users compare runtimes and compete on leaderboards, this inconsistency destroys trust. Sequential execution ensures each test case runs in isolation with dedicated resources, producing reproducible timing. The trade-off is speed: 50 test cases at 100ms each take 5 seconds sequentially vs ~200ms parallel. But correctness and fairness trump speed—users would rather wait 5 seconds for accurate results than get instant but unreliable measurements. Sequential also enables early termination: when a test fails, we stop immediately rather than wasting resources on remaining tests. For 'Wrong Answer' submissions (70% of failures), we often stop at test case 3 instead of running all 50."

### Test Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                  Sequential Test Execution                       │
│                                                                  │
│  Test 1 ──▶ Run ──▶ Compare ──▶ PASS ──▶ Continue               │
│                                    │                             │
│  Test 2 ──▶ Run ──▶ Compare ──▶ PASS ──▶ Continue               │
│                                    │                             │
│  Test 3 ──▶ Run ──▶ Compare ──▶ FAIL ──▶ STOP (early exit)      │
│                                    │                             │
│  Tests 4-50: Not executed (saved resources)                      │
│                                                                  │
│  Result: Wrong Answer on test 3 of 50                            │
└─────────────────────────────────────────────────────────────────┘
```

### Trade-off 3: Early Termination vs Run All Tests

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Early termination (default) | Fast feedback, saves resources | Less debugging info |
| ❌ Run all tests | Shows all failures | Wastes resources, slower |

> "I chose early termination as the default, stopping execution on first failure. Most failed submissions fail early—test case 1 catches syntax errors, test cases 2-5 catch basic logic bugs. Running all 50 tests for a submission that fails on test 3 wastes 47 test executions worth of resources. At 170 submissions/second during contests, this adds up quickly. Early termination also provides faster feedback: users see 'Wrong Answer on test 3' in 300ms instead of waiting 5 seconds for all tests. The trade-off is reduced debugging information—users don't know if their fix for test 3 will break test 47. We mitigate this with a 'Run All Tests' option for debugging, but charge it against a daily quota since it's resource-intensive. The default optimizes for the common case: fix one bug at a time, resubmit, iterate."

---

## 🔧 Deep Dive: Worker Architecture

### Trade-off 4: Per-Language Workers vs Generic Workers

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Per-language workers | Optimized containers, independent scaling, tuned limits | More infrastructure |
| ❌ Generic workers | Simpler ops, better utilization, fewer images | Cold starts, bloated containers |

> "I chose per-language worker pools over generic workers that handle all languages. A generic worker would need Python, Java, Node.js, GCC, Go, and Rust all installed—creating a 2GB+ container image with long pull times and security surface area from unused runtimes. Per-language workers use minimal images: Python worker is 150MB, C++ worker is 200MB. This also enables language-specific tuning: Java workers get 512MB memory for JVM heap while Python gets 256MB. Most importantly, per-language pools enable independent scaling. Python represents 70% of submissions, so we run 5 Python workers vs 3 for other languages. During a contest with mostly Python submissions, we scale Python workers without wasting resources on idle Java workers. The trade-off is operational complexity—we manage 6 worker deployments instead of 1—but Kubernetes makes this manageable, and the resource efficiency and cold-start improvements justify the complexity."

### Worker Pool Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Per-Language Worker Pools                    │
│                                                                  │
│  Kafka Topic: submissions.python                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Python Workers (5)                                          ││
│  │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                    ││
│  │  │ W1  │ │ W2  │ │ W3  │ │ W4  │ │ W5  │   Image: 150MB     ││
│  │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘   Memory: 256MB    ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Kafka Topic: submissions.java                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Java Workers (3)                                            ││
│  │  ┌─────┐ ┌─────┐ ┌─────┐                                     ││
│  │  │ W1  │ │ W2  │ │ W3  │               Image: 300MB          ││
│  │  └─────┘ └─────┘ └─────┘               Memory: 512MB (JVM)   ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Scaling: Workers scale independently based on queue depth       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Deep Dive: Queue-Based Processing

### Trade-off 5: Kafka vs RabbitMQ vs Redis Streams

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Kafka | Log retention, replay, consumer groups, high throughput | Operational complexity, higher latency |
| ❌ RabbitMQ | Lower latency, flexible routing, simpler ops | No replay, message loss on crash without confirms |
| ❌ Redis Streams | Simple, already have Redis, low latency | Limited durability, single-node bottleneck |

> "I chose Kafka over RabbitMQ or Redis Streams for submission queuing. The critical requirement is durability: a submission must never be lost, especially during rated contests where losing someone's accepted solution would be catastrophic. RabbitMQ can achieve durability with publisher confirms, persistent messages, and mirrored queues—but this configuration adds latency and complexity, and replay after a bug fix requires external tooling. Kafka's log-based architecture provides replay by default: if we discover our judge had a bug last week, we can reprocess all affected submissions from the log. Redis Streams would work for simple cases but lacks the partitioning and consumer group semantics needed for per-language worker pools. The trade-off is operational complexity: Kafka requires ZooKeeper (or KRaft), careful partition configuration, and more monitoring. But for a system where 'your submission was lost' is unacceptable, Kafka's durability guarantees are worth the operational investment. The per-language topics (submissions.python, submissions.java) enable independent scaling and prevent a Java backlog from blocking Python submissions."

### Message Flow

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  API Server  │      │    Kafka     │      │   Worker     │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │
       │  1. Create DB record (status: pending)    │
       │────────────────────────────────────────────────────▶
       │                     │                     │
       │  2. Publish message │                     │
       │────────────────────▶│                     │
       │                     │                     │
       │  3. Return 202 + ID │                     │
       │◀────────────────────│                     │
       │                     │                     │
       │                     │  4. Consume         │
       │                     │────────────────────▶│
       │                     │                     │
       │                     │  5. Execute tests   │
       │                     │  6. Update Valkey   │
       │                     │  7. Commit offset   │
       │                     │◀────────────────────│
       │                     │                     │
       │                     │  8. Update DB       │
       │                     │────────────────────▶│
       ▼                     ▼                     ▼
```

---

## 🔧 Deep Dive: Output Comparison

### Trade-off 6: Strict vs Tolerant Output Matching

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Tolerant (whitespace-normalized) | Fewer false negatives, better UX | Slightly more complex |
| ❌ Strict byte-for-byte | Simple implementation | Fails on trailing newlines, Windows line endings |
| ❌ Custom judger per problem | Handles any format | High maintenance, security risk |

> "I chose tolerant output matching with whitespace normalization over strict byte comparison. Strict matching rejects correct solutions due to trivial formatting differences: trailing newlines, Windows line endings (CRLF vs LF), trailing spaces on lines. Users submit 'Hello World\n' and get 'Wrong Answer' because expected output is 'Hello World'—this is frustrating and wastes support time. Our tolerant comparison normalizes both outputs: trim leading/trailing whitespace, convert CRLF to LF, remove trailing spaces per line, then compare. For floating-point problems, we accept relative error within 1e-6. The trade-off is that strictly-formatted problems (where whitespace matters) need explicit handling, and our comparison logic is more complex than strcmp(). For problems with multiple valid answers (like 'print any valid path'), we'd need custom judgers—but these are rare (<5% of problems) and we implement them as trusted server-side code, not user-submitted. The default tolerant matching handles 95% of problems correctly while dramatically reducing false rejections."

### Output Comparison Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    Output Comparison Pipeline                    │
│                                                                  │
│  User Output                    Expected Output                  │
│  "42\n"                         "42"                             │
│      │                              │                            │
│      ▼                              ▼                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  1. Trim leading/trailing whitespace                         ││
│  │  2. Normalize line endings (CRLF → LF)                       ││
│  │  3. Remove trailing spaces per line                          ││
│  │  4. Handle floating point (if numeric, 1e-6 tolerance)       ││
│  └─────────────────────────────────────────────────────────────┘│
│      │                              │                            │
│      ▼                              ▼                            │
│  "42"                           "42"                             │
│      │                              │                            │
│      └──────────────┬───────────────┘                            │
│                     ▼                                            │
│              Compare: MATCH ✓                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 💾 Data Model

### PostgreSQL Schema

**Problems Table**
- id (UUID, PK), title, slug (unique), description (TEXT)
- difficulty ('easy'/'medium'/'hard')
- time_limit_ms (default 2000), memory_limit_mb (default 256)
- created_at, updated_at

**Test Cases Table**
- id (UUID, PK), problem_id (FK → problems, CASCADE DELETE)
- input (TEXT), expected_output (TEXT)
- is_sample (boolean, default false)
- order_index (integer)

**Submissions Table**
- id (UUID, PK), user_id (FK), problem_id (FK), contest_id (FK, nullable)
- language, code (TEXT), status (default 'pending')
- runtime_ms, memory_kb
- test_cases_passed, test_cases_total
- error_message (TEXT), created_at

**User Progress Table**
- user_id + problem_id (composite PK)
- status ('solved'/'attempted'/'unsolved')
- best_runtime_ms, best_memory_kb
- attempts (default 0), solved_at

### Why PostgreSQL?

| Consideration | PostgreSQL | MongoDB | Cassandra |
|---------------|------------|---------|-----------|
| ACID transactions | ✅ Full support | ⚠️ Multi-doc overhead | ❌ No transactions |
| Complex queries | ✅ Full SQL | ⚠️ Aggregation pipeline | ❌ Limited |
| Joins | ✅ Native | ⚠️ $lookup (slow) | ❌ None |
| Horizontal scale | ⚠️ Manual sharding | ✅ Built-in | ✅ Linear |

> "PostgreSQL wins because submission processing requires ACID: updating submission status and user progress must succeed or fail together. At 12 writes/second (normal load), a single PostgreSQL instance handles this trivially. When we need to scale, we shard by user_id—each user's data stays on one shard, preserving transaction guarantees."

---

## 🚀 Caching Strategy

### Valkey Cache Layers

```
┌──────────────────────────────────────────────────────────┐
│                      Valkey Cache                         │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  problem:{slug}           ──▶ Problem JSON (5 min)  │ │
│  │  problem:{slug}:tests     ──▶ Test cases (5 min)    │ │
│  │  submission:{id}:status   ──▶ Status JSON (5 min)   │ │
│  │  user:{id}:progress       ──▶ Progress JSON (1 min) │ │
│  │  leaderboard:global       ──▶ Top 100 users (1 min) │ │
│  │  session:{sid}            ──▶ Session data (7 days) │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

> "Caching submission status in Valkey is critical for polling performance. With 10K concurrent users polling every second, that's 10K reads/second. Database queries at this rate would overwhelm PostgreSQL. Valkey handles 100K+ reads/second. Workers update status after each test case, enabling real-time progress display."

---

## 🌐 API Design

### RESTful Endpoints

```
POST   /api/v1/submissions       ──▶ Submit (returns 202 + ID)
GET    /api/v1/submissions/:id/status ──▶ Poll status (cached)
POST   /api/v1/submissions/run   ──▶ Run samples only (no record)

GET    /api/v1/problems          ──▶ List (paginated, filterable)
GET    /api/v1/problems/:slug    ──▶ Get details + sample tests

GET    /api/v1/users/progress    ──▶ Get solve progress
```

---

## 📊 Deep Dive: Capacity Planning

### Traffic Analysis

```
┌─────────────────────────────────────────────────────────────────┐
│                      Request Distribution                        │
│                                                                  │
│  Normal Day (500K DAU):                                          │
│  ├── Status polling:     10K users × 1 req/s = 10,000 QPS       │
│  ├── Problem list/view:  5K users × 0.1 req/s = 500 QPS         │
│  ├── Submissions:        1M/day ÷ 86400 = 12 QPS                │
│  └── Total API load:     ~11,000 QPS                            │
│                                                                  │
│  Contest Peak (100K concurrent):                                 │
│  ├── Status polling:     50K users × 1 req/s = 50,000 QPS       │
│  ├── Problem view:       10K users × 0.2 req/s = 2,000 QPS      │
│  ├── Submissions:        10K/min ÷ 60 = 170 QPS                 │
│  └── Total API load:     ~52,000 QPS                            │
└─────────────────────────────────────────────────────────────────┘
```

### Server Sizing Calculations

**API Servers (Node.js + Express)**

| Metric | Value | Calculation |
|--------|-------|-------------|
| Single server capacity | 5,000 QPS | Cached reads, simple routing |
| Normal load | 11,000 QPS | Requires 3 servers (2.2x headroom) |
| Contest peak | 52,000 QPS | Requires 11 servers |
| Recommended minimum | 4 servers | 3 active + 1 spare for deployments |
| Auto-scale ceiling | 15 servers | Handle unexpected spikes |

> "I size API servers for the 95th percentile of normal traffic with 2x headroom, then auto-scale for contests. Each Node.js server handles 5K QPS for cached endpoints (status polling hits Valkey, not DB). The key insight is that 90%+ of requests are status polls—simple Valkey lookups returning in <1ms. We run 4 servers normally (one can fail or deploy while 3 handle load) and scale to 12-15 during contests."

**Judge Workers**

```
┌─────────────────────────────────────────────────────────────────┐
│                    Worker Capacity Model                         │
│                                                                  │
│  Submission rate (peak): 170/second                              │
│  Average execution time: 2 seconds (including all test cases)   │
│  Concurrent executions needed: 170 × 2 = 340                     │
│                                                                  │
│  Per-worker capacity: 1 concurrent execution (safety)            │
│  Workers needed at peak: 340 + 20% buffer = 408                  │
│                                                                  │
│  Distribution by language (based on submission mix):             │
│  ├── Python (70%):     286 workers                               │
│  ├── JavaScript (15%): 61 workers                                │
│  ├── Java (8%):        33 workers                                │
│  ├── C++ (5%):         20 workers                                │
│  └── Other (2%):       8 workers                                 │
│                                                                  │
│  Normal operation (12 submissions/sec):                          │
│  ├── Python: 17 workers                                          │
│  ├── JavaScript: 4 workers                                       │
│  ├── Java: 2 workers                                             │
│  ├── C++: 2 workers (minimum for availability)                   │
└─────────────────────────────────────────────────────────────────┘
```

### Database Sizing

**PostgreSQL**

| Component | Normal | Contest | Notes |
|-----------|--------|---------|-------|
| Write QPS | 12 | 170 | Submission inserts + progress updates |
| Read QPS | 500 | 2,000 | Problem fetches (mostly cached) |
| Connections | 50 | 200 | Pool per API server × servers |
| Storage | 500GB | +1GB/day | 1M submissions × 1KB avg |
| Instance | db.r6g.large | db.r6g.xlarge | Scale up for contests |

> "A single PostgreSQL instance handles our normal load trivially—12 writes/second is nothing. During contests, we scale vertically to handle 170 writes/second with faster storage. The real constraint is connection count: 15 API servers × 20 connections each = 300 connections. We use PgBouncer to pool connections and reduce overhead."

**Valkey (Redis-compatible)**

| Metric | Value | Rationale |
|--------|-------|-----------|
| Memory | 8GB | 100K status entries × 500 bytes + sessions |
| Read QPS | 50,000 | Status polling at peak |
| Write QPS | 170 | Worker status updates |
| Instance | cache.r6g.large | Single node sufficient |
| Replication | 1 replica | Failover for sessions |

### Infrastructure Cost Model

```
┌─────────────────────────────────────────────────────────────────┐
│                  Monthly Cost Estimate (AWS)                     │
│                                                                  │
│  API Servers:                                                    │
│  ├── Normal: 4 × c6g.large = $200/month                         │
│  ├── Contest burst: +10 × c6g.large × 10 hours = $15            │
│                                                                  │
│  Judge Workers:                                                  │
│  ├── Normal: 25 × c6g.medium = $250/month                       │
│  ├── Contest burst: +380 × c6g.medium × 3 hours = $120          │
│                                                                  │
│  Databases:                                                      │
│  ├── PostgreSQL RDS: db.r6g.large = $200/month                  │
│  ├── Valkey/ElastiCache: cache.r6g.large = $150/month           │
│                                                                  │
│  Kafka (MSK):                                                    │
│  ├── 3-broker cluster: $300/month                               │
│                                                                  │
│  Total baseline: ~$1,100/month                                   │
│  With weekly contests: ~$1,250/month                             │
└─────────────────────────────────────────────────────────────────┘
```

### Trade-off 7: Vertical vs Horizontal Scaling

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Horizontal (API) | No downtime scaling, fault tolerance | Load balancer complexity |
| ✅ Vertical (DB) | Simpler ops, no sharding | Downtime for resize, ceiling |
| ✅ Horizontal (Workers) | Independent language scaling | More coordination |

> "I use horizontal scaling for stateless components (API servers, workers) and vertical scaling for stateful ones (PostgreSQL). Horizontal API scaling is essential—we can add servers during a contest without downtime. Workers scale horizontally per language, letting us add Python capacity without touching Java. PostgreSQL scales vertically because sharding adds complexity we don't need at 170 writes/second—a single db.r6g.2xlarge handles 5,000 writes/second. The inflection point for sharding is around 10K writes/second, which we'd only hit at 10x our projected peak. Until then, vertical scaling is operationally simpler."

---

## ⚖️ Trade-offs Summary

| Decision | Choice | Trade-off |
|----------|--------|-----------|
| Sandbox | ✅ gVisor | 10-20% overhead vs kernel-level isolation |
| Test execution | ✅ Sequential | Slower vs fair, reproducible timing |
| Early termination | ✅ Stop on failure | Less debug info vs resource efficiency |
| Workers | ✅ Per-language pools | More infrastructure vs optimized scaling |
| Queue | ✅ Kafka | Complexity vs durability + replay |
| Output matching | ✅ Tolerant | Complexity vs fewer false rejections |
| Database | ✅ PostgreSQL | Manual sharding vs ACID + joins |
| Scaling | ✅ Horizontal API, Vertical DB | Ops simplicity vs infinite scale |

---

## 📝 Closing Summary

> "I've designed a backend for an online judge with seven key trade-off decisions: gVisor sandboxing for security without VM overhead, sequential test execution for fair timing, early termination for resource efficiency, per-language workers for optimized scaling, Kafka queuing for durability and replay, tolerant output matching for better user experience, and horizontal/vertical scaling split based on statefulness. The capacity model shows 4 API servers and 25 workers handle normal load at ~$1,100/month, scaling to 15 API servers and 400 workers for contest peaks. The unifying principle is that correctness and fairness trump performance—users trust our timing comparisons for leaderboards, so we sacrifice parallel execution speed for reproducible measurements."
