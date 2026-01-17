# r/place - Collaborative Real-time Pixel Canvas - Architecture Design

## System Overview

A collaborative real-time pixel art canvas where users can place colored pixels with rate limiting. Inspired by Reddit's r/place experiment, this system allows thousands of users to collaboratively create pixel art on a shared canvas, with each user limited to placing one pixel every few seconds.

## Requirements

### Functional Requirements

- **Shared pixel canvas**: A grid of pixels (500x500 for local dev) that all users see and modify
- **Real-time pixel placement**: Users click to place a colored pixel at any coordinate
- **Rate limiting per user**: Cooldown of 5 seconds between pixel placements
- **Live canvas updates**: All connected users see pixel changes within 100ms
- **Canvas history**: Store all pixel placement events for audit and timelapse
- **Timelapse generation**: Replay canvas evolution from snapshots
- **Color palette**: Fixed 16-color palette for consistency
- **Admin controls**: Ability to reset canvas, ban users, change cooldown settings

### Non-Functional Requirements

- **Scalability**: Support 1,000 concurrent users locally; architecture designed for 100K+ with horizontal scaling
- **Availability**: 99.9% uptime target (8.7 hours downtime/year)
- **Latency**: Pixel placement acknowledgment < 50ms; broadcast to other users < 100ms (p95)
- **Consistency**: Eventual consistency acceptable; last-write-wins for pixel conflicts (rare at 5s cooldown)

## Capacity Estimation

### Local Development Targets (500x500 canvas, ~100 concurrent users)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 500 x 500 = 250,000 pixels | - |
| Canvas memory | 250 KB (1 byte per pixel for color index) | 250,000 pixels x 1 byte |
| Concurrent users | 100 | Local dev target |
| Peak pixel placements | 20 RPS | 100 users / 5s cooldown |
| WebSocket connections | 100 | 1 per user |
| WebSocket messages/sec | 2,000 | 20 placements x 100 recipients |
| Bandwidth (outbound) | ~200 KB/s | 20 msg/s x 10 bytes x 100 users |
| Event storage growth | ~1.7 MB/hour | 20 events/s x 24 bytes/event x 3600s |

### Production Scale Estimates (2000x2000 canvas, 100K concurrent users)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 2000 x 2000 = 4M pixels | - |
| Canvas memory | 4 MB | 4M pixels x 1 byte |
| Peak pixel placements | 20,000 RPS | 100K users / 5s cooldown |
| WebSocket messages/sec | 2 billion | Would require geographic sharding |
| Solution | Regional broadcast zones | Users only see updates in viewport |

### Storage Sizing

| Data Type | Size | Growth Rate | Retention |
|-----------|------|-------------|-----------|
| Canvas state (Redis) | 250 KB | Static | Always in memory |
| Session data (Redis) | ~500 bytes/user | With active users | 24 hour TTL |
| Rate limit keys (Redis) | ~50 bytes/user | With active users | 5 second TTL |
| Pixel events (PostgreSQL) | 24 bytes/event | ~1.7 MB/hour | 30 days |
| Canvas snapshots (PostgreSQL) | 250 KB/snapshot | ~6 MB/day (1/hour) | 90 days |

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx/HAProxy)|
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v---------+        +-----------v---------+
    |   API Server 1    |        |   API Server 2      |        |   API Server 3      |
    |   (Express + WS)  |        |   (Express + WS)    |        |   (Express + WS)    |
    |   Port 3001       |        |   Port 3002         |        |   Port 3003         |
    +---------+---------+        +-----------+---------+        +-----------+---------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v---------+        +-----------v---------+
    |   Redis           |        |   PostgreSQL        |        |   RabbitMQ          |
    |   - Canvas state  |        |   - Pixel events    |        |   - Snapshot jobs   |
    |   - Sessions      |        |   - Snapshots       |        |   - Timelapse gen   |
    |   - Rate limits   |        |   - User accounts   |        |                     |
    |   - Pub/Sub       |        |                     |        |                     |
    +---------+---------+        +---------------------+        +---------------------+
```

### Core Components

| Component | Purpose | Technology | Port |
|-----------|---------|------------|------|
| API Server | HTTP REST + WebSocket server | Express.js + ws | 3001-3003 |
| Canvas Store | Real-time canvas state, rate limits | Redis/Valkey | 6379 |
| Event Store | Pixel history, snapshots, users | PostgreSQL | 5432 |
| Message Queue | Background jobs (snapshots, timelapse) | RabbitMQ | 5672 |
| Load Balancer | Distribute traffic across servers | nginx | 3000 |

### Request Flow: Placing a Pixel

```
1. User clicks canvas at (x=100, y=200) with color=5
   |
2. Frontend sends WebSocket message: { type: "place", x: 100, y: 200, color: 5 }
   |
3. API Server receives message
   |
4. Rate limit check (Redis):
   - GET ratelimit:user:{userId}
   - If exists -> reject with remaining cooldown time
   - If not exists -> continue
   |
5. Update canvas (Redis):
   - SETRANGE canvas:main (100 + 200*500) "\x05"  // atomic byte update
   |
6. Set cooldown (Redis):
   - SET ratelimit:user:{userId} "1" EX 5 NX
   |
7. Record event (PostgreSQL):
   - INSERT INTO pixel_events (x, y, color, user_id, created_at)
   |
8. Publish update (Redis Pub/Sub):
   - PUBLISH canvas:updates "{x:100,y:200,color:5,userId:...}"
   |
9. All API servers receive pub/sub message
   |
10. Each server broadcasts to connected WebSocket clients:
    - ws.send({ type: "update", x: 100, y: 200, color: 5 })
   |
11. Frontend updates local canvas state immediately
```

## Data Model

### Redis Data Structures

```
# Canvas State (byte string, 1 byte per pixel)
canvas:main = <250KB binary string>
# Access: offset = x + y * width
# Update: SETRANGE canvas:main offset colorByte

# Rate Limit Keys (auto-expiring)
ratelimit:user:{userId} = "1"
# TTL: 5 seconds
# Check: SET ... NX EX 5 (returns OK if allowed, nil if blocked)

# Session Storage
session:{sessionId} = {
  "userId": "uuid",
  "username": "string",
  "isGuest": true/false,
  "isAdmin": false,
  "createdAt": "ISO timestamp"
}
# TTL: 24 hours

# Pub/Sub Channel
canvas:updates -> { x: int, y: int, color: int, userId: string, ts: int }
```

### PostgreSQL Schema

```sql
-- Users table (for registered users, not guests)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(32) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_admin BOOLEAN DEFAULT FALSE,
  is_banned BOOLEAN DEFAULT FALSE,
  pixels_placed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);

-- Pixel placement events (append-only log)
CREATE TABLE pixel_events (
  id BIGSERIAL PRIMARY KEY,
  x SMALLINT NOT NULL CHECK (x >= 0 AND x < 2000),
  y SMALLINT NOT NULL CHECK (y >= 0 AND y < 2000),
  color SMALLINT NOT NULL CHECK (color >= 0 AND color < 16),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id VARCHAR(64),  -- For anonymous users
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Partition by time for efficient cleanup
CREATE INDEX idx_pixel_events_created_at ON pixel_events(created_at);
CREATE INDEX idx_pixel_events_coords ON pixel_events(x, y, created_at DESC);

-- Canvas snapshots for timelapse
CREATE TABLE canvas_snapshots (
  id SERIAL PRIMARY KEY,
  canvas_data BYTEA NOT NULL,  -- 250KB compressed
  width SMALLINT NOT NULL,
  height SMALLINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_snapshots_created_at ON canvas_snapshots(created_at);

-- Admin audit log
CREATE TABLE admin_actions (
  id SERIAL PRIMARY KEY,
  admin_user_id UUID REFERENCES users(id),
  action_type VARCHAR(32) NOT NULL,  -- 'reset_canvas', 'ban_user', 'change_cooldown'
  target_user_id UUID REFERENCES users(id),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Data Size Estimates

| Table | Row Size | Rows/Day (100 users) | Daily Growth |
|-------|----------|----------------------|--------------|
| pixel_events | ~48 bytes | ~1.7M | ~82 MB |
| canvas_snapshots | ~250 KB | 24 | ~6 MB |
| users | ~300 bytes | 10 new | ~3 KB |
| admin_actions | ~200 bytes | 5 | ~1 KB |

## API Design

### REST Endpoints

```
# Authentication
POST   /api/v1/auth/register     - Create account { username, password }
POST   /api/v1/auth/login        - Login { username, password }
POST   /api/v1/auth/logout       - End session
POST   /api/v1/auth/guest        - Create anonymous session
GET    /api/v1/auth/me           - Get current user info

# Canvas
GET    /api/v1/canvas            - Get full canvas state (binary)
GET    /api/v1/canvas/info       - Get canvas metadata { width, height, cooldown }

# History
GET    /api/v1/history/pixel?x=&y=        - Get placement history for pixel
GET    /api/v1/history/user/:userId       - Get user's placement history
GET    /api/v1/history/recent?limit=100   - Recent placements

# Timelapse
GET    /api/v1/timelapse/snapshots        - List available snapshots
GET    /api/v1/timelapse/snapshot/:id     - Get specific snapshot

# Admin (requires admin role)
POST   /api/v1/admin/reset-canvas         - Clear canvas to white
POST   /api/v1/admin/ban-user             - Ban user { userId }
POST   /api/v1/admin/unban-user           - Unban user { userId }
PUT    /api/v1/admin/settings             - Update settings { cooldownSeconds }
GET    /api/v1/admin/stats                - Get system statistics
```

### WebSocket Protocol

```javascript
// Client -> Server
{ type: "place", x: number, y: number, color: number }
{ type: "ping" }

// Server -> Client
{ type: "update", x: number, y: number, color: number, userId?: string }
{ type: "error", code: string, message: string, cooldownRemaining?: number }
{ type: "pong" }
{ type: "welcome", userId: string, cooldown: number, canvasInfo: {...} }

// Error codes
"RATE_LIMITED"     - User must wait before placing another pixel
"INVALID_COORDS"   - x/y out of canvas bounds
"INVALID_COLOR"    - Color index not in palette
"UNAUTHORIZED"     - No valid session
"BANNED"           - User is banned
```

## Key Design Decisions

### Real-time Pixel Synchronization

**Approach**: WebSocket connections with Redis Pub/Sub for cross-server broadcast.

**How it works**:
1. Each API server maintains WebSocket connections to its clients
2. On pixel placement, server publishes to Redis channel `canvas:updates`
3. All servers subscribe to this channel and broadcast to their clients
4. Clients apply updates immediately to their local canvas state

**Why this works for our scale**:
- 100 users x 20 updates/sec = 2,000 messages/sec - easily handled
- Redis Pub/Sub is fire-and-forget (low latency)
- Horizontal scaling: add more API servers behind load balancer

**Trade-offs**:
- No message persistence (if client disconnects, misses updates)
- Mitigation: Client fetches full canvas on reconnect
- At extreme scale (100K+ users), would need geographic sharding or viewport-based updates

### Rate Limiting Strategy

**Approach**: Redis SET with NX (not exists) and EX (expire) flags.

```javascript
// Pseudo-code
const key = `ratelimit:user:${userId}`;
const result = await redis.set(key, "1", { NX: true, EX: 5 });
if (result === null) {
  const ttl = await redis.ttl(key);
  throw new RateLimitError(ttl);
}
// Proceed with pixel placement
```

**Why this approach**:
- Atomic: no race conditions between check and set
- Automatic cleanup: TTL expires the key
- Distributed: works across multiple API servers
- Simple: single Redis command

**Trade-offs**:
- Fixed window, not sliding window (slightly less fair at boundaries)
- For premium tiers with different cooldowns, use per-tier TTL values

### Canvas State Management

**Approach**: Single Redis key with byte array, using SETRANGE for atomic updates.

```javascript
// Canvas stored as single binary string
// 500x500 = 250,000 bytes, each byte is a color index (0-15)
const offset = x + y * CANVAS_WIDTH;
await redis.setRange("canvas:main", offset, Buffer.from([colorIndex]));
```

**Why this approach**:
- Memory efficient: 250KB for entire canvas
- Atomic updates: SETRANGE is atomic
- Fast reads: GET returns entire canvas in one call
- Simple addressing: offset = x + y * width

**Trade-offs**:
- Single key can't be sharded (fine for 500x500, needs tiles for larger)
- Full canvas download on connect (~250KB, gzip compresses to ~50KB)

### Consistency Model

**Approach**: Last-write-wins with eventual consistency.

**Rationale**:
- Conflicts are rare: 5-second cooldown means low contention per pixel
- Visual consistency is achieved within 100ms (broadcast latency)
- Audit trail in PostgreSQL preserves complete history

**Trade-offs**:
- If two users place on same pixel within milliseconds, one "wins" arbitrarily
- Acceptable for collaborative art (not financial transactions)

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Frontend** | React 19 + Zustand + Tailwind | Standard stack per CLAUDE.md guidelines |
| **API Server** | Express.js + TypeScript | Simple, familiar, good WebSocket support |
| **WebSocket** | ws library | Native Node.js WebSocket, lightweight |
| **Canvas Store** | Redis/Valkey | Sub-millisecond reads, pub/sub built-in |
| **Event Store** | PostgreSQL | Reliable, queryable event history |
| **Message Queue** | RabbitMQ | Background jobs (snapshots, cleanup) |
| **Load Balancer** | nginx | WebSocket support, health checks |

## Security Considerations

### Authentication and Authorization

| User Type | Auth Method | Capabilities |
|-----------|-------------|--------------|
| Anonymous Guest | Session cookie (Redis) | Place pixels, view canvas |
| Registered User | Session cookie + password | Place pixels, view history, profile |
| Admin | Session + admin flag | All above + ban users, reset canvas, change settings |

**Session Security**:
- Session ID: 32-byte random, stored in HTTP-only cookie
- Session data: stored in Redis with 24-hour TTL
- CSRF protection: Origin header validation for WebSocket
- Rate limit on auth endpoints: 5 attempts per minute per IP

### Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| Pixel placement | 1 per 5 seconds | Per user |
| Auth attempts | 5 per minute | Per IP |
| Canvas download | 10 per minute | Per IP |
| API requests | 100 per minute | Per user |

### Input Validation

```javascript
// All pixel placements validated
const schema = {
  x: { type: 'integer', min: 0, max: CANVAS_WIDTH - 1 },
  y: { type: 'integer', min: 0, max: CANVAS_HEIGHT - 1 },
  color: { type: 'integer', min: 0, max: 15 }
};
```

### Data Protection

- Passwords: bcrypt with cost factor 12
- Sessions: secure, HTTP-only cookies
- HTTPS: required in production (local dev uses HTTP)
- No PII stored for anonymous users

## Observability

### Metrics (Prometheus format)

```
# Application metrics
rplace_pixels_placed_total{color}          - Counter: total pixels placed by color
rplace_active_connections                  - Gauge: current WebSocket connections
rplace_http_requests_total{method,path,status}
rplace_http_request_duration_seconds{method,path}

# Business metrics
rplace_active_users                        - Gauge: users who placed pixel in last 5 min
rplace_rate_limit_hits_total               - Counter: rate limit rejections

# Infrastructure metrics
redis_connection_pool_size
redis_commands_total{command}
postgres_connection_pool_size
postgres_query_duration_seconds{query}
```

### Logging

```javascript
// Structured JSON logging
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00Z",
  "service": "api-server",
  "instance": "server-1",
  "event": "pixel_placed",
  "userId": "uuid",
  "x": 100,
  "y": 200,
  "color": 5,
  "latencyMs": 12
}
```

**Log Levels**:
- ERROR: Failed pixel placements, database errors, WebSocket disconnects
- WARN: Rate limit hits, validation failures, slow queries (>100ms)
- INFO: Pixel placements, user logins, admin actions
- DEBUG: WebSocket messages, cache hits/misses (dev only)

### Tracing

For local development, basic request tracing with correlation IDs:

```javascript
// Each request gets a trace ID
req.traceId = crypto.randomUUID();
// Logged with all related operations
logger.info({ traceId: req.traceId, event: 'pixel_placed', ... });
```

### Health Checks

```
GET /health          - Basic liveness (returns 200 if server running)
GET /health/ready    - Readiness (checks Redis + PostgreSQL connections)

Response:
{
  "status": "healthy",
  "redis": "connected",
  "postgres": "connected",
  "uptime": 3600,
  "version": "1.0.0"
}
```

### Alerting Thresholds (for production)

| Metric | Warning | Critical |
|--------|---------|----------|
| Error rate | > 1% | > 5% |
| p95 latency | > 200ms | > 500ms |
| WebSocket connections | > 80% capacity | > 95% capacity |
| Redis memory | > 70% | > 90% |
| PostgreSQL connections | > 80% pool | > 95% pool |

## Failure Handling

### Component Failure Scenarios

| Component | Failure Mode | Impact | Mitigation |
|-----------|--------------|--------|------------|
| API Server | Crash | 1/N users disconnected | Load balancer health checks, auto-restart |
| Redis | Down | No pixel placements | Reconnect with exponential backoff, circuit breaker |
| PostgreSQL | Down | No history writes | Buffer events in memory/queue, retry |
| RabbitMQ | Down | No snapshots | Jobs pile up, catch up on recovery |
| Network partition | Split brain | Temporary inconsistency | Redis pub/sub auto-reconnects |

### Retry Strategy

```javascript
// Exponential backoff with jitter
const retryWithBackoff = async (fn, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, i), 10000);
      const jitter = Math.random() * 1000;
      await sleep(delay + jitter);
    }
  }
};
```

### Circuit Breaker (for external calls)

```javascript
// Simple circuit breaker for PostgreSQL writes
class CircuitBreaker {
  constructor(threshold = 5, timeout = 30000) {
    this.failures = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED';
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }
    // ... execute and track failures
  }
}
```

### Data Recovery

**Redis (canvas state)**:
- If Redis restarts, canvas is lost
- Recovery: Load latest PostgreSQL snapshot
- Prevention: Redis persistence (RDB snapshots every 5 min)

**PostgreSQL (history)**:
- Daily automated backups
- Point-in-time recovery enabled
- Backup retention: 7 days

### Graceful Degradation

| Failure | Degraded Behavior |
|---------|-------------------|
| History write fails | Pixel still placed, event queued for retry |
| Snapshot job fails | Timelapse has gaps, job retried |
| Rate limit check fails | Default to allowing (fail open for UX) |
| WebSocket broadcast fails | Other servers still broadcast |

## Cost Tradeoffs

### Local Development Resource Usage

| Resource | Allocation | Notes |
|----------|------------|-------|
| Redis memory | 50 MB | Canvas + sessions + rate limits |
| PostgreSQL storage | 500 MB | 1 week of events + snapshots |
| API Server memory | 256 MB | Per instance |
| Total RAM | < 1 GB | Fits on laptop |

### Scaling Cost Factors

| Scaling Dimension | Cost Driver | Optimization |
|-------------------|-------------|--------------|
| More users | WebSocket connections, bandwidth | Batch broadcasts, viewport-only updates |
| Larger canvas | Redis memory, snapshot size | Tile-based storage, compression |
| Longer history | PostgreSQL storage | Partition + archive old data |
| Higher availability | Replica instances | Accept single Redis for local dev |

### Build vs Buy Decisions

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Real-time | Custom WebSocket | Simple protocol, full control |
| Rate limiting | Custom Redis | Simple logic, avoid dependency |
| Session store | express-session + Redis | Proven library |
| Message queue | RabbitMQ | Overkill for local, but good for learning |

## Scalability Considerations

### Horizontal Scaling Path

1. **Current (Local Dev)**: Single instance of each component
2. **Stage 2 (1K users)**: 3 API servers, Redis cluster, PostgreSQL primary-replica
3. **Stage 3 (10K users)**: Add CDN for static assets, read replicas for history
4. **Stage 4 (100K+ users)**: Geographic distribution, canvas tiling, viewport-based updates

### Bottleneck Analysis

| Component | Bottleneck | Threshold | Solution |
|-----------|------------|-----------|----------|
| API Server | WebSocket connections | ~10K per server | Add more servers |
| Redis | Memory | ~1GB for canvas | Tile-based sharding |
| Redis Pub/Sub | Fan-out | ~100K msg/sec | Partition by viewport |
| PostgreSQL | Write throughput | ~10K events/sec | Batch inserts, partitioning |

## Trade-offs and Alternatives

### Canvas Storage Alternatives

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| Redis byte array | Simple, fast, atomic | Can't shard | < 10M pixels |
| Redis hash | Per-pixel ops | More memory overhead | Need pixel metadata |
| Tile-based (multiple keys) | Shardable, partial loads | Complex addressing | > 10M pixels |
| PostgreSQL only | Durable, queryable | Too slow for real-time | Backup only |

### Real-time Alternatives

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| Redis Pub/Sub | Simple, fast | No persistence | Real-time, ephemeral |
| Kafka | Durable, replayable | Complex, overkill | Need message history |
| WebSocket only | No external dependency | Single server only | MVP |
| Server-Sent Events | Simpler client | One-way only | Read-heavy |

### Rate Limiting Alternatives

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| Fixed window (current) | Simple, efficient | Boundary burst | Most cases |
| Sliding window | Smoother limiting | More complex | Premium tiers |
| Token bucket | Bursty allowed | Harder to explain | API rate limiting |
| Leaky bucket | Steady output | Complex | Traffic shaping |

## Future Optimizations

### Phase 1 (Implemented)
- [x] Core pixel placement flow
- [x] WebSocket real-time updates
- [x] Rate limiting with Redis TTL
- [x] Session authentication

### Phase 2 (Planned)
- [ ] Canvas snapshot worker (RabbitMQ job)
- [ ] Timelapse viewer component
- [ ] Admin dashboard
- [ ] User profiles with stats

### Phase 3 (Future)
- [ ] Batch WebSocket messages (reduce overhead at scale)
- [ ] Viewport-based updates (only send visible pixels)
- [ ] Canvas compression (gzip for initial load)
- [ ] Hot-pixel detection (popular areas)

### Phase 4 (Scale)
- [ ] Tile-based canvas storage
- [ ] Geographic distribution
- [ ] Read replicas for history
- [ ] CDN for static assets
