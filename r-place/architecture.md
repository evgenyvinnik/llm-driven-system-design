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

## Frontend Architecture

### Component Hierarchy

```
App (direct rendering, no router)
├── Header
│   ├── Title: "r/place"
│   ├── Toolbar (zoom controls: zoom in, zoom out, reset)
│   └── AuthPanel
│       ├── Login/Register forms (unauthenticated)
│       ├── Guest login button
│       └── User info + logout (authenticated)
│
├── Canvas (main interactive area)
│   ├── HTML5 <canvas> element (pixel rendering)
│   ├── Hover indicator (white border on hovered pixel at zoom >= 2x)
│   ├── Notification banner (placement feedback, errors)
│   ├── Zoom indicator (bottom-right, e.g., "500%")
│   └── Coordinates display (bottom-left, e.g., "(120, 340)")
│
└── Footer
    ├── ColorPalette (16-color grid with selection ring)
    └── CooldownTimer (countdown display when rate-limited)
```

### Zustand Store

A single Zustand store (`useAppStore`) manages all client-side state with no persistence middleware -- the canvas state is ephemeral and always fetched fresh from the server on load.

**User state**: `user` (User object or null), `isAuthenticated`, `isLoading`. Auth actions (`login`, `register`, `logout`, `loginAnonymous`) call the REST API and then reconnect the WebSocket to associate the new session.

**Canvas state**: `config` (server-provided canvas dimensions, cooldown duration, and 16-color palette), `canvas` (a `Uint8Array` where each byte represents one pixel's color index, 0-15). The `setCanvas` action decodes a base64-encoded string from the server into the byte array. The `updatePixel` action modifies a single byte at `offset = y * width + x`.

**View state**: `selectedColor` (currently chosen palette color, default: red/index 5), `hoveredPixel` (coordinates under the cursor, or null), `zoom` (clamped between 0.5x and 20x), `panOffset` (pixel offset for drag-panning). These are purely local UI state -- they are not sent to the server.

**Cooldown state**: `cooldown` (CooldownStatus with `canPlace`, `remainingSeconds`, `nextPlacement` timestamp) and `cooldownTimer` (interval ID for countdown). When a pixel is successfully placed, the server responds with the `nextPlacement` timestamp. A `setInterval` updates `remainingSeconds` every second until the cooldown expires. The timer is cleaned up and restarted on each new cooldown to avoid stale intervals.

**Pixel placement flow**: The `placePixel` action checks authentication and cooldown before calling the REST API. On success, it starts the cooldown timer. The actual canvas update comes via the WebSocket broadcast (the server publishes the pixel update to all subscribers, including the sender).

### Routing

No router is used. The application is a single-view pixel canvas that fills the entire viewport. The `App` component calls `initialize()` on mount, which loads canvas configuration, checks authentication, and establishes the WebSocket connection. There are no URL-based routes -- the entire UI is always visible.

### Data Fetching

The frontend uses a split communication strategy:

**REST API** (`services/api.ts`): Used for authentication (register, login, logout, guest), canvas configuration (`GET /api/v1/canvas/info`), pixel placement (`POST` to the API which enforces rate limiting and idempotency), and history queries. All requests use `credentials: 'include'` for cookie-based session auth.

**WebSocket** (`services/websocket.ts`): Used for real-time data delivery. A singleton `WebSocketService` class manages the connection lifecycle with automatic reconnection using exponential backoff (base delay 1 second, doubled each attempt, max 10 attempts). On connect, the server sends the full canvas state as a base64-encoded byte array. Subsequently, individual pixel updates arrive as `{type: "pixel", data: {x, y, color}}` messages, and the store updates the local `Uint8Array` in place.

**WebSocket message types handled**:
- `canvas`: Full canvas state (base64 binary), received on connect
- `pixel`: Single pixel update, applied to the local byte array
- `pixels`: Batch of pixel updates (array), each applied sequentially
- `cooldown`: Updated cooldown status from the server
- `connected`: Confirmation of successful WebSocket connection

**Reconnection flow**: When the WebSocket disconnects, the `attemptReconnect` method uses exponential backoff. On successful reconnection, the server sends a fresh `canvas` message, ensuring the client converges to the current state even after extended disconnection.

### Key UI Patterns

**HTML5 Canvas rendering**: The pixel grid is rendered using the HTML5 Canvas API rather than DOM elements. The `renderCanvas` function iterates through every pixel in the `Uint8Array`, maps each byte to a hex color from the server-provided palette, and calls `ctx.fillRect(x, y, 1, 1)` for each pixel. The canvas element's dimensions match the grid size (e.g., 500x500), while CSS `width` and `height` are multiplied by the zoom factor. The `imageRendering: 'pixelated'` CSS property ensures sharp edges when zoomed in, preventing the browser from anti-aliasing the pixel art.

**Zoom and pan**: Mouse wheel events adjust the `zoom` state (clamped to 0.5x-20x). The canvas CSS dimensions scale with zoom, creating a natural zoom effect. Panning is initiated by middle-click or right-click drag -- the `dragStart` coordinates are tracked, and mouse movement updates `panOffset` which applies a CSS `transform: translate()` to the canvas container. Right-click context menu is suppressed to enable right-click panning.

**Pixel hover indicator**: When `zoom >= 2` (zoomed in enough to see individual pixels), a white-bordered div is absolutely positioned over the hovered pixel. Its position is computed as `left = x * zoom, top = y * zoom` with `width = zoom, height = zoom`. At low zoom levels, the indicator is hidden because individual pixels are too small to target meaningfully.

**Coordinate-to-pixel mapping**: The `getCanvasCoords` function converts mouse event coordinates to pixel coordinates by: (1) getting the canvas element's bounding rect, (2) subtracting the element's position from the mouse position, (3) dividing by zoom, (4) flooring to integer. It returns null if the coordinates are outside the canvas bounds.

**16-color palette**: The `ColorPalette` component renders a flex-wrapped grid of color buttons. The selected color gets a white ring with offset (using Tailwind's `ring-2 ring-white ring-offset-2`) and a slight scale increase. Colors come from the server's `config.colors` array rather than being hardcoded, allowing the server to change the palette without a frontend deploy.

**Cooldown timer**: The `CooldownTimer` component reads `cooldown.remainingSeconds` from the store and displays a countdown. When `canPlace` is true, it shows "Ready" or a green indicator. The countdown updates every second via the `setInterval` managed in the store's `updateCooldown` action.

**Notification system**: Ephemeral notifications (e.g., "Pixel placed!", "Please sign in", "Wait 3s") are managed as local state in the `Canvas` component. They auto-dismiss after 2-3 seconds using `setTimeout`. Positioned as a centered banner at the top of the canvas area.

## Production-Grade Pattern Deep Dives

This section explains each production-grade pattern referenced in the architecture, written for readers encountering these concepts for the first time.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing downstream service. The name comes from electrical circuit breakers: when too much current flows (too many failures), the breaker trips to prevent damage (cascading failure).

**The three states**:
1. **Closed** (normal operation): Requests pass through to the downstream service. Each failure is counted. When failures exceed a threshold (e.g., 50% of the last 5 requests), the circuit "opens."
2. **Open** (protection mode): All requests are immediately routed to a fallback function. No calls are made to the downstream service. This prevents a slow or failing service from consuming the caller's resources (threads, connections, memory) while waiting for timeouts.
3. **Half-open** (recovery test): After a reset timeout (e.g., 30 seconds), the circuit allows exactly one request through. If it succeeds, the circuit closes and normal operation resumes. If it fails, the circuit reopens for another timeout period.

**How it works in this project**: Redis operations (canvas reads, rate limit checks, idempotency lookups, pub/sub publishing) are all wrapped in Opossum circuit breakers configured with 50% error threshold, 5-request volume threshold, 5-second timeout, and 30-second reset timeout. Each breaker has a fallback function defining degraded behavior:
- Canvas read fails -> return empty canvas (client shows blank)
- Rate limit check fails -> allow the placement (fail-open for better UX)
- Event write fails -> pixel is placed in Redis, PostgreSQL insert is queued for retry
- Pub/sub publish fails -> local server broadcasts to its own WebSocket clients only

State changes (open/close/half-open) emit Prometheus gauge updates and Pino log entries for monitoring.

**Why this matters for r/place**: The system's hot path is: check rate limit (Redis) -> update canvas (Redis) -> write event (PostgreSQL) -> publish update (Redis pub/sub). If Redis goes down, without a circuit breaker, every pixel placement would wait 5 seconds for the Redis timeout, then fail. With 100 concurrent users each trying to place pixels, that is 100 requests stacked up every 5 seconds, each consuming a connection and an event loop tick. The circuit breaker detects the failure after 3-5 requests and starts immediately using fallbacks, keeping the server responsive.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In the context of pixel placement, this means a duplicate placement request (caused by network retries, client-side double-clicks, or load balancer request duplication) does not place the pixel twice or create duplicate history entries.

**How idempotency keys work in this project**: Each pixel placement generates a key from `userId + x + y + color` (or a client-provided `X-Idempotency-Key` header). Before processing, the server checks Redis: `GET idempotency:pixel:{key}`. If found, the cached result (success/failure, next placement time) is returned immediately. If not found, the placement is processed normally, and the result is stored in Redis with a 10-second TTL. The short TTL covers the retry window without conflicting with the 5-second cooldown. See `src/shared/idempotency.ts`.

**Fail-open behavior**: If Redis is unavailable (circuit breaker open), the idempotency check is skipped and the request is allowed through. This is acceptable because: (1) duplicate placements on the same pixel produce the same visual result (same color at same position), (2) the only side effect is a duplicate PostgreSQL history entry, which is harmless.

**Why this matters**: Consider a user placing a pixel. The WebSocket/HTTP request is sent, but the response is lost due to a network glitch. The client retries. Without idempotency, the retry would succeed but also reset the cooldown timer (the user now has to wait another 5 seconds). With idempotency, the retry returns the cached result including the original cooldown timestamp, so the user's cooldown is not extended.

### Prometheus Metrics

Prometheus is a monitoring system that collects numerical measurements (metrics) from applications at regular intervals. Applications expose metrics at a `/metrics` HTTP endpoint in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the data as time series for querying, dashboarding, and alerting.

**Three metric types**:
- **Counter**: A monotonically increasing number. Example: `rplace_pixels_placed_total{color}` counts pixel placements by color. Querying the *rate* tells you placements per second.
- **Gauge**: A number that goes up and down. Example: `rplace_active_websocket_connections` shows how many users are currently connected. `rplace_circuit_breaker_state{name}` shows whether each circuit breaker is closed (0), half-open (0.5), or open (1).
- **Histogram**: Tracks value distributions in configurable buckets. Example: `rplace_pixel_placement_duration_seconds` with buckets at 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5 seconds. Lets you compute percentiles: "p95 pixel placement takes 12ms."

**Metrics defined in this project** (15+ total): pixel placement counters by color, placement latency histogram, WebSocket connection gauge, active users gauge (placed a pixel in last 5 minutes), rate limit hit counter, HTTP request counters and latency histograms by method/path/status, Redis and PostgreSQL operation counters with latency histograms, circuit breaker state gauges, idempotency cache hit counter, and snapshot creation counter. Includes Express middleware that automatically tracks HTTP metrics. See `src/shared/metrics.ts`.

**Why metrics matter for r/place**: The architecture targets pixel placement acknowledgment < 50ms (p95) and broadcast to all users < 100ms (p95). Without histograms on placement latency and broadcast latency, you cannot verify these targets. The rate limit hits counter tells you how many users are bumping against the cooldown -- if this spikes, the cooldown duration might be too short. The WebSocket connection gauge directly correlates with memory usage and helps capacity planning.

### Structured Logging

Structured logging means emitting log entries as machine-readable JSON objects instead of free-form text. Instead of `"User abc placed pixel at (100, 200) with color 5 in 8ms"`, the entry is `{"level":"info","traceId":"1710745200-abc123","userId":"abc","x":100,"y":200,"color":5,"latencyMs":8,"event":"pixel_placed"}`.

**Why JSON instead of text**: When 3 API server instances are each processing 20 pixel placements per second and generating hundreds of log lines per second, searching free-form text becomes impossible. JSON logs can be indexed by any field: "show me all pixel placements by user abc where latencyMs > 100" is a trivial query in a log aggregation system but requires complex regex with text logs.

**How Pino works in this project**: Pino outputs JSON in production and pretty-prints in development via `pino-pretty`. Dedicated helper functions provide consistent log structure: `logPixelPlaced(traceId, userId, x, y, color, latencyMs)`, `logRateLimitHit(traceId, userId, remainingSeconds)`, `logWebSocketConnect(userId, username, totalConnections)`, `logCircuitBreakerOpen(circuitName, error)`. Each includes a `traceId` (generated as `timestamp-random`) that links all operations within a single request. See `src/shared/logger.ts`.

**Trace ID propagation**: Each incoming request (HTTP or WebSocket message) generates a unique trace ID. This ID is included in every log entry and Prometheus metric label for that request. When debugging "why did user X's pixel placement take 500ms?", you filter logs by the trace ID and see every step: idempotency check (2ms), rate limit check (1ms), canvas update (3ms), PostgreSQL insert (490ms -- found the bottleneck), pub/sub publish (1ms).

### Rate Limiting

Rate limiting restricts how frequently a client can perform an action. For r/place, this is the core fairness mechanism: without it, bots could paint over the canvas faster than humans could respond.

**How it works in this project**: Redis `SET ratelimit:user:{userId} "1" NX EX 5` provides atomic, race-condition-free per-user cooldown enforcement. The `NX` flag means "set only if the key does not exist" -- if the key already exists (user is on cooldown), the SET returns nil and the placement is rejected. The `EX 5` flag sets a 5-second TTL, after which the key auto-expires and the user can place again.

**Why SET NX EX is better than alternatives**: (1) It is a single atomic Redis command -- no read-then-write race condition exists, even if two requests from the same user arrive on different servers within the same millisecond. (2) The TTL handles cleanup automatically -- no background job needed to expire old keys. (3) It naturally works across multiple server instances because they all share the same Redis.

**Remaining cooldown calculation**: When a placement is rejected, the server uses `PTTL ratelimit:user:{userId}` (millisecond TTL) to tell the client exactly how many seconds remain. The client displays this as a countdown timer.

**Why rate limiting matters for collaborative art**: Without the 5-second cooldown, a single bot could repaint the entire 500x500 canvas (250,000 pixels) in seconds. The cooldown limits each user to 12 placements per minute, ensuring that the canvas evolves as a collaborative effort. The cooldown also bounds the maximum write throughput: 100K concurrent users / 5 seconds = 20K placements/second, which is within the system's design capacity.

### Health Checks

A health check is an HTTP endpoint that reports whether the service is alive and capable of handling requests. Load balancers, container orchestrators, and monitoring systems poll this endpoint to decide where to route traffic and when to restart instances.

**Two levels in this project**:
- **Liveness** (`GET /health`): Returns HTTP 200 if the process is running. Used to detect crashed or frozen processes.
- **Readiness** (`GET /health/ready`): Tests Redis connectivity (`PING`), PostgreSQL connectivity (`SELECT 1`), and returns HTTP 200 only when both are reachable. Includes latency measurements and uptime in the response body.

**Why readiness checks matter for WebSocket servers**: A WebSocket server with a broken Redis connection would accept new client connections but fail to place any pixels (rate limit check fails, canvas update fails, pub/sub publish fails). Without a readiness check, the load balancer would route new users to this broken instance. Users would see the canvas load but every placement would fail with a generic error. The readiness check catches this: Redis is unreachable, the instance reports not-ready, and the load balancer stops sending new connections.

### Redis Cache-Aside

Cache-aside is a caching strategy where the application checks the cache before querying the database. For r/place, this pattern is implicit in the architecture: the canvas state *lives* in Redis as the primary store, and PostgreSQL serves as the persistence layer.

**How it works**: The canvas byte array in Redis is the authoritative real-time state. Pixel placements update Redis first (via `SETRANGE`), then asynchronously log to PostgreSQL's `pixel_events` table. On server restart, if the Redis canvas is empty, the latest PostgreSQL snapshot is loaded into Redis to restore state.

**Why Redis is the primary store (not a cache)**: For r/place, latency is critical -- users expect to see their pixel appear within 100ms. Redis `SETRANGE` for a single byte takes ~0.1ms. A PostgreSQL `UPDATE` for the same operation takes ~2ms. With 20K placements/second, Redis handles the write load effortlessly while PostgreSQL would struggle with row-level locking on a single canvas row. Redis serves as both the hot data store and the pub/sub bus for broadcasting updates.

### RBAC (Role-Based Access Control)

RBAC restricts system access based on roles assigned to users. Instead of per-user permission lists, you define roles with associated capabilities and assign users to roles.

**How it works in this project**: Three roles are defined in the `users.role` column:
- **Guest** (anonymous): Can place pixels and view the canvas. No persistent identity across sessions.
- **User** (registered): Can place pixels, view canvas, and view placement history. Has a persistent username.
- **Admin**: All user capabilities plus: reset canvas, ban/unban users, change cooldown settings, view system statistics.

Admin endpoints (`/api/v1/admin/*`) are protected by middleware that checks `user.role === 'admin'`. Non-admin users receive HTTP 403 Forbidden.

**Why RBAC instead of per-user permissions**: The permission model is simple enough that per-user lists would work, but RBAC is cleaner to implement and extend. Adding a "moderator" role (can ban users but not reset canvas) requires adding one role definition, not updating every moderator's permission list.

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
