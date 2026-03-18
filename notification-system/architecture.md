# Design Notification System - Architecture

## System Overview

A high-throughput notification system delivering messages across multiple channels (push, email, SMS, in-app) with reliability guarantees and user preference handling. Core challenges involve message routing, delivery guarantees, and scale.

**Learning Goals:**
- Build multi-channel message routing
- Design priority-based queue processing
- Implement delivery tracking and retries
- Handle user preferences at scale

---

## Requirements

### Functional Requirements

1. **Send**: Deliver notifications across channels (push, email, SMS, in-app)
2. **Priority**: Process critical messages before normal/low priority
3. **Preferences**: Respect user notification settings and quiet hours
4. **Track**: Monitor delivery status per channel with event history
5. **Template**: Support dynamic content templates with variable substitution
6. **Campaign**: Admin-initiated bulk notifications with audience targeting

### Non-Functional Requirements

- **Throughput**: 1M+ notifications per minute at peak
- **Latency**: < 100ms for critical notifications end-to-end
- **Reliability**: 99.99% delivery rate with at-least-once semantics
- **Availability**: 99.95% uptime (< 26 minutes downtime/month)
- **Ordering**: Best-effort ordering within priority tier

---

## Capacity Estimation

### Production Scale

| Metric | Value | Rationale |
|--------|-------|-----------|
| Daily notifications | 500M | 1M/min peak x 60% duty cycle |
| Unique users | 100M | Active user base |
| Average channels per notification | 1.5 | Most go to push + email |
| Daily delivery attempts | 750M | 500M x 1.5 channels |
| Template renders/second | 17K | 1M/min / 60 |
| Preference lookups/second | 17K | One per notification |

### Storage Growth

| Component | Size/Day | 30-Day Total | Retention |
|-----------|----------|--------------|-----------|
| Notifications table | 10 GB | 300 GB | 90 days, then archive |
| Delivery status | 5 GB | 150 GB | 90 days |
| Events (opens/clicks) | 2 GB | 60 GB | 30 days |
| Templates + preferences | Negligible | ~1 GB | Indefinite |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          API Gateway / LB                            │
│              (Rate limiting, auth, request routing)                   │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Notification Service                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │   Validation    │  │   Preferences   │  │    Routing      │     │
│  │                 │  │                 │  │                 │     │
│  │ - Schema check  │  │ - User prefs    │  │ - Channel split │     │
│  │ - Rate limit    │  │ - Quiet hours   │  │ - Priority sort │     │
│  │ - Idempotency   │  │ - Category opt  │  │ - Template      │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
                                │
           ┌────────────────────┼────────────────────┐
           ▼                    ▼                    ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  RabbitMQ Queue  │    │  RabbitMQ Queue  │    │  RabbitMQ Queue  │
│  push.critical   │    │  email.critical  │    │  sms.critical    │
│  push.normal     │    │  email.normal    │    │  sms.normal      │
│  push.low        │    │  email.low       │    │  sms.low         │
└─────────────────┘    └─────────────────┘    └─────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Push Workers    │    │  Email Workers   │    │  SMS Workers     │
│  (N instances)   │    │  (N instances)   │    │  (N instances)   │
│                  │    │                  │    │                  │
│  - APNs / FCM    │    │  - SMTP/SES      │    │  - Twilio        │
│  - Circuit break │    │  - SendGrid      │    │  - Rate limit    │
│  - Retry logic   │    │  - Retry logic   │    │  - Retry logic   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
           │                    │                    │
           └────────────────────┼────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Delivery Tracking Service                       │
│         (Status updates, receipts, analytics, DLQ monitoring)        │
└──────────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
     │  PostgreSQL   │  │    Redis     │   │  Prometheus  │
     │  (Primary DB) │  │  (Cache +   │   │  + Grafana   │
     │               │  │   Sessions) │   │              │
     └──────────────┘  └──────────────┘   └──────────────┘
```

### Request Flow: Send Notification

```
1. Client sends POST /api/v1/notifications with idempotency key
2. API checks idempotency key in Redis → if exists, return cached result
3. Validate request schema, check rate limits (per-user + global)
4. Load user preferences from Redis cache (5-min TTL) or PostgreSQL
5. Filter channels based on preferences, check quiet hours
6. Render notification template with dynamic variables
7. Store notification record in PostgreSQL (status: pending)
8. For each allowed channel:
   a. Publish to RabbitMQ priority queue (e.g., push.critical)
   b. Create delivery_status record (status: queued)
9. Cache idempotency result in Redis (24h TTL)
10. Return notification ID + queued channels to client
```

### Request Flow: Worker Processing

```
1. Worker consumes from RabbitMQ (critical queue first, then normal, then low)
2. Check circuit breaker state for channel provider
   - If OPEN: reject immediately, requeue with delay
3. Attempt delivery via provider (APNs, SendGrid, Twilio)
4. On success:
   a. ACK message in RabbitMQ
   b. Update delivery_status to 'sent'
   c. Increment Prometheus counter
5. On transient failure:
   a. NACK with requeue, increment retry counter
   b. After max retries: route to dead letter exchange
6. On permanent failure (invalid token, bounced email):
   a. ACK message, update status to 'failed'
   b. Deregister invalid device tokens
```

---

## Core Components

### 1. Notification Service

Orchestrates the notification lifecycle: validation, preference filtering, template rendering, and routing to channel-specific queues.

**Key responsibilities:**
- Idempotency key checking and caching
- Rate limit enforcement (per-user and global)
- User preference loading with Redis cache-aside
- Template rendering with variable substitution
- Multi-channel routing with priority assignment

### 2. Priority Queue System

Separate RabbitMQ queues per channel and priority level. Workers consume from critical queues first, ensuring time-sensitive notifications (2FA codes, payment confirmations) are processed before marketing messages.

**Queue naming convention:** `notifications.{channel}.{priority}`

**Priority levels:**
- `critical`: 2FA, security alerts, payment confirmations
- `high`: Direct messages, order updates
- `normal`: Social notifications, recommendations
- `low`: Marketing, digests, newsletters

### 3. Channel Workers

Dedicated worker pools per channel, each with its own circuit breaker and retry logic. Workers are stateless and horizontally scalable.

**Push worker**: Sends to APNs (iOS) and FCM (Android), handles device token lifecycle (deregistration on invalid tokens).

**Email worker**: Renders HTML/text templates, sends via SMTP provider (SendGrid/SES), includes unsubscribe headers and tracking pixels.

**SMS worker**: Sends via Twilio/carrier APIs with aggressive rate limiting to respect carrier throughput limits.

### 4. Delivery Tracking

Tracks per-channel delivery status and aggregates to overall notification status. Records events (opens, clicks) for analytics. Monitors dead letter queue depth and alerts on growth.

### 5. Preference Service

Manages user notification preferences (enabled channels, category opt-outs, quiet hours) with Redis caching (5-minute TTL). Invalidates cache on preference updates.

### 6. Rate Limiter

Multi-level rate limiting using Redis atomic counters:

| Level | Push | Email | SMS |
|-------|------|-------|-----|
| Per user | 50/hour | 10/hour | 5/hour |
| Per service | 10K/min | 1K/min | 100/min |
| Global | 100K/min | 10K/min | 1K/min |

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(255) NOT NULL,
  email_verified BOOLEAN DEFAULT false,
  phone_verified BOOLEAN DEFAULT false,
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id VARCHAR(100),
  content JSONB NOT NULL,
  channels TEXT[] NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at) WHERE status = 'scheduled';

-- Delivery status per channel
CREATE TABLE IF NOT EXISTS delivery_status (
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  details JSONB DEFAULT '{}',
  attempts INTEGER DEFAULT 1,
  next_retry_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_status(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_delivery_retry ON delivery_status(next_retry_at) WHERE status = 'pending';

-- User preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channels JSONB DEFAULT '{"push": {"enabled": true}, "email": {"enabled": true}, "sms": {"enabled": false}}',
  categories JSONB DEFAULT '{}',
  quiet_hours_start INTEGER, -- minutes from midnight
  quiet_hours_end INTEGER,
  timezone VARCHAR(50) DEFAULT 'UTC',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Device tokens
CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL, -- ios, android, web
  token TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id) WHERE active = true;

-- Notification events (opens, clicks)
CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  channel VARCHAR(20),
  event_type VARCHAR(20),
  metadata JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_notification ON notification_events(notification_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON notification_events(occurred_at);

-- Templates
CREATE TABLE IF NOT EXISTS notification_templates (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200),
  description TEXT,
  channels JSONB NOT NULL,
  variables TEXT[],
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  template_id VARCHAR(100) REFERENCES notification_templates(id),
  target_audience JSONB,
  channels TEXT[],
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'draft',
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- Campaign statistics
CREATE TABLE IF NOT EXISTS campaign_stats (
  campaign_id UUID PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  total_sent INTEGER DEFAULT 0,
  total_delivered INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  total_failed INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

---

## API Design

### Core Endpoints

```
# Authentication
POST   /api/v1/auth/register        → Create user account
POST   /api/v1/auth/login           → Login, returns session token
POST   /api/v1/auth/logout          → Invalidate session

# Notifications
POST   /api/v1/notifications        → Send notification (with idempotency key)
GET    /api/v1/notifications        → List user's notifications
GET    /api/v1/notifications/:id    → Get notification status + delivery details

# Preferences
GET    /api/v1/preferences          → Get user notification preferences
PUT    /api/v1/preferences          → Update preferences (invalidates cache)

# Templates (admin)
GET    /api/v1/templates            → List notification templates
POST   /api/v1/templates            → Create template
PUT    /api/v1/templates/:id        → Update template

# Campaigns (admin)
GET    /api/v1/campaigns            → List campaigns
POST   /api/v1/campaigns            → Create campaign
POST   /api/v1/campaigns/:id/launch → Launch campaign

# Admin
GET    /api/v1/admin/stats          → Delivery statistics
GET    /api/v1/admin/queues         → Queue depth per channel/priority
```

---

## Key Design Decisions

### Priority Queues: Separate Queues vs Sorted Sets

**Chosen: Separate RabbitMQ queues per channel and priority level.**

At 1M notifications/minute, a single sorted set per channel becomes a bottleneck. Redis ZPOPMIN is O(log N) per pop, and with 100K+ items in the set, contention on a single key creates hot-spot issues. Separate queues allow workers to consume from the critical queue first and fall through to normal/low queues only when higher-priority queues are empty. Each queue can be independently monitored, and RabbitMQ provides built-in dead letter exchange support, durable persistence, and consumer acknowledgment.

The trade-off is operational complexity: 9 queues (3 channels x 3 priorities) instead of 3 sorted sets. But RabbitMQ's management UI makes monitoring straightforward, and the isolation prevents a flood of low-priority marketing notifications from delaying critical 2FA messages.

### At-Least-Once vs Exactly-Once Delivery

**Chosen: At-least-once delivery with client-side idempotency.**

Exactly-once delivery across distributed systems requires distributed transactions or two-phase commit between the message queue and the downstream provider (APNs, SendGrid, Twilio). This adds significant latency and complexity, and downstream providers do not support transactional semantics anyway. At-least-once is achieved simply by ACK-after-delivery: the worker only acknowledges the RabbitMQ message after the provider confirms delivery.

The cost is potential duplicates. We mitigate this with idempotency keys at the API layer (preventing duplicate sends from clients) and provider-level deduplication (APNs collapse IDs, SendGrid message IDs). For the rare case where a duplicate reaches the user, push notifications overwrite previous ones and email duplicates are a minor annoyance. Users strongly prefer receiving a duplicate over missing a critical notification.

### Preference Caching: 5-Minute TTL

**Chosen: Redis cache-aside with 5-minute TTL, explicit invalidation on update.**

At 17K preference lookups/second, hitting PostgreSQL for every notification would require a large connection pool and aggressive read replicas. A 5-minute cache reduces database load by 99.7% (only ~3 misses per user per 15-minute window). The staleness risk is acceptable: if a user disables email notifications, the worst case is receiving 1-2 more emails before the cache expires. Cache invalidation on preference update (via `DEL prefs:{userId}`) handles the common case of immediate effect after a settings change.

The alternative of longer TTLs (1 hour) would further reduce load but create user-visible lag when toggling preferences. The alternative of no caching is not viable at production scale.

---

## Consistency and Idempotency

### Idempotency Keys

All notification sends accept a client-provided idempotency key via the `Idempotency-Key` header. The key is stored in Redis with a 24-hour TTL. On duplicate requests, the cached response is returned immediately.

**Key format:** `{service-name}:{entity-id}:{action}:{timestamp}`

**Processing states:**
1. Key not found → process notification, store result
2. Key found, status "processing" → return 409 Conflict (concurrent duplicate)
3. Key found, status "completed" → return cached result

### Delivery Status Consistency

Delivery status uses INSERT ... ON CONFLICT DO UPDATE for idempotent status writes. The aggregate notification status is computed from individual channel statuses:

- All channels sent → `delivered`
- All channels failed → `failed`
- Any channel pending → `partial`
- Mix of sent and failed → `partial_success`

---

## Security

### Authentication

Session-based authentication with Redis backing. Sessions are stored with 24-hour TTL. Passwords hashed with bcrypt (cost factor 12).

### Role-Based Access Control (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Send notifications to self, manage own preferences, view own delivery status |
| `service` | Send notifications to any user, access bulk endpoints, view aggregate stats |
| `admin` | All permissions plus: manage templates, configure rate limits, manage campaigns |

### Rate Limiting

Redis-backed sliding window counters with per-user and global limits. Different thresholds per role (users get conservative limits, services get higher throughput, admins bypass per-user limits).

---

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `notifications_sent_total` | Counter | channel, priority, status | Throughput monitoring |
| `delivery_attempts_total` | Counter | channel, success/failure | Provider reliability |
| `processing_duration_seconds` | Histogram | channel | Latency percentiles |
| `http_request_duration_seconds` | Histogram | method, route, status | API latency |
| `queue_depth` | Gauge | queue, priority | Backpressure detection |
| `circuit_breaker_state` | Gauge | channel | Provider health (0=closed, 1=open, 2=half-open) |
| `rate_limited_total` | Counter | level | Rate limit effectiveness |
| `active_connections` | Gauge | type | Connection tracking |

### Structured Logging

JSON-formatted logs via Pino with consistent fields: timestamp, level, service name, request ID, user ID. Child loggers per component for tracing. Sensitive field redaction (authorization headers, tokens).

### Health Checks

| Endpoint | Purpose | Checks | Response Time |
|----------|---------|--------|---------------|
| `/health/live` | Liveness probe | Process running | < 1ms |
| `/health/ready` | Readiness probe | PostgreSQL, Redis connectivity | < 100ms |
| `/health` | Full health | All above + RabbitMQ + circuit breaker states | < 500ms |

---

## Failure Handling

### Circuit Breaker Pattern

Per-channel circuit breakers protect against provider outages. Each delivery channel (push, email, SMS) gets its own breaker to prevent a single provider failure from affecting other channels.

**States:**
- **Closed** (normal): Requests flow through
- **Open** (after threshold failures): Requests rejected immediately for 30-60s
- **Half-open** (testing): Allow a few requests to test recovery

**Configuration per channel:**

| Channel | Failure Threshold | Reset Timeout | Rationale |
|---------|-------------------|---------------|-----------|
| Push | 5 consecutive | 30s | APNs/FCM are reliable, brief outages |
| Email | 3 consecutive | 60s | SMTP more sensitive to load |
| SMS | 3 consecutive | 60s | Carrier APIs rate-limit aggressively |

### Retry Strategy

Exponential backoff with jitter prevents thundering herd on provider recovery:

| Attempt | Base Delay | With Jitter | Cumulative |
|---------|------------|-------------|------------|
| 1 | 1s | 1.0-1.1s | ~1s |
| 2 | 2s | 2.0-2.2s | ~3s |
| 3 | 4s | 4.0-4.4s | ~7s |
| 4 | 8s | 8.0-8.8s | ~15s |
| 5 | 16s | 16.0-17.6s | ~32s |

Only transient errors are retried (429, 5xx, ECONNRESET, ETIMEDOUT). Permanent failures (invalid tokens, hard bounces) go directly to failed status.

### Dead Letter Queue

After max retries, messages route to the dead letter exchange. DLQ is monitored with alerts on depth > 100. Manual reprocessing is available via admin API.

### Graceful Degradation

| Component Failure | Degraded Behavior |
|-------------------|-------------------|
| Redis unavailable | Sessions fail (require re-login), preferences fetched from DB, no rate limiting |
| RabbitMQ unavailable | API returns 503, notifications queued in-memory (bounded buffer) |
| PostgreSQL unavailable | Full outage (primary data store) |
| Push provider down | Circuit opens, push notifications queued for retry |
| Email provider down | Circuit opens, emails queued for retry |

### Graceful Shutdown

SIGTERM/SIGINT handlers stop accepting new connections, wait for in-flight requests to complete, close database and Redis connections cleanly, with a 30-second timeout for forced shutdown.

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless, scale behind load balancer. Session data in Redis, no local state.
2. **Workers**: Add more consumer instances per channel. RabbitMQ distributes messages across consumers.
3. **PostgreSQL**: Read replicas for notification status queries. Partition notifications table by month for write throughput.
4. **Redis**: Redis Cluster for cache sharding when exceeding single-node memory.
5. **RabbitMQ**: Cluster with quorum queues for high availability.

### Database Partitioning

Notifications table partitioned by `created_at` (monthly). Old partitions archived or dropped based on retention policy (90 days active, then archive).

### What Breaks First

At 10x current scale (10M notifications/min):
- **Queue depth**: Workers must scale proportionally. Auto-scaling based on queue depth metrics.
- **Database writes**: Batch inserts and partition pruning become critical. Consider moving delivery events to a time-series database.
- **Redis memory**: Preference cache grows linearly with user count. Cluster sharding at ~10GB.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Message queue | RabbitMQ | Kafka | Built-in DLX, simpler consumer model |
| Delivery semantics | At-least-once | Exactly-once | Reliability over deduplication complexity |
| Rate limiting | Per-user + global | Per-user only | Protects downstream providers |
| Preference cache | 5-min TTL | Real-time lookup | 99.7% DB load reduction |
| Auth | Session + RBAC | JWT tokens | Immediate revocation, simpler for learning |
| Retry strategy | Exponential backoff | Fixed interval | Prevents thundering herd |
| Circuit breaker | Per-channel | Global | Isolates provider failures |
| Idempotency store | Redis (24h TTL) | PostgreSQL | Low latency, automatic cleanup |
| Logging | Pino structured JSON | Console.log | Machine-parseable, queryable |
| Metrics | Prometheus | Custom tracking | Industry standard, Grafana-compatible |

---

## Implementation Notes

This section maps the production architecture to the actual local implementation running on Docker + Node.js + Express.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (Vite)                        │
│                  localhost:5173                           │
│  Routes: / (inbox), /preferences, /admin, /login         │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP
                            ▼
┌──────────────────────────────────────────────────────────┐
│              API Server (Express)                         │
│           localhost:3001 / 3002 / 3003                    │
│                                                          │
│  /api/v1/auth/*          Auth routes                     │
│  /api/v1/notifications/* Notification CRUD               │
│  /api/v1/preferences/*   User preferences                │
│  /api/v1/templates/*     Template management             │
│  /api/v1/campaigns/*     Campaign management             │
│  /api/v1/admin/*         Admin dashboard stats           │
│  /health, /health/live, /health/ready                    │
│  /metrics                Prometheus endpoint             │
└─────┬──────────┬──────────┬──────────────────────────────┘
      │          │          │
      ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────────────────┐
│PostgreSQL│ │  Valkey   │ │     RabbitMQ          │
│  :5432   │ │  :6379   │ │  :5672 (AMQP)         │
│          │ │          │ │  :15672 (Management)   │
└──────────┘ └──────────┘ └──────────┬────────────┘
                                     │
                                     ▼
                          ┌──────────────────────┐
                          │   Channel Workers     │
                          │  (tsx watch)          │
                          │                      │
                          │  Push  (simulated)   │
                          │  Email (simulated)   │
                          │  SMS   (simulated)   │
                          └──────────────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | File | Description |
|---------|------|-------------|
| Structured logging | `backend/src/utils/logger.ts` | Pino-based JSON logging, child loggers per component, request correlation IDs, sensitive field redaction |
| Prometheus metrics | `backend/src/utils/metrics.ts` | Counters, histograms, gauges for notifications sent, delivery attempts, queue depth, circuit breaker state |
| Circuit breakers | `backend/src/utils/circuitBreaker.ts` | Per-channel circuit breakers via Cockatiel library, state exposed via Prometheus gauge |
| Idempotency | `backend/src/utils/idempotency.ts` | Redis-backed idempotency keys with 24h TTL, concurrent duplicate detection (409 Conflict) |
| Retry with backoff | `backend/src/utils/retry.ts` | Exponential backoff with jitter, configurable presets (fast/standard/slow/aggressive) |
| Health checks | `backend/src/index.ts` | Three-tier: `/health/live`, `/health/ready`, `/health` with component status + circuit breaker states |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handlers, drain connections, 30s forced timeout |
| Rate limiting | `backend/src/services/rateLimiter.ts` | Redis atomic counters, per-user and global limits |
| Preference caching | `backend/src/services/preferences.ts` | Redis cache-aside with 5-min TTL, invalidation on update |
| RBAC auth | `backend/src/middleware/auth.ts` | Session-based auth, role checking middleware |

### Simplifications for Local Development

| Production Design | Local Substitute | Why |
|-------------------|------------------|-----|
| APNs / FCM push delivery | Simulated provider (random success/failure) | No Apple/Google developer accounts needed |
| SendGrid / SES email | Simulated provider with random delays | No email provider API keys needed |
| Twilio SMS | Simulated provider | No SMS provider account needed |
| API Gateway + LB | Direct connection to Express on port 3001-3003 | No nginx/HAProxy needed |
| Dedicated worker hosts | Single process with `tsx watch` | All workers share one process |
| Redis Cluster | Single Valkey instance | Sufficient for local data volume |
| PostgreSQL read replicas | Single PostgreSQL instance | Low query volume |
| Partitioned notifications table | Single unpartitioned table | No partition management overhead |

### What Was Omitted

- CDN and static asset serving
- Multi-region deployment and geo-routing
- Kubernetes orchestration and auto-scaling
- OAuth/OIDC integration (uses session auth instead)
- Real push notification delivery (APNs/FCM)
- Real email delivery (SendGrid/SES)
- Real SMS delivery (Twilio)
- Webhook-based delivery receipts from providers
- In-app notification channel (WebSocket)
- A/B testing for notification content
- ML-based send-time optimization
