# Design Notion - Architecture

## System Overview

Notion is a block-based collaborative workspace. Core challenges involve real-time editing, flexible block structures, and hierarchical organization.

**Learning Goals:**
- Implement real-time collaboration (CRDT/OT)
- Design flexible block-based data models
- Build hierarchical permission systems
- Handle offline-first architecture

---

## Requirements

### Functional Requirements

1. **Edit**: Block-based document editing
2. **Collaborate**: Real-time multi-user editing
3. **Organize**: Pages, databases, workspaces
4. **Share**: Granular permissions
5. **Database**: Structured data with views

### Non-Functional Requirements

- **Latency**: < 100ms for local edits
- **Sync**: < 500ms for cross-user sync
- **Offline**: Full editing capability offline
- **Scale**: 10M workspaces, 1B blocks

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│       React + Block Editor + CRDT Runtime + IndexedDB           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                   Sync Server Cluster                           │
│         (Real-time operation broadcast + conflict resolution)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Server                                   │
│         - Workspaces - Pages - Permissions - Search             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │              Elasticsearch                    │
│   - Blocks      │              - Full-text search               │
│   - Pages       │              - Block content                  │
│   - Workspaces  │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Block Data Model

**Block Structure:**
```typescript
interface Block {
  id: string
  type: BlockType
  parentId: string | null
  pageId: string
  properties: Record<string, any>
  content: RichText[]
  children: string[] // Ordered child block IDs
  createdAt: Date
  updatedAt: Date
  createdBy: string
}

type BlockType =
  | 'text'
  | 'heading_1' | 'heading_2' | 'heading_3'
  | 'bulleted_list' | 'numbered_list' | 'toggle'
  | 'code' | 'quote' | 'callout'
  | 'image' | 'video' | 'embed'
  | 'table' | 'database'
```

**Rich Text:**
```typescript
interface RichText {
  text: string
  annotations: {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strikethrough?: boolean
    code?: boolean
    color?: string
  }
  link?: string
}
```

### 2. Real-Time Collaboration

**CRDT Approach (Conflict-Free):**
```typescript
// Each block operation is a CRDT operation
interface Operation {
  id: string
  type: 'insert' | 'delete' | 'update'
  blockId: string
  parentId?: string
  position?: FractionalIndex // For ordering
  properties?: Partial<Block>
  timestamp: HybridLogicalClock
  author: string
}

// Fractional indexing for ordering
// Allows inserting between any two blocks without reindexing
function insertBetween(before: string, after: string): string {
  // Returns a string that sorts between 'before' and 'after'
  // e.g., insertBetween('a', 'b') → 'aU'
}
```

**Sync Protocol:**
```typescript
// Client maintains local operation log
class SyncClient {
  private pendingOps: Operation[] = []
  private confirmedVersion: number = 0

  async applyLocal(op: Operation) {
    // Apply immediately to local state
    this.applyOp(op)
    this.pendingOps.push(op)

    // Send to server
    this.ws.send({ type: 'operation', op })
  }

  handleServerOp(op: Operation) {
    // Apply remote operation, handling conflicts
    if (!this.hasOp(op.id)) {
      this.applyOp(op)
    }
  }

  handleAck(opId: string) {
    this.pendingOps = this.pendingOps.filter(op => op.id !== opId)
  }
}
```

### 3. Page Hierarchy

**Recursive Page Structure:**
```sql
-- Pages can contain other pages
CREATE TABLE pages (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  parent_id UUID REFERENCES pages(id), -- NULL for root pages
  title VARCHAR(500),
  icon VARCHAR(100),
  cover_image VARCHAR(500),
  is_database BOOLEAN DEFAULT FALSE,
  properties_schema JSONB, -- For databases
  created_at TIMESTAMP DEFAULT NOW()
);

-- Blocks belong to pages
CREATE TABLE blocks (
  id UUID PRIMARY KEY,
  page_id UUID REFERENCES pages(id),
  parent_block_id UUID REFERENCES blocks(id), -- NULL for top-level
  type VARCHAR(50) NOT NULL,
  properties JSONB,
  content JSONB, -- Rich text array
  position VARCHAR(100), -- Fractional index
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Database Views

**View Types:**
```typescript
interface DatabaseView {
  id: string
  databaseId: string
  type: 'table' | 'board' | 'list' | 'calendar' | 'gallery'
  name: string
  filter: Filter[]
  sort: Sort[]
  properties: PropertyVisibility[]
}

// Board view groups by a select property
interface BoardView extends DatabaseView {
  type: 'board'
  groupBy: string // Property ID (select type)
}

// Calendar view requires a date property
interface CalendarView extends DatabaseView {
  type: 'calendar'
  dateProperty: string // Property ID (date type)
}
```

---

## Database Schema

```sql
-- Workspaces
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  owner_id UUID REFERENCES users(id),
  settings JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Workspace members
CREATE TABLE workspace_members (
  workspace_id UUID REFERENCES workspaces(id),
  user_id UUID REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'member',
  PRIMARY KEY (workspace_id, user_id)
);

-- Pages (recursive)
CREATE TABLE pages (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  parent_id UUID REFERENCES pages(id),
  title VARCHAR(500) DEFAULT 'Untitled',
  icon VARCHAR(100),
  is_database BOOLEAN DEFAULT FALSE,
  properties_schema JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Blocks
CREATE TABLE blocks (
  id UUID PRIMARY KEY,
  page_id UUID REFERENCES pages(id),
  parent_block_id UUID REFERENCES blocks(id),
  type VARCHAR(50) NOT NULL,
  properties JSONB,
  content JSONB,
  position VARCHAR(100),
  version INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_blocks_page ON blocks(page_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_block_id);
```

---

## Key Design Decisions

### 1. CRDT for Collaboration

**Decision**: Use CRDTs instead of OT for conflict resolution

**Rationale**:
- No central authority needed
- Better offline support
- Deterministic merge
- Simpler server logic

**Trade-off**: Slightly larger operation payloads

### 2. Fractional Indexing for Order

**Decision**: Use string-based fractional indexes for block ordering

**Rationale**:
- Insert between any two blocks
- No reindexing of siblings
- Naturally sortable strings

### 3. Blocks as Core Primitive

**Decision**: Everything is a block (text, images, databases)

**Rationale**:
- Unified data model
- Composable structures
- Consistent editing experience

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync | CRDT | OT | Offline support |
| Ordering | Fractional index | Array index | No reindexing |
| Storage | PostgreSQL | Document DB | Relational queries |
| Real-time | WebSocket | SSE | Bidirectional |

---

## Caching and Edge Strategy

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        CDN (Static Assets)                       │
│           - JS bundles, CSS, images, fonts                       │
│           - TTL: 1 year (versioned filenames)                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Gateway / Load Balancer                 │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ▼                                   ▼
┌───────────────────────┐           ┌───────────────────────┐
│      API Server       │           │     Sync Server       │
└───────────────────────┘           └───────────────────────┘
            │                                   │
            ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Redis/Valkey Cache Cluster                    │
│     - Sessions, Page metadata, Block cache, Presence            │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                         PostgreSQL                               │
└─────────────────────────────────────────────────────────────────┘
```

### Cache Strategy by Data Type

| Data Type | Strategy | TTL | Invalidation |
|-----------|----------|-----|--------------|
| User sessions | Write-through | 24 hours | On logout/password change |
| Page metadata | Cache-aside | 5 minutes | On page update |
| Block content | Cache-aside | 10 minutes | On block operation |
| Workspace members | Cache-aside | 15 minutes | On membership change |
| Search results | Cache-aside | 2 minutes | Time-based expiry only |
| Presence (who is online) | Write-through | 30 seconds | Heartbeat refresh |

### Cache-Aside Pattern (Read-Heavy Data)

Used for page metadata and block content where reads far exceed writes.

```typescript
// Cache key structure
const CACHE_KEYS = {
  page: (pageId: string) => `page:${pageId}`,
  blocks: (pageId: string) => `blocks:${pageId}`,
  workspace: (wsId: string) => `workspace:${wsId}`,
  workspaceMembers: (wsId: string) => `workspace:${wsId}:members`,
};

async function getPageWithBlocks(pageId: string): Promise<PageWithBlocks> {
  const cacheKey = CACHE_KEYS.blocks(pageId);

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: fetch from database
  const page = await db.query(`
    SELECT p.*, json_agg(b ORDER BY b.position) as blocks
    FROM pages p
    LEFT JOIN blocks b ON b.page_id = p.id
    WHERE p.id = $1
    GROUP BY p.id
  `, [pageId]);

  // Store in cache
  await redis.setex(cacheKey, 600, JSON.stringify(page)); // 10 min TTL

  return page;
}
```

### Write-Through Pattern (Critical Data)

Used for sessions and presence where consistency is important.

```typescript
async function updatePresence(userId: string, pageId: string): Promise<void> {
  const presenceKey = `presence:${pageId}`;
  const userData = { userId, lastSeen: Date.now() };

  // Write to cache immediately (source of truth for presence)
  await redis.hset(presenceKey, userId, JSON.stringify(userData));
  await redis.expire(presenceKey, 30); // Auto-expire if no heartbeat

  // Broadcast to other clients on this page
  await redis.publish(`page:${pageId}:presence`, JSON.stringify({
    type: 'presence_update',
    user: userData
  }));
}
```

### Cache Invalidation Rules

**Event-Driven Invalidation:**

```typescript
// Block operations invalidate page cache
async function handleBlockOperation(op: Operation): Promise<void> {
  // Apply operation to database
  await applyToDatabase(op);

  // Invalidate affected caches
  await redis.del(CACHE_KEYS.blocks(op.pageId));

  // If it's a page title change, invalidate parent's child list
  if (op.type === 'update' && op.properties?.title) {
    const page = await db.query('SELECT parent_id FROM pages WHERE id = $1', [op.pageId]);
    if (page.parent_id) {
      await redis.del(CACHE_KEYS.page(page.parent_id));
    }
  }
}

// Membership changes invalidate workspace cache
async function handleMembershipChange(workspaceId: string): Promise<void> {
  await redis.del(CACHE_KEYS.workspaceMembers(workspaceId));
}
```

**Stale-While-Revalidate for Search:**

```typescript
async function searchBlocks(query: string, workspaceId: string): Promise<SearchResult[]> {
  const cacheKey = `search:${workspaceId}:${hashQuery(query)}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    // Return cached immediately, refresh in background
    setImmediate(() => refreshSearchCache(cacheKey, query, workspaceId));
    return JSON.parse(cached);
  }

  return await executeSearchAndCache(cacheKey, query, workspaceId);
}
```

### Local Development Setup

For local development, use a single Valkey instance:

```yaml
# docker-compose.yml addition
services:
  valkey:
    image: valkey/valkey:7.2
    ports:
      - "6379:6379"
    volumes:
      - valkey_data:/data
    command: valkey-server --appendonly yes

volumes:
  valkey_data:
```

Environment configuration:

```bash
REDIS_URL=redis://localhost:6379
CACHE_TTL_PAGE=300          # 5 minutes for page metadata
CACHE_TTL_BLOCKS=600        # 10 minutes for block content
CACHE_TTL_SESSION=86400     # 24 hours for sessions
```

---

## Async Queue and Background Jobs

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Producers                                │
│    API Server | Sync Server | Scheduled Tasks (cron)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RabbitMQ Exchange                           │
│            (Topic exchange for flexible routing)                 │
├─────────────────────────────────────────────────────────────────┤
│                         Queues                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │   fanout     │ │   search     │ │   export     │            │
│  │  (presence,  │ │  (index      │ │  (PDF,       │            │
│  │   realtime)  │ │   updates)   │ │   Markdown)  │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │  webhooks    │ │   cleanup    │ │   email      │            │
│  │  (external   │ │  (stale      │ │  (invites,   │            │
│  │   notify)    │ │   sessions)  │ │   shares)    │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Consumers                                │
│    Worker processes (can scale independently per queue)          │
└─────────────────────────────────────────────────────────────────┘
```

### Queue Definitions

```typescript
// Queue configuration with delivery semantics
const QUEUES = {
  // High priority, low latency - presence and realtime fanout
  fanout: {
    name: 'notion.fanout',
    durable: true,
    prefetch: 50,        // Process many at once
    ttl: 30_000,         // Messages expire after 30s (stale presence is useless)
    retries: 0,          // No retries - fanout is best-effort
    deadLetter: false,
  },

  // Medium priority - search index updates
  search: {
    name: 'notion.search',
    durable: true,
    prefetch: 10,
    ttl: 3600_000,       // 1 hour
    retries: 3,
    deadLetter: 'notion.search.dlq',
  },

  // Low priority, high reliability - exports
  export: {
    name: 'notion.export',
    durable: true,
    prefetch: 2,         // Resource-intensive
    ttl: 86400_000,      // 24 hours
    retries: 5,
    deadLetter: 'notion.export.dlq',
  },

  // External integrations
  webhooks: {
    name: 'notion.webhooks',
    durable: true,
    prefetch: 5,
    ttl: 3600_000,
    retries: 5,          // External services may be temporarily down
    deadLetter: 'notion.webhooks.dlq',
  },

  // Background maintenance
  cleanup: {
    name: 'notion.cleanup',
    durable: true,
    prefetch: 1,
    ttl: null,           // No expiry
    retries: 3,
    deadLetter: 'notion.cleanup.dlq',
  },

  // Transactional email
  email: {
    name: 'notion.email',
    durable: true,
    prefetch: 10,
    ttl: 86400_000,
    retries: 3,
    deadLetter: 'notion.email.dlq',
  },
};
```

### Message Types and Handlers

```typescript
// Fanout messages - broadcast to connected clients
interface FanoutMessage {
  type: 'operation' | 'presence' | 'cursor';
  pageId: string;
  excludeConnectionId?: string; // Don't send back to originator
  payload: any;
}

// Search index updates - eventual consistency with Elasticsearch
interface SearchIndexMessage {
  type: 'index_block' | 'delete_block' | 'reindex_page';
  blockId?: string;
  pageId: string;
  content?: string;
  workspaceId: string;
}

// Export jobs - long-running tasks
interface ExportMessage {
  type: 'pdf' | 'markdown' | 'html';
  pageId: string;
  userId: string;
  options: {
    includeSubpages: boolean;
    includeImages: boolean;
  };
  callbackUrl?: string;
}
```

### Consumer Implementation with Backpressure

```typescript
import amqp from 'amqplib';

class QueueConsumer {
  private channel: amqp.Channel;
  private processing = 0;
  private maxConcurrent: number;

  constructor(queueConfig: typeof QUEUES[keyof typeof QUEUES]) {
    this.maxConcurrent = queueConfig.prefetch;
  }

  async start(handler: (msg: any) => Promise<void>): Promise<void> {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    this.channel = await connection.createChannel();

    // Prefetch limits in-flight messages (backpressure)
    await this.channel.prefetch(this.maxConcurrent);

    await this.channel.consume(this.queueConfig.name, async (msg) => {
      if (!msg) return;

      this.processing++;
      const startTime = Date.now();

      try {
        const content = JSON.parse(msg.content.toString());
        await handler(content);
        this.channel.ack(msg);

        metrics.recordJobDuration(this.queueConfig.name, Date.now() - startTime);
        metrics.incrementJobSuccess(this.queueConfig.name);

      } catch (error) {
        const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) + 1;

        if (retryCount <= this.queueConfig.retries) {
          // Requeue with exponential backoff
          await this.requeueWithDelay(msg, retryCount);
        } else {
          // Send to dead letter queue
          if (this.queueConfig.deadLetter) {
            await this.sendToDeadLetter(msg, error);
          }
          this.channel.ack(msg); // Remove from main queue
        }

        metrics.incrementJobFailure(this.queueConfig.name);
      } finally {
        this.processing--;
      }
    });
  }

  private async requeueWithDelay(msg: amqp.Message, retryCount: number): Promise<void> {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 60000); // Max 1 minute

    // Use delayed message exchange or scheduled requeue
    setTimeout(() => {
      this.channel.publish('', this.queueConfig.name, msg.content, {
        headers: { 'x-retry-count': retryCount }
      });
      this.channel.ack(msg);
    }, delay);
  }
}
```

### Delivery Semantics

| Queue | Semantics | Rationale |
|-------|-----------|-----------|
| fanout | At-most-once | Stale presence/cursor data is worse than missing it |
| search | At-least-once | Duplicate index updates are idempotent |
| export | Exactly-once* | Use idempotency key to prevent duplicate exports |
| webhooks | At-least-once | External systems should handle duplicates |
| cleanup | At-least-once | Cleanup operations are idempotent |
| email | At-least-once | Email providers dedupe by message-id |

*Exactly-once achieved via idempotency keys stored in Redis with TTL matching job TTL.

### Local Development Setup

```yaml
# docker-compose.yml addition
services:
  rabbitmq:
    image: rabbitmq:3.12-management
    ports:
      - "5672:5672"    # AMQP
      - "15672:15672"  # Management UI
    environment:
      RABBITMQ_DEFAULT_USER: notion
      RABBITMQ_DEFAULT_PASS: notion_local
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

volumes:
  rabbitmq_data:
```

Environment configuration:

```bash
RABBITMQ_URL=amqp://notion:notion_local@localhost:5672
QUEUE_PREFETCH_DEFAULT=10
QUEUE_RETRY_MAX=3
```

### Running Workers Locally

```bash
# Run all workers in development
npm run dev:workers

# Or run specific workers
npm run dev:worker:search
npm run dev:worker:export
npm run dev:worker:email
```

---

## Observability

### Three Pillars Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Observability Stack                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐           │
│  │   Metrics   │   │    Logs     │   │   Traces    │           │
│  │ (Prometheus)│   │ (Structured │   │  (OpenTel   │           │
│  │             │   │    JSON)    │   │   /Jaeger)  │           │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘           │
│         │                 │                 │                   │
│         └────────────┬────┴────────────────┘                   │
│                      ▼                                          │
│            ┌─────────────────┐                                  │
│            │     Grafana     │                                  │
│            │   (Dashboards)  │                                  │
│            └─────────────────┘                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Metrics (Prometheus)

**Application Metrics:**

```typescript
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const registry = new Registry();

// Request latency by endpoint
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// WebSocket connections
const wsConnectionsGauge = new Gauge({
  name: 'websocket_connections_total',
  help: 'Current number of WebSocket connections',
  labelNames: ['server_id'],
  registers: [registry],
});

// Operations processed
const operationsCounter = new Counter({
  name: 'crdt_operations_total',
  help: 'Total CRDT operations processed',
  labelNames: ['type', 'status'], // type: insert/update/delete, status: success/conflict/error
  registers: [registry],
});

// Queue depth
const queueDepthGauge = new Gauge({
  name: 'rabbitmq_queue_depth',
  help: 'Current messages in queue',
  labelNames: ['queue_name'],
  registers: [registry],
});

// Cache hit rate
const cacheHitsCounter = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hit count',
  labelNames: ['cache_type'], // page, blocks, session, search
  registers: [registry],
});

const cacheMissesCounter = new Counter({
  name: 'cache_misses_total',
  help: 'Cache miss count',
  labelNames: ['cache_type'],
  registers: [registry],
});
```

**SLI Definitions:**

| SLI | Metric | Target | Alert Threshold |
|-----|--------|--------|-----------------|
| API Availability | `sum(rate(http_requests{status!~"5.."}[5m])) / sum(rate(http_requests[5m]))` | 99.9% | < 99.5% for 5min |
| API Latency (p95) | `histogram_quantile(0.95, http_request_duration_seconds)` | < 200ms | > 500ms for 5min |
| Sync Latency (p95) | `histogram_quantile(0.95, operation_sync_duration_seconds)` | < 500ms | > 1s for 5min |
| WebSocket Availability | `websocket_connections_total > 0` per server | 100% | Any server at 0 for 1min |
| Queue Lag | `rabbitmq_queue_depth{queue="search"}` | < 1000 | > 5000 for 10min |
| Cache Hit Rate | `cache_hits / (cache_hits + cache_misses)` | > 80% | < 60% for 15min |

### Structured Logging

```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: 'notion-api',
    version: process.env.APP_VERSION,
    environment: process.env.NODE_ENV,
  },
});

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = Date.now();

  // Attach logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
  });

  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime,
      contentLength: res.get('content-length'),
    }, 'request completed');
  });

  next();
});

// Operation logging
function logOperation(op: Operation, context: { pageId: string; userId: string }) {
  logger.info({
    event: 'crdt_operation',
    operationId: op.id,
    operationType: op.type,
    blockId: op.blockId,
    pageId: context.pageId,
    userId: context.userId,
    timestamp: op.timestamp,
  }, 'operation applied');
}
```

**Log Levels by Event Type:**

| Event | Level | Example |
|-------|-------|---------|
| Request completed | info | HTTP request with timing |
| Operation applied | info | CRDT operation processed |
| Cache miss | debug | Cache key not found |
| Conflict resolved | warn | CRDT merge required |
| Queue full | warn | Backpressure triggered |
| Database error | error | Query failed |
| Unhandled exception | error | Crash with stack trace |

### Distributed Tracing

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

// Initialize tracing
const sdk = new NodeSDK({
  serviceName: 'notion-api',
  traceExporter: new JaegerExporter({
    endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
  }),
});
sdk.start();

const tracer = trace.getTracer('notion-api');

// Trace a page load with all sub-operations
async function getPageWithTracing(pageId: string): Promise<Page> {
  return tracer.startActiveSpan('getPage', async (span) => {
    try {
      span.setAttribute('page.id', pageId);

      // Cache lookup span
      const cached = await tracer.startActiveSpan('cache.get', async (cacheSpan) => {
        const result = await redis.get(`page:${pageId}`);
        cacheSpan.setAttribute('cache.hit', !!result);
        cacheSpan.end();
        return result;
      });

      if (cached) {
        span.setAttribute('cache.hit', true);
        span.end();
        return JSON.parse(cached);
      }

      // Database query span
      const page = await tracer.startActiveSpan('db.query', async (dbSpan) => {
        dbSpan.setAttribute('db.statement', 'SELECT page with blocks');
        const result = await db.query('SELECT ...');
        dbSpan.setAttribute('db.rows_affected', result.rowCount);
        dbSpan.end();
        return result;
      });

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return page;

    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      span.end();
      throw error;
    }
  });
}
```

### Audit Logging

Security-relevant events logged separately for compliance and debugging.

```typescript
interface AuditEvent {
  timestamp: string;
  eventType: string;
  userId: string;
  resourceType: 'page' | 'workspace' | 'block' | 'user';
  resourceId: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'share' | 'export';
  metadata: Record<string, any>;
  ipAddress: string;
  userAgent: string;
}

class AuditLogger {
  async log(event: Omit<AuditEvent, 'timestamp'>): Promise<void> {
    const auditRecord: AuditEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    // Write to dedicated audit table (append-only)
    await db.query(`
      INSERT INTO audit_log (timestamp, event_type, user_id, resource_type,
                             resource_id, action, metadata, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      auditRecord.timestamp,
      auditRecord.eventType,
      auditRecord.userId,
      auditRecord.resourceType,
      auditRecord.resourceId,
      auditRecord.action,
      JSON.stringify(auditRecord.metadata),
      auditRecord.ipAddress,
      auditRecord.userAgent,
    ]);

    // Also log to structured logs for real-time alerting
    logger.info({ audit: auditRecord }, 'audit event');
  }
}

// Audit log table schema
/*
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  user_id UUID NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id, timestamp DESC);
CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
*/
```

**Audit Events to Capture:**

| Event | Trigger | Metadata |
|-------|---------|----------|
| page.created | New page created | parentId, title |
| page.shared | Page permissions changed | shareType, recipientId |
| page.exported | Page exported | format, includeSubpages |
| workspace.member_added | User joined workspace | role, invitedBy |
| workspace.member_removed | User removed from workspace | removedBy, reason |
| user.login | Successful authentication | method (password/oauth) |
| user.login_failed | Failed authentication | reason, attemptCount |
| block.deleted | Block permanently deleted | blockType, pageId |

### Grafana Dashboards

**Dashboard 1: API Health**
- Request rate by endpoint (line chart)
- p50/p95/p99 latency (line chart with thresholds)
- Error rate by status code (stacked bar)
- Active WebSocket connections (gauge)

**Dashboard 2: Real-Time Sync**
- Operations per second by type (line chart)
- Sync latency distribution (heatmap)
- Conflict rate (counter with alert)
- Connected users per page (table)

**Dashboard 3: Background Jobs**
- Queue depth by queue (line chart)
- Job processing rate (line chart)
- Job failure rate (line chart with alert)
- Dead letter queue size (gauge with alert)

**Dashboard 4: Cache Performance**
- Hit rate by cache type (line chart)
- Eviction rate (line chart)
- Memory usage (gauge)
- Key count (gauge)

### Local Development Setup

```yaml
# docker-compose.yml additions
services:
  prometheus:
    image: prom/prometheus:v2.47.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus

  grafana:
    image: grafana/grafana:10.2.0
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./grafana/datasources:/etc/grafana/provisioning/datasources

  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"  # UI
      - "14268:14268"  # HTTP collector

volumes:
  prometheus_data:
  grafana_data:
```

**prometheus.yml:**

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'notion-api'
    static_configs:
      - targets: ['host.docker.internal:3000']
    metrics_path: /metrics

  - job_name: 'notion-sync'
    static_configs:
      - targets: ['host.docker.internal:3002']
    metrics_path: /metrics
```

### Alert Rules

```yaml
# alerts.yml (Prometheus alerting rules)
groups:
  - name: notion-alerts
    rules:
      - alert: HighErrorRate
        expr: sum(rate(http_requests_total{status_code=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Error rate above 1%"

      - alert: HighLatency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p95 latency above 500ms"

      - alert: QueueBacklog
        expr: rabbitmq_queue_depth{queue="search"} > 5000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Search queue backlog growing"

      - alert: LowCacheHitRate
        expr: sum(rate(cache_hits_total[15m])) / (sum(rate(cache_hits_total[15m])) + sum(rate(cache_misses_total[15m]))) < 0.6
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 60%"

      - alert: DeadLetterQueueGrowing
        expr: rabbitmq_queue_depth{queue=~".*\\.dlq"} > 100
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Dead letter queue has unprocessed messages"
```
