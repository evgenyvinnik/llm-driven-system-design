# Design APNs - Architecture

## System Overview

A push notification service modeled after Apple Push Notification service (APNs), delivering notifications from application providers to iOS/macOS devices. Core challenges involve reliable delivery to millions of concurrent device connections, store-and-forward for offline devices, and efficient battery utilization through priority-based delivery.

**Learning Goals:**
- Build push notification infrastructure
- Design connection pooling at scale
- Implement store-and-forward delivery
- Handle device token lifecycle

## Requirements

### Functional Requirements

1. **Push** - Deliver notifications to specific devices via device token, with support for alert, badge, sound, and silent push
2. **Register** - Manage device token lifecycle: registration, re-registration, invalidation, and cleanup
3. **Topics** - Subscribe devices to named topics for broadcast notifications
4. **Feedback** - Report invalidated tokens to providers so they stop sending to uninstalled apps
5. **Priority** - Handle immediate (user-facing), power-nap, and low-priority (background) notifications with different delivery guarantees

### Non-Functional Requirements

| Requirement | Target (Production) |
|-------------|-------------------|
| Latency (high-priority) | < 500ms from provider send to device delivery |
| Scale | 50B+ notifications per day (580K/second sustained) |
| Delivery reliability | 99.99% for online devices |
| Battery efficiency | Minimize wake-ups; batch low-priority notifications |
| Token lookup | < 10ms p99 (cached), < 50ms p99 (cold) |
| Connection density | 1M+ concurrent device connections per edge server |
| Availability | 99.99% for notification acceptance, 99.9% for delivery |

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|--------|----------|
| Registered devices | 2B tokens |
| Active devices (daily) | 500M |
| Concurrent connections | 200M |
| Notifications per day | 50B |
| Peak notifications per second | 1M |
| Token table size | ~200 GB (2B rows x 100 bytes avg) |
| Pending queue size | ~50M notifications at peak |
| Notification history (30 days) | ~50 TB |

### Local Development Scale

| Metric | Estimate |
|--------|----------|
| Registered devices | 5-20 seeded |
| Simulated connections | 1-5 WebSocket clients |
| Notifications per test | 10-50 |
| Storage | < 10 MB |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Provider Layer                               │
│          App servers sending notifications via HTTP/2            │
│          (JWT-authenticated, multiplexed streams)                │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTP/2 (TLS 1.3)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Global Load Balancer                           │
│        (Geographic routing, TLS termination, DDoS protection)   │
└─────────────────────────────────────────────────────────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  APNs Gateway   │ │  APNs Gateway   │ │  APNs Gateway   │
│  (us-east)      │ │  (eu-west)      │ │  (ap-southeast) │
│                 │ │                 │ │                 │
│ - Auth (JWT)    │ │ - Auth (JWT)    │ │ - Auth (JWT)    │
│ - Rate limiting │ │ - Rate limiting │ │ - Rate limiting │
│ - Validation    │ │ - Validation    │ │ - Validation    │
│ - Deduplication │ │ - Deduplication │ │ - Deduplication │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Routing Layer                                  │
│       (Token lookup, device-to-shard mapping, topic fanout)     │
└─────────────────────────────────────────────────────────────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Push Service   │ │  Store Service  │ │  Token Registry │
│  (Shard 1..N)   │ │                 │ │                 │
│                 │ │ - Pending queue │ │ - Registration  │
│ - Device conns  │ │ - Retry logic   │ │ - Invalidation  │
│ - Delivery      │ │ - Expiration    │ │ - Topic subs    │
│ - Collapse      │ │ - Collapse      │ │ - Feedback gen  │
│ - QoS           │ │ - Dead letter   │ │ - Cache layer   │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                   │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐       │
│  │ PostgreSQL   │  │ Redis Cluster│  │ Kafka             │       │
│  │ (Sharded)    │  │              │  │                   │       │
│  │              │  │ - Token cache│  │ - Notification    │       │
│  │ - Tokens     │  │ - Conn state │  │   routing         │       │
│  │ - History    │  │ - Rate limits│  │ - Delivery events │       │
│  │ - Delivery   │  │ - Dedup keys │  │ - Feedback stream │       │
│  │ - Feedback   │  │              │  │                   │       │
│  └──────────────┘  └──────────────┘  └───────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Device Layer                                 │
│    Persistent connections (TLS over TCP) to all active devices   │
│    Sharded by device_id hash across connection servers           │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### APNs Gateway (Provider API)

The gateway accepts notifications from application providers via HTTP/2:

1. **Authentication**: Providers authenticate with JWT tokens signed with their app-specific private key. The gateway validates the JWT signature against the provider's registered public key and checks the `iss` (team ID) and `topic` (bundle ID) claims
2. **Payload validation**: Notifications must include a valid `aps` dictionary. Alert payloads are capped at 4 KB. VoIP and complication payloads allow 5 KB
3. **Rate limiting**: Per-provider rate limiting prevents a single app from overwhelming the system. Burst allowance for topic broadcasts
4. **Deduplication**: Provider-supplied `apns-id` headers enable idempotent delivery. Duplicate IDs within 24 hours return the original response

### Token Registry

Manages the lifecycle of 2B+ device tokens:

- **Registration**: Device tokens are SHA-256 hashed before storage (the raw token is never persisted). Registration is idempotent: re-registering updates `last_seen` and `device_info`
- **Invalidation**: Tokens are marked invalid (not deleted) when apps are uninstalled, tokens expire, or users opt out. Invalid tokens generate feedback entries for the provider
- **Topic subscriptions**: Devices subscribe to named topics (e.g., `/topics/breaking-news`). Topic fanout queries all valid devices subscribed to a topic

Token lookups use a cache-aside pattern with Redis:
1. Check Redis for `token:{hash}` (1-hour TTL)
2. On miss, query PostgreSQL and populate cache
3. Negative results cached for 5 minutes to prevent repeated DB hits for invalid tokens
4. On invalidation, immediately delete from cache and add to negative cache

### Push Delivery Service

Sharded by device ID hash. Each shard manages connections to a subset of devices:

- **Online delivery**: If the device has an active connection, push immediately. The device acknowledges receipt. Priority 10 (immediate) notifications wake the device; priority 5 (power nap) notifications are held until the next device wake cycle; priority 1 (background) notifications are batched
- **Offline delivery (store-and-forward)**: If the device is offline, store the notification in `pending_notifications`. When the device reconnects, deliver all pending notifications ordered by priority (descending) then creation time (ascending). Remove from pending after successful delivery
- **Collapse**: If a notification has a `collapse_id`, it replaces any existing pending notification with the same collapse_id for the same device. Implemented via `UNIQUE (device_id, collapse_id)` with `ON CONFLICT DO UPDATE`
- **Expiration**: Pending notifications with `expiration < NOW()` are not delivered. A background cleanup job purges expired entries

### Feedback Service

Providers poll for feedback about their invalidated tokens:

1. When a token is invalidated, an entry is added to `feedback_queue` with `app_bundle_id` and reason
2. Providers query `GET /feedback?bundle_id=com.example.app&since=<timestamp>` to get recent invalidations
3. Feedback is kept for 30 days, then purged

This enables providers to stop sending to uninstalled apps, reducing wasted server resources and improving delivery metrics.

### Quality of Service Manager

Priority-based delivery scheduling:

| Priority | Behavior | Use Case |
|----------|----------|----------|
| 10 (Immediate) | Deliver instantly, wake device | User-visible alerts, incoming calls |
| 5 (Power nap) | Deliver when device is naturally awake | Content updates, email summaries |
| 1 (Background) | Batch and deliver during maintenance window | Metrics, analytics, non-urgent sync |

Per-device rate limiting prevents notification spam: max 100 notifications per minute per device. Per-app rate limiting prevents a single provider from consuming disproportionate resources.

## Database Schema

### Entity-Relationship Diagram

```
┌──────────────────────────┐         ┌──────────────────────────┐
│      admin_users         │         │        sessions          │
├──────────────────────────┤         ├──────────────────────────┤
│ id (PK)              UUID│◄────────│ admin_id (FK)        UUID│
│ username         VARCHAR │   1:N   │ id (PK)              UUID│
│ password_hash    VARCHAR │         │ token              VARCHAR│
│ role             VARCHAR │         │ expires_at       TIMESTAMP│
│ created_at      TIMESTAMP│         │ created_at       TIMESTAMP│
│ last_login      TIMESTAMP│         └──────────────────────────┘
└──────────────────────────┘

┌──────────────────────────┐         ┌──────────────────────────┐
│      device_tokens       │◄────────│   topic_subscriptions    │
├──────────────────────────┤   1:N   ├──────────────────────────┤
│ device_id (PK)       UUID│         │ device_id (PK,FK)    UUID│
│ token_hash       VARCHAR │         │ topic (PK)         VARCHAR│
│ app_bundle_id    VARCHAR │         │ subscribed_at    TIMESTAMP│
│ device_info        JSONB │         └──────────────────────────┘
│ is_valid          BOOLEAN│
│ invalidated_at  TIMESTAMP│         ┌──────────────────────────┐
│ invalidation_reason      │◄────────│  pending_notifications   │
│   VARCHAR                │   1:N   ├──────────────────────────┤
│ created_at      TIMESTAMP│         │ id (PK)              UUID│
│ last_seen       TIMESTAMP│         │ device_id (FK)       UUID│
└────────────┬─────────────┘         │ payload             JSONB│
             │                       │ priority           INTEGER│
             │                       │ expiration       TIMESTAMP│
             │                       │ collapse_id       VARCHAR│
             │ 1:N                   │ created_at       TIMESTAMP│
             │                       │ UNIQUE(device_id,         │
             │                       │        collapse_id)       │
             ▼                       └──────────────────────────┘
┌──────────────────────────┐
│       notifications      │         ┌──────────────────────────┐
├──────────────────────────┤         │       delivery_log       │
│ id (PK)              UUID│         ├──────────────────────────┤
│ device_id (FK)       UUID│────────▶│ notification_id (PK) UUID│
│ topic              VARCHAR│   1:1   │ device_id (FK)       UUID│
│ payload             JSONB │         │ status             VARCHAR│
│ priority           INTEGER│         │ delivered_at     TIMESTAMP│
│ expiration       TIMESTAMP│         │ created_at       TIMESTAMP│
│ collapse_id        VARCHAR│         └──────────────────────────┘
│ status             VARCHAR│
│ created_at       TIMESTAMP│         ┌──────────────────────────┐
│ updated_at       TIMESTAMP│         │      feedback_queue      │
└──────────────────────────┘         ├──────────────────────────┤
                                     │ id (PK)          BIGSERIAL│
                                     │ token_hash         VARCHAR│
                                     │ app_bundle_id      VARCHAR│
                                     │ reason             VARCHAR│
                                     │ timestamp        TIMESTAMP│
                                     │ created_at       TIMESTAMP│
                                     └──────────────────────────┘
```

### Complete SQL Schema

```sql
-- Device Tokens
CREATE TABLE device_tokens (
  device_id UUID PRIMARY KEY,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  device_info JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  invalidated_at TIMESTAMP,
  invalidation_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tokens_app ON device_tokens(app_bundle_id);
CREATE INDEX idx_tokens_valid ON device_tokens(is_valid) WHERE is_valid = true;

-- Topic Subscriptions
CREATE TABLE topic_subscriptions (
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  topic VARCHAR(200) NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, topic)
);

CREATE INDEX idx_subscriptions_topic ON topic_subscriptions(topic);

-- Pending Notifications (store-and-forward queue for offline devices)
CREATE TABLE pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)
);

CREATE INDEX idx_pending_device ON pending_notifications(device_id);
CREATE INDEX idx_pending_expiration ON pending_notifications(expiration);

-- Notifications History
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE SET NULL,
  topic VARCHAR(200),
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_device ON notifications(device_id);
CREATE INDEX idx_notifications_topic ON notifications(topic);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created ON notifications(created_at);

-- Delivery Log (audit trail)
CREATE TABLE delivery_log (
  notification_id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_delivery_device ON delivery_log(device_id);
CREATE INDEX idx_delivery_status ON delivery_log(status);
CREATE INDEX idx_delivery_created ON delivery_log(created_at);

-- Feedback Queue (for providers to poll invalidated tokens)
CREATE TABLE feedback_queue (
  id BIGSERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  reason VARCHAR(50),
  timestamp TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feedback_app ON feedback_queue(app_bundle_id, timestamp);

-- Admin Users (dashboard authentication)
CREATE TABLE admin_users (
  id UUID PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW(),
  last_login TIMESTAMP
);

-- Sessions
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  admin_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Foreign Key Design Rationale

| Relationship | ON DELETE | Rationale |
|-------------|-----------|-----------|
| topic_subscriptions -> device_tokens | CASCADE | Subscriptions are meaningless without the device |
| pending_notifications -> device_tokens | CASCADE | Cannot deliver to a deleted device; clean up queue |
| notifications -> device_tokens | SET NULL | Preserve notification history for analytics after device deletion |
| delivery_log -> device_tokens | SET NULL | Preserve audit trail for compliance even after device cleanup |
| sessions -> admin_users | CASCADE | Invalidate sessions immediately when admin is deleted |

### Index Strategy

| Index | Query Pattern | Notes |
|-------|---------------|-------|
| `idx_tokens_valid` (partial) | Token lookups for valid tokens only | Partial index (`WHERE is_valid = true`) is smaller and faster than full index |
| `idx_tokens_app` | List all devices for an app | Used for topic broadcast and feedback queries |
| `idx_pending_device` | Deliver pending on reconnect | Low cardinality per device (few pending per device) |
| `idx_pending_expiration` | Cleanup expired notifications | Background job queries `WHERE expiration < NOW()` |
| `idx_notifications_created` | Recent notification dashboard | High cardinality, supports `ORDER BY created_at DESC` |
| `idx_feedback_app` | Provider feedback poll | Compound index on (app_bundle_id, timestamp) for efficient range scans |

### Key Schema Design Decisions

**Token hashing**: Raw device tokens are sensitive -- if leaked, attackers could send spam notifications. Storing SHA-256 hashes protects the tokens while allowing deterministic lookups. Trade-off: cannot recover original tokens from the database (intentional).

**Separate pending vs. notifications tables**: `pending_notifications` is a hot queue (frequent insert/delete), while `notifications` is append-mostly history. Separating them optimizes each for its access pattern -- the pending table stays small and fast, while the history table can be partitioned by time for analytics.

**Collapse ID unique constraint**: `UNIQUE (device_id, collapse_id)` enables atomic replace semantics via `ON CONFLICT DO UPDATE`. NULL collapse_ids do not participate in uniqueness (PostgreSQL behavior), so notifications without collapse_id accumulate normally.

**No FK on feedback_queue.token_hash**: Feedback entries reference tokens that may have already been purged from `device_tokens`. Storing `token_hash` as a value (not a foreign key) preserves the feedback even after the device record is deleted.

## API Design

### Provider API (Notification Sending)

| Method | Endpoint | Headers | Description |
|--------|----------|---------|-------------|
| POST | `/3/device/{device_token}` | `apns-id`, `apns-priority`, `apns-expiration`, `apns-topic`, `apns-collapse-id` | Send notification to specific device |
| POST | `/3/topic/{topic}` | Same as above | Broadcast to all topic subscribers |

### Device Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/devices/register` | Register device token |
| DELETE | `/api/v1/devices/:token` | Invalidate device token |
| POST | `/api/v1/devices/:token/topics` | Subscribe to topic |
| DELETE | `/api/v1/devices/:token/topics/:topic` | Unsubscribe from topic |

### Feedback

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/feedback` | Poll invalidated tokens by app bundle ID |

### Notification Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/notifications/:id/status` | Check delivery status |

### Admin Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/stats` | Device counts, notification stats, topic subscriber counts |
| GET | `/api/v1/admin/devices` | List registered devices with filters |
| GET | `/api/v1/admin/notifications` | Recent notification history |
| POST | `/api/v1/admin/devices/:id/invalidate` | Manually invalidate a token |

## Key Design Decisions

### HTTP/2 for Provider API

**Chosen:** HTTP/2 with multiplexed streams for the provider-facing API.

**Why:** A single provider (e.g., a messaging app) may send thousands of notifications per second. HTTP/1.1 would require thousands of TCP connections. HTTP/2 multiplexes all requests over a single connection with binary framing and header compression (HPACK). A single connection handles 100+ concurrent streams, reducing TLS handshake overhead from once-per-request to once-per-connection.

**Trade-off:** HTTP/2 requires TLS and more complex connection management. Debugging is harder (binary protocol). For local development, we simplify to HTTP/1.1 with Express, which preserves the request/response semantics while avoiding certificate management.

### Store-and-Forward for Offline Devices

**Chosen:** Queue notifications in `pending_notifications` when devices are offline, deliver on reconnect.

**Why:** Mobile devices are frequently offline (subway, airplane mode, power off). Without store-and-forward, notifications sent during offline periods are permanently lost. This is unacceptable for messaging apps where users expect to see all missed messages. The pending queue holds notifications until the device reconnects, then delivers in priority order.

**Trade-off:** The pending queue grows with offline duration. A device offline for a week accumulates hundreds of notifications. Mitigation: expiration timestamps (providers set `apns-expiration` header) and collapse IDs (only the latest sports score, not every intermediate update). Background cleanup job purges expired entries.

**Alternative:** "Fire and forget" (drop if offline) is simpler and used by some analytics-focused push services. Unacceptable for APNs where delivery guarantee is a core promise.

### Collapse IDs for Notification Replacement

**Chosen:** Notifications with the same `collapse_id` replace each other in the pending queue.

**Why:** Some notifications are inherently "latest value wins" -- a sports score, a ride ETA, a stock price. Without collapse, a device coming online after 3 hours of a basketball game receives 200 score update notifications. With collapse, it receives only the final score.

**Implementation:** `UNIQUE (device_id, collapse_id)` constraint with `ON CONFLICT DO UPDATE SET payload = $new` atomically replaces the old notification. No application-level locking needed.

### Token Hashing

**Chosen:** Store SHA-256 hash of device tokens, never the raw token.

**Why:** Device tokens are bearer credentials. If the token database is compromised, attackers could send spam notifications to millions of devices. Hashing the token means a database leak does not compromise the ability to abuse the push channel. The 64-character hex hash is deterministic, allowing efficient lookups via unique index.

**Trade-off:** Cannot recover the original token from the database. This is intentional -- tokens should only flow from device to provider to APNs, never be read back from storage.

## Consistency and Idempotency

### Token Registration: Strong Consistency
- `ON CONFLICT` upserts ensure no duplicate tokens
- Re-registration updates `last_seen` and `device_info` atomically
- `token_hash` UNIQUE constraint is the source of truth

### Notification Delivery: At-Least-Once
- Notifications may be delivered more than once (device reconnects mid-delivery, network failures)
- Clients handle duplicates using the `notification_id` (dedup on device)
- The delivery log records final status but may lag actual delivery

### Provider Idempotency
- Providers supply `apns-id` header (UUID) for idempotent sends
- Redis-based deduplication window: `SET cache:idem:{id} 1 NX EX 86400`
- Retry within 24 hours returns original notification status
- Without `apns-id`, each request is treated as unique

### Pending Notification Consistency: Last-Write-Wins
- With `collapse_id`: newer notification atomically replaces older via `ON CONFLICT DO UPDATE`
- Without `collapse_id`: each notification is independent
- Expiration checked at delivery time, not queue time

## Caching Strategy

### Cache-Aside for Token Lookups

Token lookups are in the critical path for every notification. Without caching, 50B daily notifications means 50B database queries just for token resolution.

| Cache Key | TTL | Rationale |
|-----------|-----|-----------|
| `token:{hash}` | 1 hour | Tokens are stable; long TTL reduces DB load |
| `token:{hash}:invalid` | 5 min | Negative caching prevents repeated failed lookups |
| `conn:{deviceId}` | 5 min | Connection server location; short TTL handles reconnects |
| `rate:device:{id}` | 1 min | Sliding window for per-device rate limiting |
| `rate:app:{bundleId}` | 1 min | Sliding window for per-app rate limiting |
| `dedup:{notificationId}` | 24 hours | Idempotency window for provider retries |

### Write-Through for Connection State

Device connection state must be immediately consistent -- if a device just connected to shard 3, the routing layer must know within milliseconds. Write-through pattern: on connect, write to Redis immediately; on disconnect, delete immediately. No TTL-based staleness.

### Cache Invalidation Rules

1. **Token changes**: Invalidate on registration update or token invalidation
2. **Connection changes**: Write-through on connect, delete on disconnect
3. **Rate limits**: TTL-based expiration only (no manual invalidation)
4. **Deduplication**: TTL-based expiration only

## Security

### Provider Authentication
- JWT tokens signed with provider's private key (ES256 recommended)
- Gateway validates signature against registered public key
- Claims validated: `iss` (team ID), `iat` (issued at), `topic` (bundle ID)
- Token expiration enforced (max 1 hour)

### Token Security
- Device tokens hashed with SHA-256 before storage
- Raw tokens never logged or stored
- API responses never expose token hashes to unauthorized parties

### Admin Dashboard
- Session-based auth with bcrypt password hashing
- Sessions stored in PostgreSQL with expiration
- Admin operations logged for audit trail

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `apns_notifications_sent_total` | Counter | Throughput by priority and status (delivered/queued/expired/failed) |
| `apns_notification_delivery_seconds` | Histogram | Delivery latency distribution by priority |
| `apns_active_device_connections` | Gauge | WebSocket connection count |
| `apns_pending_notifications` | Gauge | Pending queue depth |
| `apns_cache_operations_total` | Counter | Cache hit/miss ratio for TTL tuning |
| `apns_circuit_breaker_state` | Gauge | Circuit breaker health (0=closed, 1=open, 2=half-open) |
| `apns_dependency_health` | Gauge | Database and Redis connectivity |
| `apns_token_operations_total` | Counter | Token register/invalidate/lookup_hit/lookup_miss |

### Structured Logging (Pino)
- JSON output with request IDs for correlation
- HTTP request/response logging with timing
- Notification delivery events with priority, status, latency
- Audit logging for token lifecycle and admin operations
- Separate audit log stream for security-relevant events

### SLI Dashboard (Grafana)

Key queries:
- **Delivery success rate** (target 99.99%): `sum(rate(apns_notifications_sent_total{status="delivered"})) / sum(rate(apns_notifications_sent_total))`
- **High-priority p99 latency** (target < 500ms): `histogram_quantile(0.99, rate(apns_notification_delivery_seconds_bucket{priority="10"}))`
- **Cache hit ratio** (target > 90%): `sum(rate(apns_cache_hits_total)) / (sum(rate(apns_cache_hits_total)) + sum(rate(apns_cache_misses_total)))`

### Alert Thresholds

| Alert | Threshold | Severity |
|-------|-----------|----------|
| Delivery success rate < 99% | 2 minutes sustained | Warning |
| High-priority p99 > 500ms | 5 minutes sustained | Critical |
| Pending backlog > 10,000 | 10 minutes sustained | Warning |
| Cache hit ratio < 80% | 5 minutes sustained | Warning |
| No active connections | 5 minutes | Info |

## Failure Handling

### Circuit Breaker (Opossum)
- Wraps Redis pub/sub calls (cross-server notification routing)
- Opens at 50% error rate, resets after 15-30 seconds
- Fallback: store notification for later delivery rather than failing immediately
- Separate circuit breakers per dependency (Redis, PostgreSQL)

### Connection Resilience
- WebSocket connections include heartbeat mechanism to detect stale connections
- On disconnect, device ID removed from connection map and Redis
- Pending notifications preserved for delivery on reconnect
- Exponential backoff for client reconnection (device-side)

### Graceful Shutdown
- Stop accepting new HTTP requests and WebSocket connections
- Allow in-flight notification deliveries to complete (30-second timeout)
- Close database and Redis connections after draining
- Log shutdown reason and pending notification count

## Scalability Considerations

### Connection Sharding
At 200M concurrent connections, no single server can handle all devices. Connections are sharded by `hash(device_id) % shard_count`:
- Each shard server handles ~1M connections (with epoll/kqueue for efficient I/O)
- Redis stores the mapping: `conn:{deviceId}` -> `shard_server_id`
- The routing layer looks up the shard before delivery
- Adding shards requires a rebalancing migration (consistent hashing minimizes movement)

### Database Sharding
- Token table sharded by `hash(device_id)` across PostgreSQL instances
- Notification history partitioned by `created_at` (monthly) for efficient archival
- Pending notifications stay on a single hot instance (small working set)

### Geographic Distribution
- Gateway instances in each major region (US, EU, APAC)
- Devices connect to the nearest gateway (DNS-based routing)
- Cross-region notification delivery via Kafka (async, eventual consistency)
- Token registry replicated across regions with async replication (< 1s lag)

### What Breaks First
1. **Single database for tokens** - At 2B tokens, a single PostgreSQL instance cannot handle the lookup QPS. Solution: shard by device_id hash
2. **Connection server memory** - 1M WebSocket connections per server requires ~4 GB RAM for connection state. Solution: connection servers are stateless (state in Redis), horizontally scale
3. **Pending queue during mass offline** - A regional outage takes millions of devices offline simultaneously. Solution: pending queue backed by Kafka (distributed, durable), not single PostgreSQL instance

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Provider protocol | HTTP/2 | WebSocket | Standard HTTP semantics, multiplexing, header compression, broad tooling |
| Device connection | Long-lived TCP (WebSocket) | Polling | Sub-second latency, minimal battery drain, bidirectional |
| Offline handling | Store-and-forward | Drop if offline | Delivery guarantee is core to the service contract |
| Token storage | SHA-256 hash | Plaintext | Security -- database leak does not compromise push channel |
| Notification history | Separate table from pending | Single table with status | Optimizes hot queue (small, fast) vs. analytics (large, partitioned) |
| Cache pattern | Cache-aside for tokens | Write-through | Tokens change rarely; cache-aside is simpler and sufficient |
| Connection state | Write-through Redis | Cache-aside | Must be immediately consistent for routing decisions |
| Auth (admin) | Session-based | JWT | Simpler for dashboard; immediate revocation on logout |

## Implementation Notes

### Local Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                    │
│   React + TanStack Router + Zustand + Tailwind                   │
│   http://localhost:5173                                           │
│                                                                   │
│   Pages: Dashboard, Devices, Send Notification, Notifications    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ fetch (proxied)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Express API Server                                │
│                 http://localhost:3000                              │
│                                                                   │
│  Routes: devices, notifications, feedback, admin                 │
│  Services: tokenRegistry, pushService, feedbackService           │
│  Shared: logger, metrics, cache, circuitBreaker                  │
│                                                                   │
│  WebSocket server on same port (ws://)                           │
│  Simulates device connections for push delivery                  │
└──────┬───────────────────────────────────────────┬───────────────┘
       │                                           │
       ▼                                           ▼
┌──────────────────────┐              ┌────────────────────────┐
│  PostgreSQL          │              │   Valkey (Redis)       │
│  :5432               │              │   :6379                │
│                      │              │                        │
│  apns DB             │              │   Token cache          │
│  (device_tokens,     │              │   Idempotency keys     │
│   topic_subs,        │              │   Connection state     │
│   pending_notifs,    │              │   Rate limiting        │
│   notifications,     │              │                        │
│   delivery_log,      │              │                        │
│   feedback_queue,    │              │                        │
│   admin_users,       │              │                        │
│   sessions)          │              │                        │
└──────────────────────┘              └────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File | Why It Matters |
|---------|------|----------------|
| Prometheus Metrics | `src/shared/metrics.ts` | Notification throughput, delivery latency, connection count, cache hit ratio, circuit breaker state, dependency health. Enables SLO monitoring. |
| Structured Logging (Pino) | `src/shared/logger.ts` | JSON logs with request IDs, HTTP timing, delivery events. Audit logging for token lifecycle and admin operations. |
| Redis Caching (cache-aside) | `src/shared/cache.ts` | Token lookup caching with 1h TTL, negative caching for invalid tokens, idempotency key storage with 24h TTL. Reduces DB load by ~20x. |
| Circuit Breaker (Opossum) | `src/shared/circuitBreaker.ts` | Protects Redis pub/sub and per-device WebSocket circuits. Opens at 50% error rate, fallback stores notifications for later delivery. |
| Idempotency | `src/services/pushService.ts` | Provider-supplied `apns-id` checked against Redis. Duplicate sends within 24h return original response. Prevents double notifications on retry. |
| Token Registry with Cache | `src/services/tokenRegistry.ts` | Registration, invalidation, lookup with cache-aside pattern. SHA-256 token hashing, topic subscription management. |
| WebSocket Push Delivery | `src/services/pushService.ts` | Simulates persistent device connections. Store-and-forward for offline devices, collapse ID replacement, priority-ordered delivery on reconnect. |
| Health Check with Dependencies | `src/index.ts` | Reports database and Redis status, updates Prometheus dependency gauges. Supports load balancer integration. |

### Simplifications

| Production Design | Local Substitute | Why Acceptable |
|-------------------|------------------|----------------|
| HTTP/2 with TLS + JWT auth | HTTP/1.1 with Express + session auth | Same request/response semantics; avoids certificate management |
| Persistent TCP connections from devices | WebSocket connections from browser | Demonstrates store-and-forward, priority delivery, collapse without real device SDK |
| Kafka for notification routing | Direct in-process delivery | Single server needs no cross-server message passing |
| Sharded connection servers (1M conns each) | Single Express with ws library | Demonstrates the connection/delivery pattern at toy scale |
| PostgreSQL sharded by device_id | Single PostgreSQL instance | All tables fit in memory at development scale |
| Redis Cluster | Single Valkey instance | No HA or sharding needed for < 20 devices |
| Geographic distribution (multi-region gateways) | Single localhost server | Latency is not meaningful in development |

### Omitted

- HTTP/2 binary framing and stream multiplexing
- TLS 1.3 and certificate-based provider authentication
- Real iOS device SDK integration (APNs binary protocol)
- Connection sharding with consistent hashing
- Geographic routing and multi-region deployment
- Kafka-based notification routing and delivery event streaming
- Database sharding for token and notification tables
- Kubernetes orchestration and auto-scaling
- Battery-aware delivery scheduling (power nap integration)
- VoIP and complication push types
- Silent push for background app refresh
- Provider certificate management and rotation
