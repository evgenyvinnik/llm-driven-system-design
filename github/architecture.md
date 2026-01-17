# Design GitHub - Architecture

## System Overview

GitHub is a code hosting platform built on Git. Core challenges involve Git storage, code search, and collaborative workflows like pull requests.

**Learning Goals:**
- Understand Git internals and storage
- Build code search systems
- Design collaborative PR workflows
- Implement webhook delivery systems

---

## Requirements

### Functional Requirements

1. **Repos**: Create, clone, push, pull
2. **PRs**: Create, review, merge pull requests
3. **Search**: Find code across repositories
4. **Actions**: Run CI/CD workflows
5. **Webhooks**: Notify external systems of events

### Non-Functional Requirements

- **Availability**: 99.99% for Git operations
- **Latency**: < 100ms for API requests
- **Scale**: 200M repos, 1B files indexed
- **Durability**: No data loss (critical)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│  Web UI │ Git CLI │ GitHub CLI │ IDE Extensions                 │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Git Server  │    │   API Server  │    │ Search Service│
│               │    │               │    │               │
│ - SSH/HTTPS   │    │ - REST/GraphQL│    │ - Code index  │
│ - Pack files  │    │ - PRs, Issues │    │ - Elasticsearch│
│ - LFS         │    │ - Webhooks    │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Storage Layer                              │
├─────────────┬─────────────┬─────────────────────────────────────┤
│ Git Storage │ PostgreSQL  │           Elasticsearch             │
│ (Object store)│ - Repos    │           - Code search             │
│ - Blobs     │ - PRs       │           - Symbols                 │
│ - Trees     │ - Users     │                                     │
│ - Commits   │ - Webhooks  │                                     │
└─────────────┴─────────────┴─────────────────────────────────────┘
```

---

## Core Components

### 1. Git Object Storage

**Git Object Types:**
- **Blob**: File content (compressed)
- **Tree**: Directory structure
- **Commit**: Commit metadata + tree pointer
- **Tag**: Annotated tag

**Storage Strategy:**
```
/repositories
  /{owner}
    /{repo}
      /objects
        /pack
          pack-abc123.pack
          pack-abc123.idx
      /refs
        /heads
          main
          feature-branch
        /tags
          v1.0.0
```

**Object Deduplication:**
```javascript
// Git objects are content-addressed (SHA-1 hash of content)
// Same file in multiple repos = stored once

async function storeObject(content, type) {
  const hash = sha1(`${type} ${content.length}\0${content}`)
  const existing = await objectStore.exists(hash)

  if (!existing) {
    await objectStore.put(hash, compress(content))
  }

  return hash
}
```

### 2. Pull Request Workflow

**PR State Machine:**
```
OPEN → REVIEW_REQUIRED → APPROVED → MERGED
  │         │               │          │
  └─────────┴───────────────┴──────────┘
                  │
              CLOSED (without merge)
```

**Merge Strategies:**
```javascript
async function mergePR(prId, strategy) {
  const pr = await getPR(prId)

  switch (strategy) {
    case 'merge':
      // Create merge commit
      await git.merge(pr.headBranch, pr.baseBranch)
      break

    case 'squash':
      // Combine all commits into one
      const commits = await git.log(pr.baseBranch, pr.headBranch)
      const squashed = squashCommits(commits)
      await git.commit(squashed, pr.baseBranch)
      break

    case 'rebase':
      // Replay commits on top of base
      await git.rebase(pr.headBranch, pr.baseBranch)
      break
  }

  await closePR(prId, 'merged')
  await emitWebhook('pull_request.merged', pr)
}
```

### 3. Code Search

**Indexing Pipeline:**
```
Push Event → Parse Files → Extract Symbols → Index to Elasticsearch
                │
                ├── Language detection
                ├── Tokenization
                └── Symbol extraction (functions, classes)
```

**Elasticsearch Index:**
```json
{
  "mappings": {
    "properties": {
      "repo_id": { "type": "keyword" },
      "path": { "type": "keyword" },
      "content": { "type": "text", "analyzer": "code_analyzer" },
      "language": { "type": "keyword" },
      "symbols": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "kind": { "type": "keyword" },
          "line": { "type": "integer" }
        }
      }
    }
  }
}
```

**Search Query:**
```javascript
async function searchCode(query, { language, repo, path }) {
  return await es.search({
    index: 'code',
    body: {
      query: {
        bool: {
          must: [
            { match: { content: query } }
          ],
          filter: [
            language && { term: { language } },
            repo && { term: { repo_id: repo } },
            path && { wildcard: { path: path } }
          ].filter(Boolean)
        }
      },
      highlight: {
        fields: { content: {} }
      }
    }
  })
}
```

### 4. Webhook Delivery

**Reliable Delivery:**
```javascript
async function deliverWebhook(webhookId, event, payload) {
  const webhook = await getWebhook(webhookId)

  // Queue for delivery
  await webhookQueue.add({
    webhookId,
    event,
    payload,
    attempt: 1,
    scheduledAt: Date.now()
  })
}

// Worker processes queue
async function processWebhookJob(job) {
  const { webhookId, payload, attempt } = job

  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': job.event,
        'X-Hub-Signature': sign(payload, webhook.secret)
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok && attempt < 10) {
      // Retry with exponential backoff
      await webhookQueue.add({
        ...job,
        attempt: attempt + 1,
        scheduledAt: Date.now() + Math.pow(2, attempt) * 1000
      })
    }

    await logDelivery(webhookId, response.status, payload)
  } catch (error) {
    await logDelivery(webhookId, 'error', { error: error.message })
  }
}
```

---

## Database Schema

```sql
-- Repositories
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner_id, name)
);

-- Pull Requests
CREATE TABLE pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id),
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  head_branch VARCHAR(100),
  base_branch VARCHAR(100),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- PR Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id),
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20), -- 'approved', 'changes_requested', 'commented'
  body TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id),
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Object Store for Git Data

**Decision**: Store Git objects in object storage, not database

**Rationale**:
- Git objects are immutable (content-addressed)
- Object storage optimized for large blobs
- Enables deduplication across repos

### 2. Elasticsearch for Code Search

**Decision**: Separate search index from Git storage

**Rationale**:
- Git objects not optimized for full-text search
- Elasticsearch handles tokenization, ranking
- Async indexing doesn't block pushes

### 3. Queue-Based Webhook Delivery

**Decision**: Async delivery with retry queue

**Rationale**:
- Decouples event creation from delivery
- Handles slow/failing endpoints
- Provides delivery history

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Git storage | Object store | Database | Performance, dedup |
| Code search | Elasticsearch | PostgreSQL FTS | Scale, features |
| Webhooks | Queue-based | Synchronous | Reliability |
| PRs | Single table | Event sourced | Simplicity |

---

## Consistency and Idempotency

### Consistency Model by Operation

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Git push/fetch | Strong (per-repo) | Git ref updates use file locks; pack operations are atomic |
| PR create/merge | Strong | PostgreSQL transactions ensure PR state integrity |
| Code search index | Eventual (seconds) | Async indexing after push; search lag acceptable |
| Webhook delivery | At-least-once | Retries may cause duplicates; receivers must be idempotent |
| User sessions | Eventual (Redis) | Session replication across Redis replicas has small lag |

### Idempotency Keys

**PR Operations:**
```javascript
// Client generates idempotency key for PR creation
// Stored in PostgreSQL to detect replays within 24 hours

async function createPR(prData, idempotencyKey) {
  // Check for existing operation with same key
  const existing = await db.query(
    `SELECT pr_id FROM idempotency_keys
     WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [idempotencyKey]
  )

  if (existing.rows.length > 0) {
    // Return cached result instead of creating duplicate
    return await getPR(existing.rows[0].pr_id)
  }

  return await db.transaction(async (tx) => {
    const pr = await tx.query(
      `INSERT INTO pull_requests (repo_id, title, head_branch, base_branch, author_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [prData.repoId, prData.title, prData.headBranch, prData.baseBranch, prData.authorId]
    )

    // Store idempotency key
    await tx.query(
      `INSERT INTO idempotency_keys (key, pr_id) VALUES ($1, $2)`,
      [idempotencyKey, pr.rows[0].id]
    )

    return pr.rows[0]
  })
}
```

**Webhook Delivery:**
```javascript
// Each webhook delivery has unique delivery_id
// Receivers use X-GitHub-Delivery header for deduplication

async function deliverWebhook(webhookId, event, payload) {
  const deliveryId = uuidv4()

  await webhookQueue.add({
    deliveryId,           // Unique per delivery attempt
    webhookId,
    event,
    payload,
    attempt: 1
  })

  // Receiver should check: has deliveryId been processed?
  // If yes, return 200 OK without re-processing
}
```

### Conflict Resolution

**Git Push Conflicts:**
- Git itself handles ref update conflicts via compare-and-swap
- Push rejected if remote ref has advanced (non-fast-forward)
- Client must pull, resolve, and retry

**PR Merge Conflicts:**
```javascript
async function checkMergeability(prId) {
  const pr = await getPR(prId)

  try {
    // Attempt merge in temporary worktree
    await git.checkout(pr.baseBranch, { worktree: tempDir })
    await git.merge(pr.headBranch, { noCommit: true, noFf: true })

    return { mergeable: true, conflicts: [] }
  } catch (error) {
    // Parse conflict files from error
    const conflicts = parseConflicts(error.message)
    return { mergeable: false, conflicts }
  } finally {
    await cleanup(tempDir)
  }
}
```

### Idempotency Keys Table

```sql
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id),
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Clean up old keys daily
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- Cleanup job (run via cron or scheduled task)
-- DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '24 hours';
```

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│     CDN     │────▶│   Origin    │
│             │     │ (static)    │     │   Servers   │
└─────────────┘     └─────────────┘     └─────────────┘
                                              │
                    ┌─────────────┐           │
                    │   Valkey    │◀──────────┘
                    │   (Redis)   │
                    └─────────────┘
                          │
                    ┌─────────────┐
                    │ PostgreSQL  │
                    └─────────────┘
```

### Cache Strategy by Data Type

| Data | Strategy | TTL | Invalidation |
|------|----------|-----|--------------|
| Static assets (JS/CSS) | CDN with versioned URLs | 1 year | New deploy = new URL |
| Repository metadata | Cache-aside (Valkey) | 5 min | On push, settings change |
| User profile/avatar | Cache-aside (Valkey) | 15 min | On profile update |
| File content (blob) | Cache-aside (Valkey) | 1 hour | Immutable (content-addressed) |
| Search results | No cache | N/A | Real-time required |
| PR diff | Cache-aside (Valkey) | 10 min | On PR update, new commits |

### Cache-Aside Implementation

```javascript
// Valkey (Redis-compatible) cache-aside pattern
const CACHE_TTL = {
  REPO_METADATA: 300,      // 5 minutes
  FILE_CONTENT: 3600,      // 1 hour (blobs are immutable)
  USER_PROFILE: 900,       // 15 minutes
  PR_DIFF: 600             // 10 minutes
}

async function getRepository(repoId) {
  const cacheKey = `repo:${repoId}`

  // Try cache first
  const cached = await valkey.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // Cache miss - fetch from database
  const repo = await db.query(
    'SELECT * FROM repositories WHERE id = $1',
    [repoId]
  )

  if (repo.rows.length > 0) {
    await valkey.setex(
      cacheKey,
      CACHE_TTL.REPO_METADATA,
      JSON.stringify(repo.rows[0])
    )
    return repo.rows[0]
  }

  return null
}

// File content caching (content-addressed, so longer TTL is safe)
async function getFileContent(repoId, sha, path) {
  const cacheKey = `blob:${repoId}:${sha}:${path}`

  const cached = await valkey.get(cacheKey)
  if (cached) return cached

  const content = await git.show(`${sha}:${path}`, { cwd: repoPath })

  // Blobs are immutable - cache for 1 hour
  await valkey.setex(cacheKey, CACHE_TTL.FILE_CONTENT, content)
  return content
}
```

### Cache Invalidation

```javascript
// Event-driven invalidation on push
async function handlePushEvent(repoId, commits) {
  const invalidationKeys = [
    `repo:${repoId}`,           // Repository metadata
    `repo:${repoId}:tree:*`,    // File trees
    `repo:${repoId}:commits:*`  // Commit lists
  ]

  // Use SCAN + DEL for pattern matching (avoid KEYS in production)
  for (const pattern of invalidationKeys) {
    if (pattern.includes('*')) {
      await scanAndDelete(pattern)
    } else {
      await valkey.del(pattern)
    }
  }

  // Invalidate all open PRs for this repo (diffs may have changed)
  const openPRs = await db.query(
    'SELECT id FROM pull_requests WHERE repo_id = $1 AND state = $2',
    [repoId, 'open']
  )

  for (const pr of openPRs.rows) {
    await valkey.del(`pr:${pr.id}:diff`)
  }
}

async function scanAndDelete(pattern) {
  let cursor = '0'
  do {
    const [newCursor, keys] = await valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = newCursor
    if (keys.length > 0) {
      await valkey.del(...keys)
    }
  } while (cursor !== '0')
}
```

### CDN Configuration (for Static Assets)

```javascript
// Express middleware for static asset headers
app.use('/static', express.static('dist', {
  maxAge: '1y',                    // Cache for 1 year
  immutable: true,                 // Signal content won't change
  etag: false,                     // Versioned URLs make etags unnecessary
  setHeaders: (res, path) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
  }
}))

// API responses - no caching by default
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  next()
})
```

### Local Development Cache Setup

```yaml
# docker-compose.yml addition for Valkey
services:
  valkey:
    image: valkey/valkey:7
    ports:
      - "6379:6379"
    command: valkey-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - valkey-data:/data
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Collect:**

```javascript
const promClient = require('prom-client')

// Request latency histogram
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
})

// Git operation latency
const gitOperationDuration = new promClient.Histogram({
  name: 'git_operation_duration_seconds',
  help: 'Git operation latency in seconds',
  labelNames: ['operation', 'repo_size_bucket'],  // clone, push, fetch
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60]
})

// Cache hit/miss counter
const cacheHits = new promClient.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache_type']  // repo, file, pr_diff
})

const cacheMisses = new promClient.Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache_type']
})

// Webhook delivery status
const webhookDeliveries = new promClient.Counter({
  name: 'webhook_deliveries_total',
  help: 'Total webhook delivery attempts',
  labelNames: ['status', 'event_type']  // success, failed, retrying
})

// Search query latency
const searchLatency = new promClient.Histogram({
  name: 'search_query_duration_seconds',
  help: 'Search query latency in seconds',
  labelNames: ['query_type'],  // code, file, symbol
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5]
})

// Active connections gauge
const activeConnections = new promClient.Gauge({
  name: 'active_connections',
  help: 'Number of active connections',
  labelNames: ['type']  // http, websocket, git_ssh
})
```

**Metrics Endpoint:**
```javascript
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.end(await promClient.register.metrics())
})
```

### Structured Logging

```javascript
const pino = require('pino')

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'github-api',
    version: process.env.APP_VERSION || 'dev'
  }
})

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || uuidv4()
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id
  })

  const start = Date.now()
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - start
    }, 'request completed')
  })

  next()
})

// Example operation logging
async function mergePR(prId, strategy, log) {
  log.info({ prId, strategy }, 'starting PR merge')

  try {
    const result = await performMerge(prId, strategy)
    log.info({ prId, mergeCommit: result.sha }, 'PR merged successfully')
    return result
  } catch (error) {
    log.error({ prId, error: error.message, stack: error.stack }, 'PR merge failed')
    throw error
  }
}
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')

const provider = new NodeTracerProvider()
const jaegerExporter = new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces'
})

provider.addSpanProcessor(new SimpleSpanProcessor(jaegerExporter))
provider.register()

registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation(),
    new PgInstrumentation()
  ]
})

// Manual span for git operations
const tracer = provider.getTracer('github-api')

async function cloneRepository(repoId, destination) {
  return tracer.startActiveSpan('git.clone', async (span) => {
    span.setAttribute('repo.id', repoId)
    span.setAttribute('destination', destination)

    try {
      const result = await git.clone(repoPath, destination)
      span.setAttribute('objects.count', result.objectCount)
      return result
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: 2, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### SLI Dashboards and Alert Thresholds

**Service Level Indicators (SLIs):**

| SLI | Target | Alert Threshold | Measurement |
|-----|--------|-----------------|-------------|
| API Availability | 99.9% | < 99.5% over 5 min | `sum(http_requests{status!~"5.."}) / sum(http_requests)` |
| API Latency (p95) | < 200ms | > 500ms over 5 min | `histogram_quantile(0.95, http_request_duration_seconds)` |
| Git Push Latency (p95) | < 5s | > 10s over 5 min | `histogram_quantile(0.95, git_operation_duration_seconds{operation="push"})` |
| Search Latency (p95) | < 500ms | > 1s over 5 min | `histogram_quantile(0.95, search_query_duration_seconds)` |
| Webhook Delivery Rate | 99% | < 95% over 15 min | `sum(webhook_deliveries{status="success"}) / sum(webhook_deliveries)` |
| Cache Hit Rate | > 80% | < 60% over 15 min | `sum(cache_hits) / (sum(cache_hits) + sum(cache_misses))` |

**Prometheus Alerting Rules:**

```yaml
# prometheus-alerts.yml
groups:
  - name: github-api-alerts
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_request_duration_seconds_count{status_code=~"5.."}[5m]))
          / sum(rate(http_request_duration_seconds_count[5m])) > 0.005
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected (> 0.5%)"

      - alert: HighAPILatency
        expr: |
          histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "API p95 latency > 500ms"

      - alert: WebhookDeliveryFailures
        expr: |
          sum(rate(webhook_deliveries_total{status="failed"}[15m]))
          / sum(rate(webhook_deliveries_total[15m])) > 0.05
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Webhook delivery failure rate > 5%"

      - alert: LowCacheHitRate
        expr: |
          sum(rate(cache_hits_total[15m]))
          / (sum(rate(cache_hits_total[15m])) + sum(rate(cache_misses_total[15m]))) < 0.6
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 60%"
```

### Audit Logging

```sql
-- Audit log table for security-sensitive operations
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(64),
  details JSONB,
  outcome VARCHAR(20) DEFAULT 'success'  -- success, denied, error
);

CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
```

```javascript
// Audit logging middleware for sensitive operations
const AUDITED_ACTIONS = [
  'repo.create', 'repo.delete', 'repo.visibility_change',
  'pr.merge', 'pr.close',
  'webhook.create', 'webhook.delete',
  'user.permission_change', 'user.login', 'user.logout',
  'branch_protection.create', 'branch_protection.delete'
]

async function auditLog(action, resourceType, resourceId, details, req, outcome = 'success') {
  await db.query(
    `INSERT INTO audit_logs
     (user_id, action, resource_type, resource_id, ip_address, user_agent, request_id, details, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      req.user?.id,
      action,
      resourceType,
      resourceId,
      req.ip,
      req.headers['user-agent'],
      req.headers['x-request-id'],
      JSON.stringify(details),
      outcome
    ]
  )
}

// Usage example
app.delete('/api/repos/:owner/:repo', async (req, res) => {
  const { owner, repo } = req.params

  try {
    await deleteRepository(owner, repo)
    await auditLog('repo.delete', 'repository', `${owner}/${repo}`, {}, req, 'success')
    res.status(204).end()
  } catch (error) {
    await auditLog('repo.delete', 'repository', `${owner}/${repo}`,
      { error: error.message }, req, 'error')
    throw error
  }
})
```

### Local Development Observability Stack

```yaml
# docker-compose.yml additions for observability
services:
  prometheus:
    image: prom/prometheus:v2.45.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus-alerts.yml:/etc/prometheus/alerts.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.retention.time=7d'

  grafana:
    image: grafana/grafana:10.0.0
    ports:
      - "3030:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_AUTH_ANONYMOUS_ENABLED=true
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana-dashboards:/etc/grafana/provisioning/dashboards

  jaeger:
    image: jaegertracing/all-in-one:1.47
    ports:
      - "16686:16686"   # UI
      - "14268:14268"   # Accept traces

volumes:
  grafana-data:
```

**prometheus.yml:**
```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - alerts.yml

scrape_configs:
  - job_name: 'github-api'
    static_configs:
      - targets: ['host.docker.internal:3000']
    metrics_path: '/metrics'
```
