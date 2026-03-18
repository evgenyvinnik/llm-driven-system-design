# r/place - Collaborative Real-time Pixel Canvas - Architecture Design

## System Overview

A collaborative real-time pixel art canvas where millions of users place colored pixels on a shared grid, with per-user rate limiting enforcing fairness. Inspired by Reddit's r/place experiment, the system handles high-throughput concurrent writes, low-latency broadcasts, and canvas history for timelapse generation.

**Learning Goals:**
- Real-time pixel synchronization at scale via WebSockets + Pub/Sub
- Distributed rate limiting with Redis atomic operations
- Canvas state management with compact binary representations
- Horizontal scaling of stateful WebSocket connections

## Requirements

### Functional Requirements

- **Shared pixel canvas**: A grid of pixels visible and modifiable by all authenticated users
- **Real-time pixel placement**: Users click to place a colored pixel at any coordinate
- **Per-user rate limiting**: Configurable cooldown (default 5 seconds) between pixel placements
- **Live canvas updates**: All connected users see pixel changes within 100ms
- **Canvas history**: Append-only log of all pixel placement events
- **Timelapse generation**: Replay canvas evolution from periodic snapshots
- **16-color palette**: Fixed palette for visual consistency
- **Admin controls**: Reset canvas, ban users, change cooldown settings
- **Anonymous and registered users**: Both can place pixels; registered users have persistent identity

### Non-Functional Requirements

- **Scalability**: 100,000+ concurrent users with horizontal scaling
- **Availability**: 99.9% uptime (8.7 hours downtime/year)
- **Latency**: Pixel placement acknowledgment < 50ms (p95); broadcast to all users < 100ms (p95)
- **Consistency**: Eventual consistency with last-write-wins for pixel conflicts
- **Throughput**: 20,000 pixel placements/second at 100K concurrent users (limited by 5-second cooldown)

## Capacity Estimation

### Production Scale (2000x2000 canvas, 100K concurrent users)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 2000 x 2000 = 4M pixels | -- |
| Canvas memory | 4 MB | 4M pixels x 1 byte (color index 0-15) |
| Peak pixel placements | 20,000 RPS | 100K users / 5s cooldown |
| WebSocket connections | 100,000 | 1 per user |
| Naive broadcast messages/sec | 2 billion | 20K placements x 100K recipients |
| Mitigation | Viewport-based updates + batching | Users only receive updates for visible area |
| Event storage growth | ~1.7 GB/day | 20K events/s x 24 bytes/event x 86,400s |

### Local Development Scale (500x500 canvas, ~100 concurrent users)

| Metric | Value |
|--------|-------|
| Canvas size | 500 x 500 = 250,000 pixels |
| Canvas memory (Redis) | 250 KB |
| Peak pixel placements | 20 RPS |
| WebSocket messages/sec | ~2,000 |
| Event storage growth | ~1.7 MB/hour |

### Storage Sizing

| Data Type | Size | Growth Rate | Retention |
|-----------|------|-------------|-----------|
| Canvas state (Redis) | 250 KB - 4 MB | Static | Always in memory |
| Session data (Redis) | ~500 bytes/user | With active users | 24-hour TTL |
| Rate limit keys (Redis) | ~50 bytes/user | With active users | 5-second TTL |
| Pixel events (PostgreSQL) | 48 bytes/event | ~82 MB/day (100 users) | 30 days |
| Canvas snapshots (PostgreSQL) | 250 KB/snapshot | ~6 MB/day (1/hour) | 90 days |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Browsers                              │
│                (React + Canvas API + WebSocket client)                  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS + WSS
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Load Balancer (nginx)                          │
│              Sticky sessions (IP hash for WebSocket affinity)          │
└──────┬───────────────────────┬───────────────────────┬──────────────────┘
       │                       │                       │
       ▼                       ▼                       ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ API Server 1 │       │ API Server 2 │       │ API Server N │
│              │       │              │       │              │
│ Express +    │       │ Express +    │       │ Express +    │
│ WebSocket    │       │ WebSocket    │       │ WebSocket    │
│ Server       │       │ Server       │       │ Server       │
│              │       │              │       │              │
│ ┌──────────┐ │       │ ┌──────────┐ │       │ ┌──────────┐ │
│ │ WS Conns │ │       │ │ WS Conns │ │       │ │ WS Conns │ │
│ │ (local)  │ │       │ │ (local)  │ │       │ │ (local)  │ │
│ └──────────┘ │       │ └──────────┘ │       │ └──────────┘ │
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                       │                       │
       └───────────┬───────────┴───────────┬───────────┘
                   │                       │
       ┌───────────┴───────────┐   ┌───────┴───────────┐
       ▼                       ▼   ▼                   ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   Redis /    │       │  PostgreSQL  │       │  RabbitMQ    │
│   Valkey     │       │              │       │              │
│              │       │ pixel_events │       │ Snapshot     │
│ Canvas state │       │ snapshots    │       │ jobs         │
│ Sessions     │       │ users        │       │ Timelapse    │
│ Rate limits  │       │ sessions     │       │ generation   │
│ Pub/Sub      │       │              │       │              │
└──────────────┘       └──────────────┘       └──────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| API Server | HTTP REST + WebSocket server for pixel placement and canvas state | Express.js + ws library |
| Canvas Store | Real-time canvas state, rate limits, sessions, pub/sub for cross-server broadcast | Redis/Valkey |
| Event Store | Append-only pixel history, canvas snapshots, user accounts | PostgreSQL |
| Message Queue | Background jobs for snapshot creation and timelapse generation | RabbitMQ |
| Load Balancer | Distribute traffic across API servers with WebSocket affinity | nginx |
| Persistence Worker | Consumes RabbitMQ jobs for periodic canvas snapshots | Node.js background process |

### Request Flow: Placing a Pixel

```
1. User clicks canvas at (x=100, y=200) with color=5
2. Frontend sends WebSocket message: { type: "place", x: 100, y: 200, color: 5 }
3. API Server receives message, generates idempotency key
4. Idempotency check (Redis): GET idempotency:pixel:{userId}:{x}:{y}:{color}
   ├─ If exists → return cached result (duplicate request)
   └─ If not → continue
5. Rate limit check (Redis): SET ratelimit:user:{userId} "1" NX EX 5
   ├─ If nil (key exists) → reject with remaining cooldown
   └─ If OK → continue
6. Update canvas (Redis): SETRANGE canvas:main (x + y*500) colorByte
7. Record event (PostgreSQL): INSERT INTO pixel_events (x, y, color, user_id)
8. Store idempotency result (Redis): SET idempotency key with 10s TTL
9. Publish update (Redis Pub/Sub): PUBLISH canvas:updates {x, y, color, userId}
10. All API servers receive pub/sub message
11. Each server broadcasts to its connected WebSocket clients
12. Frontend updates local canvas immediately
```

## Database Schema

### Redis Data Structures

```
# Canvas State (compact byte string, 1 byte per pixel)
canvas:main = <250KB binary string>
# Access: offset = x + y * CANVAS_WIDTH
# Update: SETRANGE canvas:main offset colorByte (atomic)

# Rate Limit Keys (auto-expiring)
ratelimit:user:{userId} = "1"
# SET ... NX EX 5 → returns OK if allowed, nil if on cooldown

# Session Storage
session:{sessionId} = { userId, username, isGuest, isAdmin, createdAt }
# TTL: 24 hours

# Idempotency Keys (prevent duplicate placements)
idempotency:pixel:{userId}:{x}:{y}:{color} = { success, nextPlacement }
# TTL: 10 seconds

# Pub/Sub Channel
canvas:updates → { x, y, color, userId, timestamp }
```

### PostgreSQL Schema

```sql
-- Pixel placement events (append-only log)
CREATE TABLE pixel_events (
  id              BIGSERIAL PRIMARY KEY,
  x               SMALLINT NOT NULL,
  y               SMALLINT NOT NULL,
  color           SMALLINT NOT NULL,
  user_id         VARCHAR(36) NOT NULL,
  placed_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pixel_events_time ON pixel_events(placed_at);
CREATE INDEX idx_pixel_events_user ON pixel_events(user_id);

-- Canvas snapshots for timelapse
CREATE TABLE canvas_snapshots (
  id              SERIAL PRIMARY KEY,
  captured_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  canvas_data     BYTEA NOT NULL,
  pixel_count     BIGINT DEFAULT 0
);

CREATE INDEX idx_canvas_snapshots_time ON canvas_snapshots(captured_at);

-- Users (for registered accounts)
CREATE TABLE users (
  id              VARCHAR(36) PRIMARY KEY,
  username        VARCHAR(50) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(20) DEFAULT 'user',
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) REFERENCES users(id) ON DELETE CASCADE,
  expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Data Size Estimates

| Table | Row Size | Rows/Day (100 users) | Daily Growth |
|-------|----------|----------------------|--------------|
| pixel_events | ~48 bytes | ~1.7M | ~82 MB |
| canvas_snapshots | ~250 KB | 24 | ~6 MB |
| users | ~300 bytes | 10 new | ~3 KB |

## API Design

### REST Endpoints

```
# Authentication
POST   /api/v1/auth/register     → Create account { username, password }
POST   /api/v1/auth/login        → Login { username, password }
POST   /api/v1/auth/logout       → End session
POST   /api/v1/auth/guest        → Create anonymous session
GET    /api/v1/auth/me           → Get current user info

# Canvas
GET    /api/v1/canvas            → Get full canvas state (binary response)
GET    /api/v1/canvas/info       → Canvas metadata { width, height, cooldown }

# History
GET    /api/v1/history/pixel?x=&y=       → Placement history for pixel
GET    /api/v1/history/user/:userId      → User's placement history
GET    /api/v1/history/recent?limit=100  → Recent placements

# Timelapse
GET    /api/v1/timelapse/snapshots       → List available snapshots
GET    /api/v1/timelapse/snapshot/:id    → Get specific snapshot

# Admin (requires admin role)
POST   /api/v1/admin/reset-canvas        → Clear canvas to white
POST   /api/v1/admin/ban-user            → Ban user { userId }
POST   /api/v1/admin/unban-user          → Unban user { userId }
PUT    /api/v1/admin/settings            → Update settings { cooldownSeconds }
GET    /api/v1/admin/stats               → System statistics

# Observability
GET    /health                           → Liveness check
GET    /health/ready                     → Readiness (Redis + PostgreSQL)
GET    /metrics                          → Prometheus metrics
```

### WebSocket Protocol

```
Client → Server:
  { type: "place", x: number, y: number, color: number }
  { type: "ping" }

Server → Client:
  { type: "update", x: number, y: number, color: number, userId?: string }
  { type: "error", code: string, message: string, cooldownRemaining?: number }
  { type: "pong" }
  { type: "welcome", userId: string, cooldown: number, canvasInfo: {...} }

Error codes:
  RATE_LIMITED   → User must wait before placing another pixel
  INVALID_COORDS → x/y out of canvas bounds
  INVALID_COLOR  → Color index not in palette (0-15)
  UNAUTHORIZED   → No valid session
  BANNED         → User is banned
```

## Key Design Decisions

### Real-time Pixel Synchronization: WebSocket + Redis Pub/Sub

**Chosen**: Each API server maintains WebSocket connections to its clients. On pixel placement, the server publishes to Redis channel `canvas:updates`. All servers subscribe and broadcast to their local clients.

**Why this works**: Redis Pub/Sub is fire-and-forget with sub-millisecond latency. At 20 RPS pixel placements with 100 connected users per server, each server processes ~20 broadcast messages per second -- trivial overhead. Adding servers is linear: each new server subscribes to the same channel and handles its own WebSocket connections.

**Why not polling**: HTTP polling at 1-second intervals means average 500ms latency for seeing updates -- users would perceive the canvas as laggy, undermining the collaborative experience. Polling at 100ms intervals creates 600 requests/minute per user. At 100K users, that is 1 million requests/second hitting the API servers, the vast majority returning "no updates." WebSocket eliminates this waste by pushing only when data changes.

**Why not Kafka**: Kafka provides durable message streams with consumer groups, but pixel updates are ephemeral -- if a client misses an update while disconnected, it fetches the full canvas on reconnect. Kafka's durability guarantee adds operational complexity (broker management, partition assignment, offset tracking) with no benefit for this use case.

**What we give up**: Redis Pub/Sub has no message persistence. If a client disconnects and reconnects, it misses updates during the gap. Mitigation: client fetches the full canvas state on reconnect (250 KB, gzip-compressible to ~50 KB).

### Rate Limiting: Redis SET NX EX

**Chosen**: Atomic `SET ratelimit:user:{userId} "1" NX EX 5` for per-user cooldown enforcement.

**Why atomic SET NX EX**: This single Redis command atomically checks if a cooldown exists and sets a new one. There is zero race condition window -- even if two requests arrive on different servers within the same millisecond, only one succeeds. The TTL auto-expires the key, eliminating cleanup jobs.

**Why not sliding window**: A sliding window rate limiter (e.g., Redis sorted sets with timestamps) provides smoother limiting but adds complexity. For a fixed per-user cooldown, the binary "can place / cannot place" semantics of SET NX EX are a perfect fit. Sliding window would be appropriate for API rate limiting (e.g., 100 requests/minute) but overkill for a single-action cooldown.

**What we give up**: Fixed window means a user could theoretically place at t=4.9s and again at t=5.0s (back-to-back within 100ms). This is acceptable for collaborative art -- the 5-second cooldown exists for fairness, not millisecond precision.

### Canvas State: Redis Byte Array with SETRANGE

**Chosen**: Single Redis key containing a binary string where each byte represents one pixel's color index (0-15).

**Why byte array**: A 500x500 canvas is 250 KB -- fits in a single Redis value with room to spare. `SETRANGE` provides atomic byte-level updates without read-modify-write cycles. `GET` returns the entire canvas in one call. Addressing is simple: `offset = x + y * width`.

**Why not Redis hash (one key per pixel)**: A hash with 250,000 fields consumes ~10x more memory due to per-field overhead. Fetching the full canvas requires `HGETALL` which is slower than a single `GET`. Individual pixel reads are faster with a hash, but the whole-canvas-on-connect use case dominates.

**What we give up**: A single key cannot be sharded across Redis nodes. For a 2000x2000 canvas (4 MB), this is fine for a single Redis instance. At larger scales (10,000x10,000), the canvas would need tile-based storage with multiple keys, adding addressing complexity.

### Consistency: Last-Write-Wins

**Chosen**: No locking, no CRDTs, no vector clocks. The last SET to Redis wins.

**Why this is acceptable**: The 5-second per-user cooldown makes pixel-level contention extremely rare. Two users placing on the exact same pixel within the same second is unlikely and harmless when it happens -- collaborative art tolerates this. The full event log in PostgreSQL preserves attribution for audit purposes.

**What we give up**: In the astronomically unlikely case of a true write-write conflict on the same pixel, one user's placement is silently overwritten. Both users see the "winner" within 100ms via the broadcast. For financial transactions this would be unacceptable; for pixel art, it is invisible.

## Security

### Authentication and Authorization

| User Type | Auth Method | Capabilities |
|-----------|-------------|--------------|
| Anonymous Guest | Session cookie (Redis) | Place pixels, view canvas |
| Registered User | Session cookie + bcrypt password | Place pixels, view history, persistent identity |
| Admin | Session + admin role in DB | All above + ban users, reset canvas, change settings |

**Session security**:
- Session ID: UUID v4, stored in HTTP-only cookie
- Session data: stored in Redis with 24-hour TTL
- Passwords: bcrypt with cost factor 12
- CSRF: Origin header validation for WebSocket upgrade requests

### Rate Limiting Summary

| Endpoint/Action | Limit | Window | Scope |
|-----------------|-------|--------|-------|
| Pixel placement | 1 per 5 seconds | Per user | Redis TTL key |
| Auth attempts | 5 per minute | Per IP | In-memory counter |
| Canvas download | 10 per minute | Per IP | In-memory counter |
| API requests | 100 per minute | Per user | In-memory counter |

### Input Validation

All pixel placements are validated before processing:
- `x`: integer, 0 to CANVAS_WIDTH - 1
- `y`: integer, 0 to CANVAS_HEIGHT - 1
- `color`: integer, 0 to 15

## Observability

### Prometheus Metrics

**Pixel placement**:
- `rplace_pixels_placed_total{color}` -- Counter by color index
- `rplace_pixel_placement_duration_seconds` -- Histogram [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]

**WebSocket connections**:
- `rplace_active_websocket_connections` -- Current connection gauge
- `rplace_active_users` -- Users who placed a pixel in last 5 minutes
- `rplace_canvas_updates_total` -- Broadcast message counter

**Rate limiting**:
- `rplace_rate_limit_hits_total` -- Rejected placement attempts

**HTTP**:
- `rplace_http_requests_total{method,path,status}` -- Request counter
- `rplace_http_request_duration_seconds{method,path,status}` -- Latency histogram

**Infrastructure**:
- `rplace_redis_operations_total{operation,status}` -- Redis command counter
- `rplace_redis_operation_duration_seconds{operation}` -- Redis latency
- `rplace_postgres_queries_total{query_type,status}` -- PostgreSQL query counter
- `rplace_postgres_query_duration_seconds{query_type}` -- PostgreSQL latency

**Reliability**:
- `rplace_circuit_breaker_state{name}` -- 0=closed, 0.5=half-open, 1=open
- `rplace_idempotency_cache_hits_total` -- Duplicate request detections
- `rplace_snapshots_created_total` -- Canvas snapshots taken

### Structured Logging (Pino)

JSON-formatted logs with event-based helpers:

| Event | Level | Fields |
|-------|-------|--------|
| `pixel_placed` | info | traceId, userId, x, y, color, latencyMs |
| `rate_limit_hit` | warn | traceId, userId, remainingSeconds |
| `websocket_connected` / `disconnected` | info | userId, username, totalConnections |
| `websocket_error` | error | userId, error, totalConnections |
| `circuit_breaker_open` / `close` / `halfOpen` | info/warn | circuitName, error |

**Trace ID generation**: Each request gets a unique trace ID (`timestamp-random`) propagated through all related operations for correlation.

### Health Checks

```
GET /health          → 200 if server process running
GET /health/ready    → 200 if Redis + PostgreSQL connected

Response: { status, redis, postgres, uptime, version }
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 1% | > 5% |
| p95 latency | > 200ms | > 500ms |
| WebSocket connections | > 80% capacity | > 95% capacity |
| Redis memory | > 70% | > 90% |
| PostgreSQL connections | > 80% pool | > 95% pool |

## Failure Handling

### Circuit Breakers (Opossum)

Redis operations are wrapped in circuit breakers to prevent cascading failures:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Error threshold | 50% | Open after half of requests fail |
| Volume threshold | 5 | Minimum requests before evaluating |
| Timeout | 5 seconds | Max wait per Redis operation |
| Reset timeout | 30 seconds | Time before half-open test |
| Warm-up | Enabled | Allow first request in half-open |

**Fallback behaviors**:
- Canvas read fails → return empty canvas (client shows blank)
- Rate limit check fails → allow placement (fail-open for UX)
- Event write fails → pixel still placed in Redis, event queued for retry
- Pub/Sub fails → local server broadcasts to its own clients only

### Component Failure Scenarios

| Component | Failure Mode | Impact | Mitigation |
|-----------|--------------|--------|------------|
| API Server | Crash | 1/N users disconnected | LB health checks, auto-restart, client reconnects |
| Redis | Down | No pixel placements possible | Circuit breaker fail-open, reconnect with backoff |
| PostgreSQL | Down | No history writes | Buffer events, retry on recovery |
| RabbitMQ | Down | No snapshots generated | Jobs queue on recovery, catch up |
| Network partition | Split brain | Temporary inconsistency | Redis pub/sub auto-reconnects |

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| History write fails | Pixel placed in canvas, event queued for retry |
| Snapshot job fails | Timelapse has gaps, job retried on next interval |
| Rate limit check fails | Default to allowing (fail-open prioritizes UX) |
| WebSocket broadcast fails | Other servers still broadcast via pub/sub |

### Data Recovery

**Redis (canvas state)**: If Redis restarts, canvas is empty. Recovery: load latest PostgreSQL snapshot. Prevention: Redis AOF persistence enabled in docker-compose (`--appendonly yes`).

**PostgreSQL (history)**: Daily backups, point-in-time recovery. 7-day retention.

### Idempotency

Pixel placements use Redis-backed idempotency keys to prevent duplicates from network retries, client-side double clicks, or load balancer request duplication. Keys are generated from `userId + x + y + color` (or a client-provided `X-Idempotency-Key` header). TTL of 10 seconds covers the retry window without conflicting with the 30-second cooldown.

## Scalability Considerations

### Horizontal Scaling Path

1. **Stage 1 (< 1K users)**: Single API server, single Redis, single PostgreSQL
2. **Stage 2 (1-10K users)**: 3 API servers behind nginx, Redis with AOF, PostgreSQL primary-replica
3. **Stage 3 (10-100K users)**: CDN for static assets, read replicas for history, batch WebSocket broadcasts
4. **Stage 4 (100K+ users)**: Geographic distribution, viewport-based updates, canvas tiling

### Bottleneck Analysis

| Component | Bottleneck | Threshold | Solution |
|-----------|------------|-----------|----------|
| API Server | WebSocket connections | ~10K per server | Add more servers behind LB |
| Redis | Memory for canvas | ~1 GB for 32Kx32K | Tile-based sharding (multiple keys) |
| Redis Pub/Sub | Fan-out volume | ~100K msg/sec per subscriber | Partition by canvas region |
| PostgreSQL | Write throughput | ~10K inserts/sec | Batch inserts, table partitioning by time |
| Bandwidth | Outbound to clients | N_users x updates/sec | Viewport-based updates, message batching |

### Viewport-Based Updates (production optimization)

At 100K concurrent users, broadcasting every pixel update to every user is infeasible (20K updates/sec x 100K users = 2B messages/sec). The solution is viewport-based subscriptions:

1. Client reports its visible viewport coordinates on connect and pan/zoom
2. Server subscribes client only to Redis pub/sub channels for visible canvas tiles
3. Tile size: 100x100 pixels (25 tiles for a 500x500 canvas)
4. Each update publishes to the tile's channel: `canvas:tile:{tileX}:{tileY}`
5. Client receives only updates for tiles in its viewport (~4-9 tiles typically)

This reduces message fan-out by 90%+ for large canvases.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time transport | WebSocket + Redis Pub/Sub | HTTP polling | Sub-100ms updates; polling wastes bandwidth |
| Canvas storage | Redis byte array + SETRANGE | Redis hash per pixel | 10x less memory, single GET for full canvas |
| Rate limiting | Redis SET NX EX | Sliding window (sorted sets) | Atomic, zero race conditions, perfect for fixed cooldown |
| Consistency | Last-write-wins | CRDTs, vector clocks | Conflicts are rare at 5s cooldown, harmless for art |
| Event persistence | PostgreSQL append-only | Kafka log | Simpler operations, queryable for history |
| Background jobs | RabbitMQ | Cron jobs | Decouples snapshot timing from API server load |
| Session storage | Redis + cookie | JWT | Immediate revocation, server-controlled expiry |

## Implementation Notes

This section maps the production architecture to the actual local implementation, documenting production-grade patterns used, simplifications, and omissions.

### Local Setup

```
┌────────────────────────────────────────────────────────────┐
│              React Frontend (:5173)                        │
│     HTML5 Canvas, Zustand state, WebSocket client          │
│     Zoom/pan, 16-color palette, cooldown timer             │
└──────────────────────────┬─────────────────────────────────┘
                           │ HTTP + WS
                           ▼
┌────────────────────────────────────────────────────────────┐
│           Express + WebSocket Server (:3001)               │
│    REST API, WebSocket handler, Redis pub/sub subscriber   │
│    Circuit breakers, Prometheus metrics, Pino logging      │
│    Idempotency middleware                                  │
└────┬──────────────────┬──────────────────┬─────────────────┘
     │                  │                  │
     ▼                  ▼                  ▼
┌──────────┐     ┌────────────┐     ┌────────────┐
│  Valkey  │     │ PostgreSQL │     │  RabbitMQ  │
│ (:6379)  │     │  (:5432)   │     │ (:5672)    │
│          │     │            │     │            │
│ Canvas   │     │ pixel_     │     │ Snapshot   │
│ Sessions │     │ events     │     │ jobs       │
│ Rate     │     │ snapshots  │     │            │
│ limits   │     │ users      │     │            │
│ Pub/Sub  │     │ sessions   │     │            │
│ Idemp.   │     │            │     │            │
└──────────┘     └────────────┘     └────────────┘
```

Multiple server instances can be started for distributed testing:
- `npm run dev:server1` → port 3001
- `npm run dev:server2` → port 3002
- `npm run dev:server3` → port 3003

### Production-Grade Patterns Implemented

**Circuit breakers (Opossum)** (`backend/src/shared/circuitBreaker.ts`): Redis operations are protected by circuit breakers that open after 50% failure rate over 5+ requests, preventing cascading failures. Fallback functions return default values (empty canvas, allow placement) when the circuit is open. State changes are tracked via Prometheus gauges and logged via Pino.

**Idempotency for pixel placements** (`backend/src/shared/idempotency.ts`): Redis-backed idempotency keys prevent duplicate placements from network retries. Keys are generated from `userId + coordinates + color` or a client-provided request ID. Cached results are returned for duplicates. TTL of 10 seconds covers the retry window. Fail-open on Redis errors (allows the request through).

**Prometheus metrics (prom-client)** (`backend/src/shared/metrics.ts`): 15+ metrics including pixel placement counters (by color), WebSocket connection gauge, active users gauge, rate limit hits, HTTP request duration histograms, Redis and PostgreSQL operation counters with latency histograms, circuit breaker state, idempotency cache hits, and snapshot counters. Includes Express middleware for automatic HTTP metrics.

**Structured logging (Pino)** (`backend/src/shared/logger.ts`): JSON-formatted logs with service instance identification. Dedicated helpers for pixel placement, rate limit hits, WebSocket connection events, and circuit breaker state changes. Trace ID generation for request correlation across operations.

**Redis Pub/Sub for cross-server broadcast** (`backend/src/services/redis.ts`): Real-time pixel updates are published to a Redis channel. All server instances subscribe and broadcast to their local WebSocket clients. This enables horizontal scaling -- adding servers does not require changes to the broadcast mechanism.

**Atomic rate limiting** (`backend/src/services/canvas.ts`): Redis `SET NX EX` provides race-condition-free per-user cooldown enforcement across all server instances.

**Canvas byte array with SETRANGE** (`backend/src/services/canvas.ts`): Compact binary representation using 1 byte per pixel. Atomic updates via `SETRANGE` without read-modify-write cycles.

**Background persistence worker** (`backend/src/workers/persistence-worker.ts`): Separate process for canvas snapshot creation, decoupled from the API server via RabbitMQ.

**Session-based authentication with bcrypt** (`backend/src/middleware/auth.ts`, `backend/src/services/auth.ts`): Session cookies stored in Redis with 24-hour TTL. Passwords hashed with bcrypt. Support for both registered and anonymous guest users.

### Simplifications

| Production Design | Local Simplification |
|-------------------|---------------------|
| nginx load balancer with sticky sessions | Direct connection to single server |
| Multiple API server instances | Single instance (multi-instance via npm scripts for testing) |
| Viewport-based update subscriptions | All clients receive all updates |
| Batched WebSocket broadcasts | Individual messages per update |
| Canvas tile-based sharding | Single Redis key for entire canvas |
| CDN for static assets | Vite dev server serves directly |
| PostgreSQL read replicas for history | Single PostgreSQL instance |
| Redis Sentinel/Cluster for HA | Single Valkey instance |

### What Was Omitted

- **Viewport-based updates**: All clients receive all pixel updates (works fine at 100 users, would not scale to 100K)
- **WebSocket message batching**: No batching of rapid sequential updates into single frames
- **Canvas tiling**: Single Redis key for entire canvas (limits to ~32K x 32K pixels)
- **CDN**: No content delivery network for static assets
- **Multi-region**: No geographic distribution or edge compute
- **Kubernetes**: No container orchestration or auto-scaling
- **Admin dashboard**: Admin endpoints exist but no dedicated admin UI
- **Timelapse viewer**: Snapshots are stored but no frontend replay component
- **Hot-pixel detection**: No monitoring for pixels receiving disproportionate updates
