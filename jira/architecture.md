# Design Jira - Architecture

## System Overview

Jira is an issue tracking system with customizable workflows. Core challenges involve flexible workflow engines, custom field schemas, and complex permission models.

**Learning Goals:**
- Build configurable workflow engines
- Design dynamic field schemas
- Implement complex permission systems
- Create query languages (JQL)

---

## Requirements

### Functional Requirements

1. **Issues**: Create, update, transition issues
2. **Workflows**: Customizable state machines
3. **Boards**: Kanban and Scrum views
4. **Search**: JQL-based issue search
5. **Reports**: Burndown, velocity, statistics

### Non-Functional Requirements

- **Availability**: 99.9% uptime
- **Latency**: < 200ms for issue operations
- **Scale**: 1M projects, 100M issues
- **Audit**: Full history of all changes

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│         Web │ Mobile │ IDE Plugins │ CLI                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│                  (Auth, Rate Limiting)                          │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Issue Service │    │Workflow Engine│    │Search Service │
│               │    │               │    │               │
│ - CRUD        │    │ - Transitions │    │ - JQL Parser  │
│ - Comments    │    │ - Validators  │    │ - Indexing    │
│ - Attachments │    │ - Actions     │    │ - Aggregation │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │              Elasticsearch                    │
│   - Issues      │              - Issue search                   │
│   - Workflows   │              - JQL queries                    │
│   - History     │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Workflow Engine

**Workflow Definition:**
```typescript
interface Workflow {
  id: string
  name: string
  statuses: Status[]
  transitions: Transition[]
}

interface Status {
  id: string
  name: string
  category: 'todo' | 'in_progress' | 'done'
}

interface Transition {
  id: string
  name: string
  from: string[] // Status IDs (empty = any)
  to: string // Target status ID
  conditions: Condition[]
  validators: Validator[]
  postFunctions: PostFunction[]
}

interface Condition {
  type: 'user_in_role' | 'issue_assignee' | 'custom'
  config: Record<string, any>
}
```

**Transition Execution:**
```javascript
async function executeTransition(issueId, transitionId, user) {
  const issue = await getIssue(issueId)
  const workflow = await getWorkflow(issue.projectId)
  const transition = workflow.transitions.find(t => t.id === transitionId)

  // Check conditions
  for (const condition of transition.conditions) {
    if (!await checkCondition(condition, issue, user)) {
      throw new Error(`Condition failed: ${condition.type}`)
    }
  }

  // Run validators
  for (const validator of transition.validators) {
    if (!await runValidator(validator, issue)) {
      throw new Error(`Validation failed: ${validator.type}`)
    }
  }

  // Update issue status
  const previousStatus = issue.status
  await db('issues')
    .where({ id: issueId })
    .update({ status: transition.to })

  // Run post-functions
  for (const postFunc of transition.postFunctions) {
    await runPostFunction(postFunc, issue, transition)
  }

  // Record history
  await recordHistory(issueId, 'status', previousStatus, transition.to, user)
}
```

### 2. Custom Fields

**Dynamic Schema:**
```sql
-- Field definitions per project
CREATE TABLE custom_field_definitions (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'text', 'number', 'select', 'user', 'date'
  config JSONB, -- Options for select, validation rules
  required BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Field values stored as JSONB on issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  key VARCHAR(50) UNIQUE, -- e.g., "PROJ-123"
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type VARCHAR(50),
  status VARCHAR(50),
  priority VARCHAR(50),
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  custom_fields JSONB, -- { "field_123": "value", "field_456": 42 }
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 3. JQL Parser

**JQL Grammar:**
```
query        = clause (AND|OR clause)*
clause       = field operator value | "(" query ")"
field        = "project" | "status" | "assignee" | customField
operator     = "=" | "!=" | "~" | ">" | "<" | ">=" | "<=" | "IN" | "NOT IN"
value        = string | number | EMPTY | function
function     = "currentUser()" | "now()" | "startOfDay()" | ...
```

**Parser Implementation:**
```javascript
class JQLParser {
  parse(jql) {
    const tokens = this.tokenize(jql)
    return this.parseQuery(tokens)
  }

  toElasticsearch(ast) {
    if (ast.type === 'AND') {
      return { bool: { must: ast.clauses.map(c => this.toElasticsearch(c)) } }
    }
    if (ast.type === 'OR') {
      return { bool: { should: ast.clauses.map(c => this.toElasticsearch(c)) } }
    }
    if (ast.type === 'clause') {
      return this.clauseToES(ast)
    }
  }

  clauseToES(clause) {
    switch (clause.operator) {
      case '=':
        return { term: { [clause.field]: clause.value } }
      case '~':
        return { match: { [clause.field]: clause.value } }
      case 'IN':
        return { terms: { [clause.field]: clause.value } }
      // ... other operators
    }
  }
}

// Usage
const jql = 'project = PROJ AND status = "In Progress" AND assignee = currentUser()'
const ast = parser.parse(jql)
const esQuery = parser.toElasticsearch(ast)
```

### 4. Permission System

**Permission Model:**
```sql
-- Permission schemes define what permissions exist
CREATE TABLE permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  is_default BOOLEAN DEFAULT FALSE
);

-- Permission grants map permissions to roles/users
CREATE TABLE permission_grants (
  scheme_id INTEGER REFERENCES permission_schemes(id),
  permission VARCHAR(100) NOT NULL, -- 'create_issue', 'edit_issue', 'transition', etc.
  grantee_type VARCHAR(50), -- 'role', 'user', 'group', 'anyone'
  grantee_id VARCHAR(100), -- Role name, user ID, or group ID
  PRIMARY KEY (scheme_id, permission, grantee_type, grantee_id)
);

-- Projects use permission schemes
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  workflow_id INTEGER REFERENCES workflows(id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Permission Check:**
```javascript
async function hasPermission(userId, projectId, permission) {
  const project = await getProject(projectId)
  const userRoles = await getUserRoles(userId, projectId)
  const userGroups = await getUserGroups(userId)

  const grants = await db('permission_grants')
    .where({ scheme_id: project.permissionSchemeId, permission })

  for (const grant of grants) {
    if (grant.grantee_type === 'anyone') return true
    if (grant.grantee_type === 'user' && grant.grantee_id === userId) return true
    if (grant.grantee_type === 'role' && userRoles.includes(grant.grantee_id)) return true
    if (grant.grantee_type === 'group' && userGroups.includes(grant.grantee_id)) return true
  }

  return false
}
```

---

## Database Schema

```sql
-- Projects
CREATE TABLE projects (
  id UUID PRIMARY KEY,
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  lead_id UUID REFERENCES users(id),
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  workflow_scheme_id INTEGER REFERENCES workflow_schemes(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues
CREATE TABLE issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id),
  key VARCHAR(50) UNIQUE NOT NULL,
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type_id INTEGER REFERENCES issue_types(id),
  status_id INTEGER REFERENCES statuses(id),
  priority_id INTEGER REFERENCES priorities(id),
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  parent_id INTEGER REFERENCES issues(id), -- For subtasks
  epic_id INTEGER REFERENCES issues(id),
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  custom_fields JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Issue history (audit trail)
CREATE TABLE issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id),
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id),
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. JSONB for Custom Fields

**Decision**: Store custom field values as JSONB

**Rationale**:
- Flexible per-project schema
- No table alterations for new fields
- Good PostgreSQL indexing support

**Trade-off**: Harder to enforce types at DB level

### 2. Workflow as Configuration

**Decision**: Workflows defined in database, not code

**Rationale**:
- Users can customize without developers
- Version and rollback workflows
- Per-project workflow assignment

### 3. JQL to Elasticsearch

**Decision**: Parse JQL and translate to ES queries

**Rationale**:
- Powerful user-facing query language
- Elasticsearch handles complex search
- Familiar to Jira users

---

## Consistency and Idempotency

### Write Consistency Model

**PostgreSQL (Source of Truth)**:
- **Strong consistency** for all issue writes within a single project
- Transactions wrap multi-table operations (issue update + history record + custom field updates)
- `SERIALIZABLE` isolation for transitions where concurrent state changes could conflict

**Elasticsearch (Search Index)**:
- **Eventual consistency** with PostgreSQL as authoritative source
- Index updates happen asynchronously via message queue
- Typical lag: 100-500ms for local development, acceptable for search use cases

**Consistency Boundaries by Operation**:

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Issue create/update | Strong (PostgreSQL) | Single-project writes require immediate consistency |
| Status transitions | Strong + optimistic locking | Workflow state must be atomic |
| Comment add | Strong | User expects immediate visibility |
| Search results | Eventual (~500ms) | Slight delay acceptable for search |
| Board views | Eventually consistent | Cached aggregations, refreshed periodically |

### Idempotency Keys

All mutating API operations accept an `X-Idempotency-Key` header to handle client retries safely.

**Implementation**:
```sql
CREATE TABLE idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL,
  request_path VARCHAR(200) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

**Request Flow**:
```javascript
async function handleRequest(req, handler) {
  const idempotencyKey = req.headers['x-idempotency-key'];
  if (!idempotencyKey) {
    return handler(req); // Non-idempotent request
  }

  // Check for existing result
  const existing = await db('idempotency_keys')
    .where({ key: idempotencyKey, user_id: req.user.id })
    .first();

  if (existing) {
    return { status: existing.response_status, body: existing.response_body };
  }

  // Execute and store result
  const result = await handler(req);
  await db('idempotency_keys').insert({
    key: idempotencyKey,
    user_id: req.user.id,
    request_path: req.path,
    response_status: result.status,
    response_body: result.body
  });

  return result;
}
```

**TTL**: Keys expire after 24 hours. A background job purges expired keys hourly.

### Conflict Resolution

**Optimistic Concurrency Control** for issue updates:

```sql
ALTER TABLE issues ADD COLUMN version INTEGER DEFAULT 1;
```

**Update Pattern**:
```javascript
async function updateIssue(issueId, updates, expectedVersion) {
  const result = await db('issues')
    .where({ id: issueId, version: expectedVersion })
    .update({
      ...updates,
      version: expectedVersion + 1,
      updated_at: db.fn.now()
    });

  if (result === 0) {
    throw new ConflictError('Issue was modified by another user. Refresh and retry.');
  }
}
```

**Conflict Scenarios**:
- **Concurrent field edits**: Last-write-wins for non-conflicting fields; conflict error for same field
- **Status transitions**: Reject if current status differs from expected `from_status`
- **Bulk operations**: Process in batches of 50, skip conflicting issues, report failures

### Replay Handling

For message queue consumers (search indexing, notifications):
- Messages include `event_id` (UUID) generated at source
- Consumers track processed event IDs in Redis with 24-hour TTL
- Duplicate messages are logged and skipped

```javascript
async function handleIndexEvent(event) {
  const processed = await redis.get(`processed:${event.event_id}`);
  if (processed) {
    logger.debug('Skipping duplicate event', { eventId: event.event_id });
    return;
  }

  await indexIssue(event.issue);
  await redis.setex(`processed:${event.event_id}`, 86400, '1');
}
```

---

## Caching and Edge Strategy

### Cache Architecture

For local development, we use **Valkey/Redis** as the primary cache layer. In production, a CDN would sit in front for static assets and read-heavy API responses.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client                                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                   │
│         (Rate limiting, Auth, Response cache headers)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Valkey/Redis Cache                            │
│    Session │ Issue Cache │ Permission Cache │ Workflow Cache     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  PostgreSQL / Elasticsearch                      │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Strategy: Cache-Aside (Lazy Loading)

We use **cache-aside** for most reads. This pattern:
1. Check cache first
2. On miss, read from database
3. Populate cache with result

**Rationale**: Issue data is frequently updated; write-through would add latency to every write. Cache-aside allows stale reads briefly but keeps writes fast.

```javascript
async function getIssue(issueId) {
  const cacheKey = `issue:${issueId}`;

  // 1. Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Fetch from database
  const issue = await db('issues').where({ id: issueId }).first();
  if (!issue) return null;

  // 3. Populate cache
  await redis.setex(cacheKey, 300, JSON.stringify(issue)); // 5 min TTL

  return issue;
}
```

### Cache Keys and TTLs

| Cache Type | Key Pattern | TTL | Invalidation |
|------------|-------------|-----|--------------|
| Issue data | `issue:{id}` | 5 min | On update, delete key |
| Issue by key | `issue:key:{projectKey}-{number}` | 5 min | On update, delete key |
| Project metadata | `project:{id}` | 15 min | On project update |
| Workflow definition | `workflow:{id}` | 30 min | On workflow edit (rare) |
| Permission scheme | `perm-scheme:{id}` | 30 min | On scheme edit (rare) |
| User permissions | `user-perms:{userId}:{projectId}` | 10 min | On role change |
| Board configuration | `board:{id}` | 15 min | On board edit |
| JQL saved filter | `filter:{id}:results` | 2 min | On filter execution |

### Cache Invalidation Rules

**Explicit invalidation** (preferred for critical data):
```javascript
async function updateIssue(issueId, updates) {
  await db('issues').where({ id: issueId }).update(updates);

  // Invalidate all related cache keys
  const issue = await db('issues').where({ id: issueId }).first();
  await redis.del(`issue:${issueId}`);
  await redis.del(`issue:key:${issue.key}`);

  // Publish event for search reindexing
  await publishEvent('issue.updated', { issueId, changes: updates });
}
```

**Pattern-based invalidation** for bulk operations:
```javascript
async function invalidateProjectIssues(projectId) {
  // Use Redis SCAN to find and delete matching keys
  let cursor = '0';
  do {
    const [newCursor, keys] = await redis.scan(
      cursor, 'MATCH', `issue:*`, 'COUNT', 100
    );
    cursor = newCursor;
    if (keys.length > 0) {
      // Filter to project issues and delete
      const issues = await Promise.all(keys.map(k => redis.get(k)));
      const projectKeys = keys.filter((k, i) => {
        const issue = JSON.parse(issues[i] || '{}');
        return issue.project_id === projectId;
      });
      if (projectKeys.length > 0) await redis.del(...projectKeys);
    }
  } while (cursor !== '0');
}
```

### Read-Heavy Optimization: Board Views

Board views (Kanban/Scrum) are expensive to compute. We use **cache-aside with computed aggregations**:

```javascript
async function getBoardIssues(boardId) {
  const cacheKey = `board:${boardId}:issues`;

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const board = await getBoard(boardId);
  const issues = await db('issues')
    .where({ project_id: board.project_id })
    .whereIn('status_id', board.column_status_ids)
    .orderBy('rank', 'asc');

  // Group by status for frontend
  const columns = groupBy(issues, 'status_id');

  await redis.setex(cacheKey, 60, JSON.stringify(columns)); // 1 min TTL
  return columns;
}
```

**Invalidation trigger**: Any issue update within the board's project invalidates the board cache.

### Static Asset Caching (Local Dev)

For local development, Vite dev server handles static assets. In production:
- CDN caches `/static/*` with 1-year TTL (immutable, hashed filenames)
- API responses include `Cache-Control: private, no-cache` for dynamic data
- Board thumbnails and attachment previews: CDN with 24-hour TTL

---

## Async Queue and Background Jobs

### Queue Architecture

We use **RabbitMQ** for async processing. For local development, this runs in Docker alongside other services.

```
┌─────────────────────────────────────────────────────────────────┐
│                      API Services                                │
│    Issue Service │ Workflow Engine │ Comment Service             │
└─────────────────────────────────────────────────────────────────┘
        │                   │                     │
        ▼                   ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RabbitMQ                                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │ issue.events│ │ search.index│ │notifications│                │
│  │   (fanout)  │ │   (direct)  │ │   (direct)  │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
        │                   │                     │
        ▼                   ▼                     ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Search Indexer│   │ Notification  │   │ Webhook       │
│               │   │ Worker        │   │ Dispatcher    │
└───────────────┘   └───────────────┘   └───────────────┘
```

### Queue Configuration

```javascript
// RabbitMQ connection and channel setup
const QUEUES = {
  ISSUE_EVENTS: 'issue.events',      // Fanout exchange for all issue changes
  SEARCH_INDEX: 'search.index',      // Direct queue for ES indexing
  NOTIFICATIONS: 'notifications',    // Direct queue for email/in-app
  WEBHOOKS: 'webhooks',              // Direct queue for webhook delivery
  BULK_OPERATIONS: 'bulk.operations' // Direct queue for bulk updates
};

// Queue declarations with durability
async function setupQueues(channel) {
  // Durable queues survive broker restarts
  await channel.assertQueue(QUEUES.SEARCH_INDEX, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'dlx',
      'x-dead-letter-routing-key': 'search.index.dlq'
    }
  });

  // Set prefetch for backpressure control
  await channel.prefetch(10); // Process 10 messages at a time
}
```

### Message Types and Delivery Semantics

| Queue | Message Type | Delivery | Retry Policy |
|-------|--------------|----------|--------------|
| `issue.events` | Issue created/updated/deleted | At-least-once | N/A (fanout) |
| `search.index` | Reindex request | At-least-once | 3 retries, exponential backoff |
| `notifications` | Email/in-app notification | At-least-once | 3 retries, then DLQ |
| `webhooks` | Webhook payload | At-least-once | 5 retries with exponential backoff |
| `bulk.operations` | Batch update job | At-least-once | 3 retries, log failures |

### Publisher Implementation

```javascript
async function publishIssueEvent(eventType, issue, changes) {
  const event = {
    event_id: uuid(),
    event_type: eventType, // 'created', 'updated', 'deleted', 'transitioned'
    issue_id: issue.id,
    project_id: issue.project_id,
    changes: changes,
    timestamp: new Date().toISOString(),
    actor_id: getCurrentUserId()
  };

  // Publish to fanout exchange - all consumers receive
  await channel.publish(
    'issue.events.exchange',
    '', // Fanout ignores routing key
    Buffer.from(JSON.stringify(event)),
    {
      persistent: true, // Survive broker restart
      contentType: 'application/json',
      messageId: event.event_id
    }
  );
}
```

### Consumer Implementation with Backpressure

```javascript
class SearchIndexConsumer {
  constructor(channel) {
    this.channel = channel;
    this.processing = 0;
    this.maxConcurrent = 10;
  }

  async start() {
    await this.channel.consume(
      QUEUES.SEARCH_INDEX,
      async (msg) => {
        if (this.processing >= this.maxConcurrent) {
          // Backpressure: reject and requeue
          this.channel.nack(msg, false, true);
          return;
        }

        this.processing++;
        try {
          const event = JSON.parse(msg.content.toString());
          await this.indexIssue(event);
          this.channel.ack(msg);
        } catch (error) {
          await this.handleError(msg, error);
        } finally {
          this.processing--;
        }
      },
      { noAck: false } // Manual acknowledgment
    );
  }

  async handleError(msg, error) {
    const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;

    if (retryCount > 3) {
      // Send to dead letter queue
      logger.error('Message failed after 3 retries', {
        messageId: msg.properties.messageId,
        error: error.message
      });
      this.channel.reject(msg, false); // Don't requeue
      return;
    }

    // Exponential backoff: 1s, 2s, 4s
    const delay = Math.pow(2, retryCount - 1) * 1000;

    setTimeout(() => {
      this.channel.publish(
        '',
        QUEUES.SEARCH_INDEX,
        msg.content,
        {
          ...msg.properties,
          headers: { ...msg.properties.headers, 'x-retry-count': retryCount }
        }
      );
      this.channel.ack(msg);
    }, delay);
  }

  async indexIssue(event) {
    // Deduplicate based on event_id
    const processed = await redis.get(`processed:${event.event_id}`);
    if (processed) return;

    const issue = await db('issues')
      .where({ id: event.issue_id })
      .first();

    if (!issue) {
      // Issue was deleted - remove from index
      await esClient.delete({
        index: 'issues',
        id: event.issue_id.toString()
      }).catch(() => {}); // Ignore if not found
      return;
    }

    await esClient.index({
      index: 'issues',
      id: issue.id.toString(),
      body: this.mapToDocument(issue)
    });

    await redis.setex(`processed:${event.event_id}`, 86400, '1');
  }
}
```

### Background Job Types

**1. Search Index Sync**
- Triggered by: Issue create/update/delete
- Purpose: Keep Elasticsearch in sync with PostgreSQL
- Latency target: < 500ms from event to searchable

**2. Notification Dispatch**
- Triggered by: Issue assignment, @mentions, watch list updates
- Purpose: Send email and in-app notifications
- Batching: Aggregate rapid changes into single notification (5-second window)

**3. Bulk Operations**
- Triggered by: Admin bulk update requests
- Purpose: Update 100+ issues without blocking UI
- Progress: Stored in Redis, queryable via API

```javascript
async function startBulkOperation(userId, issueIds, updates) {
  const jobId = uuid();

  await redis.hmset(`bulk:${jobId}`, {
    status: 'pending',
    total: issueIds.length,
    processed: 0,
    failed: 0,
    started_at: new Date().toISOString()
  });

  await channel.sendToQueue(
    QUEUES.BULK_OPERATIONS,
    Buffer.from(JSON.stringify({ jobId, userId, issueIds, updates })),
    { persistent: true }
  );

  return jobId;
}

// Poll for progress
async function getBulkOperationStatus(jobId) {
  return redis.hgetall(`bulk:${jobId}`);
}
```

**4. Webhook Delivery**
- Triggered by: Configurable issue events
- Purpose: Notify external systems (CI/CD, Slack, etc.)
- Retry: 5 attempts with exponential backoff (1s, 2s, 4s, 8s, 16s)
- Timeout: 10 seconds per attempt

### Dead Letter Queue Handling

Messages that fail all retries go to a dead letter queue for manual inspection:

```javascript
async function processDLQ() {
  await channel.consume('dlq.search.index', async (msg) => {
    const event = JSON.parse(msg.content.toString());

    // Log for investigation
    logger.error('DLQ message', {
      queue: 'search.index',
      event: event,
      originalError: msg.properties.headers?.['x-first-death-reason']
    });

    // Store in database for admin review
    await db('failed_jobs').insert({
      queue: 'search.index',
      payload: event,
      failed_at: new Date(),
      error: msg.properties.headers?.['x-first-death-reason']
    });

    channel.ack(msg);
  });
}
```

### Local Development Setup

Add to `docker-compose.yml`:
```yaml
services:
  rabbitmq:
    image: rabbitmq:3.12-management
    ports:
      - "5672:5672"   # AMQP
      - "15672:15672" # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: jira
      RABBITMQ_DEFAULT_PASS: jira_dev
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  valkey:
    image: valkey/valkey:7.2
    ports:
      - "6379:6379"
    volumes:
      - valkey_data:/data

volumes:
  rabbitmq_data:
  valkey_data:
```

Environment variables:
```bash
RABBITMQ_URL=amqp://jira:jira_dev@localhost:5672
REDIS_URL=redis://localhost:6379
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Custom fields | JSONB | EAV table | Simplicity, performance |
| Search | Elasticsearch | PostgreSQL FTS | JQL complexity |
| Workflow | DB-driven | Code-driven | Flexibility |
| History | Event table | Event sourcing | Simpler queries |
| Cache strategy | Cache-aside | Write-through | Write latency matters for issue updates |
| Message queue | RabbitMQ | Kafka | Simpler for point-to-point, good enough for fanout |
| Consistency | Strong (PG) + Eventual (ES) | Full eventual | Issue state must be immediately consistent |
| Idempotency | Request-level keys | Operation log | Simpler client integration |

---

## Implementation Notes

This section documents the WHY behind the production-ready features implemented in the backend.

### Idempotency Prevents Duplicate Issues

**Problem**: Webhook integrations, CI/CD pipelines, and mobile apps often retry requests on network failures or timeouts. Without idempotency, these retries create duplicate issues.

**Solution**: The `X-Idempotency-Key` header system (`/backend/src/middleware/idempotency.ts`) stores request responses in Redis with a 24-hour TTL. When a duplicate request arrives:

1. Check Redis for existing response
2. If found, return cached response (replay)
3. If not, process request and cache response

**Why This Matters**:
- **Webhook reliability**: External systems (GitHub, Slack, CI tools) retry on 5xx errors or timeouts
- **Mobile resilience**: Apps on flaky networks may resend requests
- **API consumer safety**: Clients can safely retry without fear of duplicates

**Implementation**:
```typescript
// Request with idempotency key
POST /api/issues
X-Idempotency-Key: a1b2c3d4-e5f6-7890-abcd-ef1234567890

// First request: creates issue, stores response
// Second request (same key): returns cached response immediately
```

### Caching Reduces Load for Frequently Accessed Boards

**Problem**: Board views (Kanban/Scrum) are accessed constantly by team members but require expensive database joins across issues, statuses, users, and sprints.

**Solution**: Cache-aside pattern (`/backend/src/services/projectService.ts`) with tiered TTLs:

| Data Type | TTL | Invalidation Trigger |
|-----------|-----|---------------------|
| Project metadata | 15 min | Project update/delete |
| Board configuration | 5 min | Board edit, issue changes |
| Workflow definitions | 30 min | Workflow edit (rare) |

**Why Cache-Aside (not Write-Through)**:
- Issue data changes frequently; write-through would add latency to every update
- Cache-aside allows brief staleness (acceptable for board views) while keeping writes fast
- Read-heavy workload benefits more from caching reads than optimizing writes

**Metrics Tracked**:
- `jira_cache_hits_total{cache_type="board|project|workflow"}`
- `jira_cache_misses_total{cache_type="board|project|workflow"}`

### Async Queues Enable Reliable Webhook Delivery

**Problem**: Synchronous webhook calls block request processing and fail silently when external services are down. Users expect immediate response when creating issues, not waiting for Slack notifications.

**Solution**: RabbitMQ fanout exchange (`/backend/src/config/messageQueue.ts`) decouples issue events from downstream processing:

```
Issue Created
     │
     ▼
 Fanout Exchange (jira.issue.events.fanout)
     │
     ├──▶ Search Index Queue ──▶ Update Elasticsearch
     ├──▶ Notifications Queue ──▶ Send emails/in-app
     └──▶ Webhooks Queue ──▶ Deliver to external systems
```

**Why This Matters**:
1. **Reliability**: If Elasticsearch is down, issues still get created; indexing happens when ES recovers
2. **Latency**: Issue creation returns immediately; async consumers handle slow operations
3. **Backpressure**: Prefetch limit (10) prevents consumers from being overwhelmed
4. **Retry semantics**: Failed messages retry with exponential backoff, then go to DLQ

**Delivery Guarantees**:
- At-least-once delivery (consumers must be idempotent)
- Event deduplication via `event_id` tracked in Redis
- Dead-letter queue for messages that fail after 3 retries

### Metrics Enable Workflow Optimization

**Problem**: Without observability, teams can't identify bottlenecks (slow searches, transition patterns, cache effectiveness).

**Solution**: Prometheus metrics endpoint (`/metrics`) exposes operational data:

**Issue Lifecycle Metrics**:
```
# Track issue creation by project and type
jira_issues_created_total{project_key="PROJ", issue_type="bug"} 42

# Track workflow transitions
jira_transitions_total{project_key="PROJ", from_status="To Do", to_status="In Progress"} 156
```

**Search Performance Metrics**:
```
# Query counts by type
jira_search_queries_total{query_type="jql|text|quick"}

# Latency histogram (p50, p95, p99)
jira_search_latency_seconds{query_type="jql"}
```

**Why This Matters**:
- **Capacity planning**: Monitor issue creation rate to predict storage needs
- **UX optimization**: High search latency indicates need for query optimization
- **Workflow analysis**: Transition patterns reveal process bottlenecks
- **Cache tuning**: Hit/miss ratios help adjust TTLs

### Structured Logging for Debugging

**Solution**: Pino JSON logger (`/backend/src/config/logger.ts`) provides:

```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "jira-backend",
  "operation": "createIssue",
  "projectId": "abc-123",
  "userId": "user-456",
  "issueId": 789,
  "issueKey": "PROJ-123",
  "msg": "Issue created"
}
```

**Benefits**:
- Machine-parseable for log aggregation (ELK, Datadog)
- Request correlation via operation context
- Environment-aware (pretty-print in dev, JSON in prod)

### Health Check Endpoint

**Endpoint**: `GET /health`

**Response**:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "postgres": { "status": "healthy", "latency_ms": 2 },
    "redis": { "status": "healthy", "latency_ms": 1 },
    "elasticsearch": { "status": "healthy", "latency_ms": 15 }
  }
}
```

**Why**:
- Load balancer health checks route traffic only to healthy instances
- Degraded state (ES down) returns 200 but indicates partial functionality
- Individual latency helps identify slow dependencies
