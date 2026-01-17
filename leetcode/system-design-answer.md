# LeetCode (Online Judge) - System Design Interview Answer

## Opening Statement

"Today I'll design an online coding practice and evaluation platform like LeetCode or HackerRank. The core challenges are executing untrusted user code safely in sandboxed environments, supporting multiple programming languages, enforcing resource limits, and scaling to handle thousands of concurrent submissions while maintaining fair and consistent evaluation."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Problem database** - Store coding problems with descriptions, test cases, solutions
2. **Code submission** - Users submit code in multiple languages
3. **Code execution** - Run user code against test cases in sandboxed environment
4. **Test case validation** - Compare output with expected results
5. **Leaderboards** - Track submissions, success rate, ranking
6. **User progress** - Track solved problems, submissions history
7. **Contests** - Time-limited competitive programming events

### Non-Functional Requirements

- **Security**: Sandboxed execution preventing malicious code
- **Resource limits**: CPU, memory, time constraints per submission
- **Fairness**: Consistent evaluation across all users
- **Scale**: 100K concurrent users, 10K submissions/minute during contests
- **Latency**: Results within 5 seconds for simple problems

### Out of Scope

- Discussion forums
- Premium subscription management
- Interview preparation features

---

## Step 2: Scale Estimation (2-3 minutes)

**User base:**
- 10 million registered users
- 500K daily active users
- Peak during contests: 100K concurrent

**Submissions:**
- Normal: 1 million submissions/day = 12 submissions/second
- Contest peak: 10K submissions/minute = 170/second
- Average code size: 2KB
- Average test cases per problem: 50

**Execution:**
- Average execution time: 2 seconds
- Languages: 15+ (Python, Java, C++, JavaScript, etc.)
- Concurrent executions needed: 170 * 2 = 340 at peak

**Storage:**
- Problems: 3,000 problems * 100KB = 300MB
- Submissions: 365M/year * 2KB = 730 GB/year
- Test cases: 3,000 * 50 * 10KB = 1.5 GB

**Key insight**: The bottleneck is execution capacity. We need to run untrusted code safely and at scale.

---

## Step 3: High-Level Architecture (10 minutes)

```
                               ┌────────────────────────────────────┐
                               │        Web/Mobile Clients          │
                               │     (Code Editor, Problem View)    │
                               └─────────────────┬──────────────────┘
                                                 │
                                                 ▼
                               ┌────────────────────────────────────┐
                               │           Load Balancer            │
                               └─────────────────┬──────────────────┘
                                                 │
           ┌─────────────────────────────────────┼─────────────────────────────────────┐
           │                                     │                                     │
 ┌─────────▼─────────┐               ┌───────────▼───────────┐               ┌────────▼────────┐
 │    Web Servers    │               │  Submission Service   │               │  Problem Service│
 │                   │               │                       │               │                 │
 │ - Static content  │               │ - Queue submissions   │               │ - CRUD problems │
 │ - User sessions   │               │ - Track status        │               │ - Test cases    │
 └───────────────────┘               └───────────┬───────────┘               └─────────────────┘
                                                 │
                                                 ▼
                               ┌────────────────────────────────────┐
                               │         Message Queue (Kafka)      │
                               │     (Submission Queue per lang)    │
                               └─────────────────┬──────────────────┘
                                                 │
           ┌─────────────────────────────────────┼─────────────────────────────────────┐
           │                                     │                                     │
 ┌─────────▼─────────┐               ┌───────────▼───────────┐               ┌────────▼────────┐
 │  Judge Worker     │               │  Judge Worker         │               │  Judge Worker   │
 │  (Python Pool)    │               │  (Java Pool)          │               │  (C++ Pool)     │
 │                   │               │                       │               │                 │
 │ ┌──────────────┐  │               │ ┌──────────────┐      │               │ ┌─────────────┐ │
 │ │  Sandbox     │  │               │ │  Sandbox     │      │               │ │  Sandbox    │ │
 │ │  Container   │  │               │ │  Container   │      │               │ │  Container  │ │
 │ └──────────────┘  │               │ └──────────────┘      │               │ └─────────────┘ │
 └───────────────────┘               └───────────────────────┘               └─────────────────┘
           │                                     │                                     │
           └─────────────────────────────────────┼─────────────────────────────────────┘
                                                 │
                               ┌─────────────────▼──────────────────┐
                               │            Result Handler          │
                               │   (Update DB, Notify, Rankings)    │
                               └────────────────────────────────────┘
                                                 │
                               ┌─────────────────▼──────────────────┐
                               │            PostgreSQL              │
                               │  (Users, Problems, Submissions)    │
                               └────────────────────────────────────┘
```

### Core Components

1. **Submission Service**
   - Receives code submissions
   - Validates and queues for execution
   - Tracks submission status

2. **Message Queue (Kafka)**
   - Buffers submissions
   - Separate topics per language
   - Handles burst traffic

3. **Judge Workers**
   - Pull submissions from queue
   - Execute code in sandboxed containers
   - Compare output with expected results

4. **Sandbox Environment**
   - Isolated execution environment
   - Resource limits (CPU, memory, time)
   - No network, no filesystem access

5. **Result Handler**
   - Processes execution results
   - Updates database
   - Triggers notifications
   - Updates leaderboards

---

## Step 4: Deep Dive - Sandboxed Code Execution (12 minutes)

This is the most critical and complex part of the system.

### Security Requirements

User code is untrusted. We must prevent:
1. **System access**: Reading files, executing commands
2. **Network access**: Making external requests
3. **Resource exhaustion**: Infinite loops, memory bombs
4. **Process escape**: Breaking out of sandbox

### Sandbox Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Host Machine                                 │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Container Runtime (gVisor)                 │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │                 Sandbox Container                       │  │  │
│  │  │                                                         │  │  │
│  │  │  ┌─────────────────────────────────────────────────┐    │  │  │
│  │  │  │              User Process                       │    │  │  │
│  │  │  │                                                 │    │  │  │
│  │  │  │  - No network                                   │    │  │  │
│  │  │  │  - Read-only filesystem                         │    │  │  │
│  │  │  │  - No fork/exec                                 │    │  │  │
│  │  │  │  - Memory limit: 256MB                          │    │  │  │
│  │  │  │  - CPU limit: 2 seconds                         │    │  │  │
│  │  │  │  - No /proc, /sys access                        │    │  │  │
│  │  │  └─────────────────────────────────────────────────┘    │  │  │
│  │  │                                                         │  │  │
│  │  │  Seccomp: Whitelist of allowed syscalls                 │  │  │
│  │  │  AppArmor/SELinux: Mandatory access control             │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  cgroups: Resource limits enforced at kernel level                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Technology Choices

**Option 1: Docker with restrictions**
```yaml
# docker-compose for sandbox
security_opt:
  - no-new-privileges:true
  - seccomp:./seccomp-profile.json
cap_drop:
  - ALL
network_mode: none
read_only: true
mem_limit: 256m
cpus: 0.5
pids_limit: 10
```

**Option 2: gVisor (chosen)**
- User-space kernel implementation
- Intercepts syscalls
- Stronger isolation than Docker alone
- Used by Google Cloud Run

**Option 3: Firecracker microVMs**
- VM-level isolation
- More overhead
- Used by AWS Lambda

### Execution Flow

```typescript
async function executeSubmission(submission: Submission): Promise<Result> {
  const sandbox = await sandboxPool.acquire(submission.language);

  try {
    // 1. Write user code to sandbox
    await sandbox.writeFile('/code/solution.py', submission.code);

    // 2. Compile if needed (for compiled languages)
    if (needsCompilation(submission.language)) {
      const compileResult = await sandbox.exec(
        getCompileCommand(submission.language),
        { timeout: 30000, memory: '512m' }
      );
      if (compileResult.exitCode !== 0) {
        return { status: 'COMPILE_ERROR', error: compileResult.stderr };
      }
    }

    // 3. Run against each test case
    const results: TestCaseResult[] = [];
    for (const testCase of submission.problem.testCases) {
      const result = await runTestCase(sandbox, submission, testCase);
      results.push(result);

      // Early termination on failure (for efficiency)
      if (result.status !== 'PASSED' && !submission.showAllResults) {
        break;
      }
    }

    return aggregateResults(results);

  } finally {
    await sandbox.reset(); // Clean up for reuse
    sandboxPool.release(sandbox);
  }
}

async function runTestCase(
  sandbox: Sandbox,
  submission: Submission,
  testCase: TestCase
): Promise<TestCaseResult> {
  const startTime = Date.now();

  try {
    const result = await sandbox.exec(
      getRunCommand(submission.language),
      {
        stdin: testCase.input,
        timeout: submission.problem.timeLimit,
        memory: submission.problem.memoryLimit
      }
    );

    const executionTime = Date.now() - startTime;

    if (result.timeout) {
      return { status: 'TIME_LIMIT_EXCEEDED', time: executionTime };
    }
    if (result.memoryExceeded) {
      return { status: 'MEMORY_LIMIT_EXCEEDED', time: executionTime };
    }
    if (result.exitCode !== 0) {
      return { status: 'RUNTIME_ERROR', error: result.stderr, time: executionTime };
    }

    // Compare output
    const passed = compareOutput(result.stdout, testCase.expectedOutput);
    return {
      status: passed ? 'PASSED' : 'WRONG_ANSWER',
      time: executionTime,
      output: result.stdout.substring(0, 1000) // Truncate for display
    };

  } catch (error) {
    return { status: 'SYSTEM_ERROR', error: error.message };
  }
}
```

### Output Comparison

```typescript
function compareOutput(actual: string, expected: string): boolean {
  // Normalize whitespace
  const normalizeWhitespace = (s: string) =>
    s.trim().replace(/\r\n/g, '\n').replace(/\s+$/gm, '');

  const actualNorm = normalizeWhitespace(actual);
  const expectedNorm = normalizeWhitespace(expected);

  if (actualNorm === expectedNorm) return true;

  // Handle floating point comparison
  if (isNumericOutput(expectedNorm)) {
    return compareNumeric(actualNorm, expectedNorm, 1e-6);
  }

  return false;
}
```

### Resource Limits per Language

```typescript
const resourceLimits: Record<string, ResourceLimits> = {
  python: { time: 10000, memory: '256m', multiplier: 3 },
  java: { time: 5000, memory: '512m', multiplier: 2 },
  cpp: { time: 2000, memory: '256m', multiplier: 1 },
  javascript: { time: 8000, memory: '256m', multiplier: 2.5 },
  go: { time: 3000, memory: '256m', multiplier: 1.2 },
};

// Time limit = base_limit * language_multiplier
```

---

## Step 5: Deep Dive - Multiple Language Support (5 minutes)

### Language Runtime Management

Each supported language needs:
1. Compiler/interpreter installed
2. Standard library available
3. Execution wrapper

### Container Images per Language

```dockerfile
# Base image
FROM ubuntu:22.04

# Common setup
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python image
FROM base AS python
RUN apt-get update && apt-get install -y python3.11 python3-pip
RUN pip3 install numpy scipy  # Common libraries

# Java image
FROM base AS java
RUN apt-get update && apt-get install -y openjdk-17-jdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

# C++ image
FROM base AS cpp
RUN apt-get update && apt-get install -y g++ clang
```

### Execution Wrappers

```python
# Python wrapper
import sys
import resource

# Set resource limits
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)  # 256MB
resource.setrlimit(resource.RLIMIT_CPU, (10, 10))  # 10 seconds

# Execute user code
exec(open('/code/solution.py').read())
```

```java
// Java wrapper
public class Runner {
    public static void main(String[] args) {
        // Set security manager
        System.setSecurityManager(new SandboxSecurityManager());

        // Load and run user code
        Solution solution = new Solution();
        // ...
    }
}
```

### Language-Specific Compilation

```typescript
function getCompileCommand(language: string, files: string[]): string {
  switch (language) {
    case 'cpp':
      return `g++ -O2 -std=c++17 -o /code/solution ${files.join(' ')}`;
    case 'java':
      return `javac -d /code ${files.join(' ')}`;
    case 'rust':
      return `rustc -O -o /code/solution ${files[0]}`;
    case 'go':
      return `go build -o /code/solution ${files[0]}`;
    default:
      return null; // Interpreted language
  }
}
```

---

## Step 6: Deep Dive - Contest Mode (5 minutes)

### Contest Requirements

- Time-limited (2-3 hours)
- 4-6 problems
- Real-time leaderboard
- Fair queuing (no priority for repeat submissions)

### Contest Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Contest Mode                                │
│                                                                 │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │ Contest Service │    │ Leaderboard     │                    │
│  │                 │    │ Service         │                    │
│  │ - Start/end     │    │                 │                    │
│  │ - Enrollment    │    │ - Real-time     │                    │
│  │ - Time sync     │    │ - Scoring       │                    │
│  └────────┬────────┘    └────────┬────────┘                    │
│           │                      │                              │
│           │      ┌───────────────┘                              │
│           ▼      ▼                                              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Redis (Real-time State)                        │ │
│  │                                                             │ │
│  │  contest:{id}:leaderboard  → Sorted Set (score, user_id)    │ │
│  │  contest:{id}:submissions  → List (submission_ids)          │ │
│  │  contest:{id}:user:{uid}   → Hash (solved, penalties)       │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Scoring Algorithm (ICPC Style)

```typescript
interface ContestScore {
  solved: number;        // Number of problems solved
  penalty: number;       // Time penalty in minutes
  submissions: Map<string, ProblemScore>;
}

interface ProblemScore {
  solved: boolean;
  attempts: number;
  solvedAt: number;      // Minutes from contest start
}

function calculateScore(userId: string, contestId: string): ContestScore {
  const submissions = await getContestSubmissions(userId, contestId);

  let solved = 0;
  let penalty = 0;
  const problems = new Map<string, ProblemScore>();

  for (const sub of submissions) {
    const problemScore = problems.get(sub.problemId) || {
      solved: false, attempts: 0, solvedAt: 0
    };

    if (!problemScore.solved) {
      if (sub.status === 'ACCEPTED') {
        problemScore.solved = true;
        problemScore.solvedAt = minutesFromStart(sub.submittedAt, contestStart);
        solved++;
        penalty += problemScore.solvedAt + (problemScore.attempts * 20);
      } else {
        problemScore.attempts++;
      }
    }
    problems.set(sub.problemId, problemScore);
  }

  return { solved, penalty, submissions: problems };
}

// Ranking: Sort by solved DESC, then penalty ASC
```

### Anti-Cheating Measures

1. **Code similarity detection**: Compare submissions using algorithms like MOSS
2. **IP tracking**: Flag multiple accounts from same IP
3. **Timing analysis**: Detect suspicious submission patterns
4. **Randomized test cases**: Different test order per user

---

## Step 7: Data Model (3 minutes)

### PostgreSQL Schema

```sql
-- Problems
CREATE TABLE problems (
  id UUID PRIMARY KEY,
  title VARCHAR(255),
  slug VARCHAR(100) UNIQUE,
  description TEXT,
  difficulty VARCHAR(20),  -- 'easy', 'medium', 'hard'
  time_limit_ms INTEGER DEFAULT 2000,
  memory_limit_mb INTEGER DEFAULT 256,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Test cases
CREATE TABLE test_cases (
  id UUID PRIMARY KEY,
  problem_id UUID REFERENCES problems(id),
  input TEXT,
  expected_output TEXT,
  is_sample BOOLEAN DEFAULT FALSE,  -- Shown to users
  order_index INTEGER
);

-- Submissions
CREATE TABLE submissions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  problem_id UUID REFERENCES problems(id),
  contest_id UUID REFERENCES contests(id),
  language VARCHAR(20),
  code TEXT,
  status VARCHAR(30),
  runtime_ms INTEGER,
  memory_kb INTEGER,
  test_cases_passed INTEGER,
  test_cases_total INTEGER,
  created_at TIMESTAMP
);

-- User progress
CREATE TABLE user_problem_status (
  user_id UUID REFERENCES users(id),
  problem_id UUID REFERENCES problems(id),
  status VARCHAR(20),  -- 'solved', 'attempted', 'unsolved'
  best_runtime_ms INTEGER,
  best_memory_kb INTEGER,
  attempts INTEGER DEFAULT 0,
  solved_at TIMESTAMP,
  PRIMARY KEY (user_id, problem_id)
);

-- Contests
CREATE TABLE contests (
  id UUID PRIMARY KEY,
  title VARCHAR(255),
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  is_rated BOOLEAN DEFAULT TRUE
);

CREATE TABLE contest_problems (
  contest_id UUID REFERENCES contests(id),
  problem_id UUID REFERENCES problems(id),
  order_index INTEGER,
  points INTEGER,
  PRIMARY KEY (contest_id, problem_id)
);
```

---

## Step 8: API Design (2 minutes)

### REST API

```
# Problems
GET  /api/v1/problems                    - List problems
GET  /api/v1/problems/{slug}             - Get problem details
GET  /api/v1/problems/{slug}/submissions - User's submissions

# Submissions
POST /api/v1/submissions                 - Submit code
GET  /api/v1/submissions/{id}            - Get submission result
GET  /api/v1/submissions/{id}/status     - Poll for result

# Contests
GET  /api/v1/contests                    - List contests
GET  /api/v1/contests/{id}               - Contest details
POST /api/v1/contests/{id}/register      - Register for contest
GET  /api/v1/contests/{id}/leaderboard   - Real-time leaderboard

# User
GET  /api/v1/users/{id}/profile          - User profile + stats
GET  /api/v1/users/{id}/submissions      - Submission history
```

### WebSocket for Real-time

```typescript
// Subscribe to submission result
ws.send({ type: 'subscribe', submissionId: 'xxx' });

// Receive updates
ws.on('message', (data) => {
  // { type: 'status', status: 'RUNNING', testCase: 5 }
  // { type: 'result', status: 'ACCEPTED', runtime: 42, memory: 12340 }
});

// Subscribe to contest leaderboard
ws.send({ type: 'subscribe', contestId: 'xxx', channel: 'leaderboard' });
```

---

## Step 9: Scalability (3 minutes)

### Worker Pool Scaling

```typescript
// Auto-scale based on queue depth
async function autoScaleWorkers() {
  const queueDepth = await getQueueDepth();
  const processingCapacity = activeWorkers * avgThroughput;

  // Target: process queue in 30 seconds
  const targetCapacity = queueDepth / 30;

  if (targetCapacity > processingCapacity * 1.2) {
    // Scale up
    const newWorkers = Math.ceil(
      (targetCapacity - processingCapacity) / avgThroughput
    );
    await kubernetes.scaleDeployment('judge-workers', newWorkers);
  }
}
```

### Pre-warming Containers

```typescript
// Keep warm containers ready
class SandboxPool {
  private warmContainers: Map<string, Sandbox[]> = new Map();
  private minWarm = 5;

  async acquire(language: string): Promise<Sandbox> {
    const pool = this.warmContainers.get(language) || [];
    if (pool.length > 0) {
      return pool.pop()!;
    }
    // Create new if pool empty
    return this.createSandbox(language);
  }

  async release(sandbox: Sandbox): Promise<void> {
    await sandbox.reset();
    const pool = this.warmContainers.get(sandbox.language) || [];
    if (pool.length < this.minWarm * 2) {
      pool.push(sandbox);
    } else {
      await sandbox.destroy();
    }
  }
}
```

### Geographic Distribution

- Deploy workers in multiple regions
- Route submissions to nearest region
- Replicate problem database globally

---

## Step 10: Trade-offs (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| gVisor sandboxing | Strong security, but 10-20% overhead |
| Pre-compiled test images | Fast startup, but storage cost |
| Sequential test execution | Fair comparison, but slower |
| Per-language workers | Efficient, but complex scaling |

### Alternatives Considered

1. **WebAssembly sandbox**
   - Portable, fast
   - Limited language support
   - Could use for JavaScript

2. **AWS Lambda for execution**
   - Scalable, managed
   - Cold start latency
   - Higher cost at scale

3. **Run all tests in parallel**
   - Faster results
   - Higher resource usage
   - Chose sequential for fairness

---

## Closing Summary

"I've designed an online judge system with:

1. **gVisor-based sandboxing** for secure code execution with syscall filtering
2. **Language-specific worker pools** with pre-warmed containers
3. **Queue-based submission processing** for handling traffic spikes
4. **Real-time contest leaderboards** with ICPC-style scoring

The key insight is that security and fairness are non-negotiable. We use multiple layers of isolation (containers, gVisor, seccomp, resource limits) to run untrusted code safely. Happy to discuss any aspect further."

---

## Potential Follow-up Questions

1. **How would you detect plagiarism?**
   - Tokenize code, remove variable names
   - Calculate similarity using algorithms like MOSS
   - Flag pairs above 80% similarity for review

2. **How would you handle a fork bomb?**
   - PID limit in cgroup (max 10 processes)
   - Seccomp blocking fork() syscall
   - Timeout as last resort

3. **How would you support custom test case input?**
   - "Run code" mode with user-provided input
   - Separate pool with shorter limits
   - Rate limited per user
