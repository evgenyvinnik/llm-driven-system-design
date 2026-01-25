# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. As a backend engineer, I'll focus on the real-time infrastructure, distributed state management, efficient broadcasting, and ensuring the system handles massive concurrent connections. Let me clarify the requirements."

---

## 🎯 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A large grid where any authenticated user can place a colored pixel
2. **Rate Limiting** - Users can only place one pixel every N seconds (e.g., 5 seconds)
3. **Real-time Updates** - All users see pixel placements from others instantly
4. **Color Palette** - Limited color selection (16 colors)
5. **Canvas History** - Store all pixel placement events for audit and timelapse
6. **Timelapse Generation** - Create videos showing canvas evolution

### Non-Functional Requirements

- **Latency** - Pixel updates visible to all users within 100ms
- **Scale** - Support 100K+ concurrent WebSocket connections
- **Consistency** - Eventual consistency acceptable with last-write-wins
- **Availability** - 99.9% uptime during events

### Backend-Specific Considerations

- Atomic pixel placement to prevent race conditions
- Efficient fan-out to millions of connections
- Distributed rate limiting across server instances
- Durable event logging for history reconstruction

---

## 📊 2. Scale Estimation (3 minutes)

### Traffic Estimates

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 500 × 500 = 250K pixels | Local dev target |
| Canvas memory | 250 KB | 1 byte per pixel (color index) |
| Concurrent users | 100K | Production target |
| Peak pixel placements | 20,000 RPS | 100K users / 5s cooldown |
| WebSocket messages/sec | 2 billion | 20K updates × 100K recipients |

### Storage Estimates

| Data Type | Size | Growth Rate |
|-----------|------|-------------|
| Canvas state (Redis) | 250 KB | Static |
| Rate limit keys | ~50 bytes/user | Active users only |
| Pixel events (PostgreSQL) | 48 bytes/event | ~1.7M rows/day |
| Canvas snapshots | 250 KB/snapshot | 24/day |

---

## 🏗️ 3. High-Level Architecture (5 minutes)

```
                                    ┌──────────────────┐
                                    │   Load Balancer  │
                                    │  (nginx/HAProxy) │
                                    └────────┬─────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
    ┌─────────▼─────────┐        ┌───────────▼─────────┐        ┌──────────▼──────────┐
    │   API Server 1    │        │   API Server 2      │        │   API Server N      │
    │   (Express + WS)  │        │   (Express + WS)    │        │   (Express + WS)    │
    └─────────┬─────────┘        └───────────┬─────────┘        └──────────┬──────────┘
              │                              │                              │
              └──────────────────────────────┼──────────────────────────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
    ┌─────────▼─────────┐        ┌───────────▼─────────┐        ┌──────────▼──────────┐
    │   Redis Cluster   │        │   PostgreSQL        │        │   RabbitMQ          │
    │   - Canvas state  │        │   - Pixel events    │        │   - Snapshot jobs   │
    │   - Sessions      │        │   - Snapshots       │        │   - Timelapse gen   │
    │   - Rate limits   │        │   - User accounts   │        │                     │
    │   - Pub/Sub       │        │                     │        │                     │
    └───────────────────┘        └─────────────────────┘        └─────────────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| API Server | HTTP REST + WebSocket server | Express.js + ws |
| Canvas Store | Real-time canvas state, rate limits | Redis/Valkey |
| Event Store | Pixel history, snapshots, users | PostgreSQL |
| Message Queue | Background jobs (snapshots, timelapse) | RabbitMQ |

---

## 🔧 4. Deep Dive: Redis Canvas State Management (8 minutes)

### Canvas Storage Strategy

"I store the canvas as a single binary string in Redis. Each byte represents one pixel's color (0-15). For a 500×500 canvas, that's 250KB total."

| Key | Type | Size | Description |
|-----|------|------|-------------|
| `canvas:main` | Binary string | 250 KB | Pixel at (x,y) = offset x + y × WIDTH |

### Why Redis Byte Array?

| Benefit | Explanation |
|---------|-------------|
| Memory Efficiency | 250KB for entire canvas (1 byte per pixel for 16 colors) |
| Atomic Updates | SETRANGE provides atomic byte-level updates |
| Fast Reads | GET returns entire canvas in single operation |
| Simple Addressing | offset = x + y × width |

### Pixel Placement Logic

**Step 1: Validate coordinates**
- Check 0 ≤ x < CANVAS_WIDTH and 0 ≤ y < CANVAS_HEIGHT
- Check 0 ≤ color < 16

**Step 2: Check rate limit atomically**
- Key: `ratelimit:user:{userId}`
- Command: SET with NX (only if not exists) and EX (expiry in seconds)
- If SET returns null, key existed → user is rate limited
- Get TTL to tell user how long to wait

**Step 3: Update canvas**
- Calculate offset: x + y × CANVAS_WIDTH
- Command: SETRANGE canvas:main {offset} {colorByte}

**Step 4: Broadcast and persist**
- PUBLISH to `canvas:updates` channel (JSON: x, y, color, userId, timestamp)
- Queue event for PostgreSQL persistence via RabbitMQ

**Step 5: Return success**
- Include `nextPlacement` timestamp (now + cooldown) for client UI

### Circuit Breaker Pattern

"I wrap Redis operations in a circuit breaker to handle failures gracefully."

| State | Behavior | Transition |
|-------|----------|------------|
| CLOSED | Requests flow normally | → OPEN after 5 failures |
| OPEN | Requests fail immediately, return fallback | → HALF_OPEN after 30s |
| HALF_OPEN | Test single request | → CLOSED on success, → OPEN on failure |

**Fallback behavior:** When Redis is unavailable, reject pixel placements with a friendly "service temporarily unavailable" message. Canvas reads can fall back to CDN-cached snapshot.

---

## 🔧 5. Deep Dive: Distributed Rate Limiting (6 minutes)

### Why Redis-Based Rate Limiting?

| Feature | Benefit |
|---------|---------|
| Atomic Operation | SET NX EX prevents race conditions |
| Distributed | Works across all server instances |
| Automatic Cleanup | TTL expires keys automatically |
| Simple | Single Redis command |

### Rate Limit Implementation

**Atomic check-and-set operation:**

| Step | Redis Command | Result |
|------|---------------|--------|
| 1. Try to set | `SET ratelimit:user:{id} 1 NX EX 5` | Returns OK if set, null if exists |
| 2. If exists | `TTL ratelimit:user:{id}` | Returns seconds until expiry |

**Response to client:**
- If allowed: `{ allowed: true, remainingSeconds: 0 }`
- If blocked: `{ allowed: false, remainingSeconds: ttl }`

### Dynamic Rate Limiting Under Load

"During extreme load, we can increase cooldowns to protect the system."

| Condition | Cooldown | Rationale |
|-----------|----------|-----------|
| Current RPS > 50,000 | 60 seconds | System overload protection |
| Current RPS > 20,000 | 30 seconds | High load mitigation |
| Active connections > 100K | 10 seconds | Connection pressure |
| Default | 5 seconds | Normal operation |

### Anti-Abuse Measures

**Layer 1: Per-user rate limit** (primary)
- 1 pixel per 5 seconds per user ID

**Layer 2: Per-IP rate limit** (additional)
- Max 100 placements per IP per minute
- Catches users creating multiple accounts

**Layer 3: Session velocity check**
- Max 60 placements per session per 5 minutes
- Flags suspicious accounts for review

---

## 🔧 6. Deep Dive: WebSocket Broadcasting (8 minutes)

### Redis Pub/Sub Architecture

```
┌─────────────┐     PUBLISH      ┌──────────────────┐
│ API Server  │ ────────────────▶│ Redis Pub/Sub    │
│ (placement) │                  │ canvas:updates   │
└─────────────┘                  └────────┬─────────┘
                                          │
                      ┌───────────────────┼───────────────────┐
                      │ SUBSCRIBE         │ SUBSCRIBE         │ SUBSCRIBE
               ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
               │ API Server 1│     │ API Server 2│     │ API Server N│
               │ 10K clients │     │ 10K clients │     │ 10K clients │
               └─────────────┘     └─────────────┘     └─────────────┘
```

### Broadcast Implementation Strategy

**Message batching for efficiency:**
- Collect incoming pixel events for 50ms
- Send single batched message to all connected clients
- Reduces per-message overhead dramatically

**Broadcast loop:**
1. Subscribe to Redis `canvas:updates` channel
2. On message received, add to pending batch
3. Every 50ms, if batch not empty:
   - Serialize batch as JSON: `{ type: "pixels", events: [...] }`
   - Send to all connected WebSockets in parallel
   - Clear batch

### Connection Handling

**On new connection:**
1. Add to connection set
2. Fetch current canvas from Redis
3. Send welcome message with userId, cooldown status
4. Send full canvas state (base64 encoded)

**On disconnect:**
1. Remove from connection set
2. Clean up any pending requests

### Scaling WebSocket Connections

```
100K connections / 10K per server = 10 WebSocket servers minimum
(Provision 15-20 for headroom)
```

| Resource | Per Server | Notes |
|----------|------------|-------|
| Memory | 1-2 GB | 100 bytes per connection |
| CPU | 2-4 cores | JSON encoding/broadcasting |
| Network | 100 Mbps | Fan-out bandwidth |

### Regional Distribution for Global Scale

```
                    ┌──────────────────┐
                    │   Global LB      │
                    │   (GeoDNS)       │
                    └────────┬─────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
    │ US-West │         │ US-East │         │ Europe  │
    │ Cluster │         │ Cluster │         │ Cluster │
    └────┬────┘         └────┬────┘         └────┬────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                    ┌────────▼────────┐
                    │ Kafka (Global)  │
                    │ Pixel Events    │
                    └─────────────────┘
```

"Each region has local Redis for pub/sub. Kafka provides global event ordering and cross-region replication."

---

## 💾 7. Deep Dive: Event Persistence and History (5 minutes)

### PostgreSQL Schema

**pixel_events table (append-only log):**

| Column | Type | Constraints |
|--------|------|-------------|
| id | BIGSERIAL | PRIMARY KEY |
| x | SMALLINT | NOT NULL, CHECK (0 ≤ x < 2000) |
| y | SMALLINT | NOT NULL, CHECK (0 ≤ y < 2000) |
| color | SMALLINT | NOT NULL, CHECK (0 ≤ color < 16) |
| user_id | UUID | REFERENCES users(id) ON DELETE SET NULL |
| session_id | VARCHAR(64) | For anti-abuse tracking |
| created_at | TIMESTAMPTZ | DEFAULT NOW() |

**Indexes:**
- `idx_pixel_events_created_at` - Time-based queries for history
- `idx_pixel_events_coords` - (x, y, created_at DESC) for pixel history
- `idx_pixel_events_user` - (user_id, created_at DESC) for user activity

**canvas_snapshots table:**

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| canvas_data | BYTEA | Compressed canvas state |
| width | SMALLINT | Canvas width at time of snapshot |
| height | SMALLINT | Canvas height at time of snapshot |
| created_at | TIMESTAMPTZ | DEFAULT NOW() |

### Async Event Processing

"Events flow through RabbitMQ to decouple the hot path from persistence."

**Worker process:**
1. Consume from `pixel_events` queue
2. Batch events (1000 events or 1 second, whichever first)
3. Batch INSERT into PostgreSQL
4. Acknowledge messages

**Why async persistence?**
- Pixel placement returns immediately (user doesn't wait for DB write)
- Batch inserts are 10-50× faster than individual inserts
- Queue provides buffer during PostgreSQL slowdowns

### Snapshot Worker

"Runs every hour to capture canvas state for timelapse and history."

1. GET `canvas:main` from Redis
2. Compress with gzip (~10× compression ratio)
3. INSERT into `canvas_snapshots`
4. Log snapshot metadata (size, timestamp)

---

## 📡 8. API Design

### WebSocket Protocol

**Client → Server:**

| Message Type | Fields | Description |
|--------------|--------|-------------|
| `place` | x, y, color, requestId | Request to place a pixel |
| `ping` | — | Keepalive (every 30s) |

**Server → Client:**

| Message Type | Fields | Description |
|--------------|--------|-------------|
| `welcome` | userId, cooldown, canvasInfo | Connection established |
| `canvas` | data (base64), width, height | Full canvas state |
| `pixels` | events[] (x, y, color, userId, timestamp) | Batch of updates |
| `success` | requestId, nextPlacement | Placement confirmed |
| `error` | code, message, requestId?, remainingSeconds? | Placement failed |
| `pong` | — | Keepalive response |

**Error Codes:**

| Code | HTTP Equivalent | Description |
|------|-----------------|-------------|
| `INVALID_COORDS` | 400 | x or y out of bounds |
| `INVALID_COLOR` | 400 | color not in palette |
| `RATE_LIMITED` | 429 | User on cooldown |
| `NOT_AUTHENTICATED` | 401 | Session invalid |
| `INTERNAL_ERROR` | 500 | Server error |

### REST API Endpoints

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| GET | `/api/v1/canvas` | Full canvas binary | Binary (250KB) |
| GET | `/api/v1/canvas/info` | Canvas metadata | `{ width, height, colorCount, cooldownSeconds }` |
| GET | `/api/v1/history/pixel?x=&y=` | Pixel placement history | `{ placements: [{color, userId, createdAt}] }` |
| GET | `/api/v1/health` | Health check | `{ status, redis, postgres, connections }` |
| POST | `/api/v1/auth/register` | Create account | `{ success, username }` |
| POST | `/api/v1/auth/login` | Login | `{ success, username, isAdmin }` |
| POST | `/api/v1/auth/logout` | Logout | `{ success }` |
| GET | `/api/v1/auth/me` | Current user | `{ userId, username, isGuest, isAdmin }` |

---

## ⚖️ 9. Trade-offs Analysis

### Trade-off 1: Redis Byte Array vs. Hash per Pixel

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Byte array | 250KB total, atomic SETRANGE, bulk GET | Can't store metadata per pixel |
| ❌ Hash per pixel | Rich metadata per pixel | 250K keys × overhead = GBs, slow iteration |

> "We chose the byte array because canvas state is simply color values—we don't need metadata on the hot path. A hash per pixel would create 250,000 keys with Redis overhead per key (easily 100+ bytes each), ballooning storage to gigabytes. For pixel history, we query PostgreSQL where we DO store full metadata. The trade-off is we can't answer 'who placed this pixel?' without a database query, but that's acceptable since users rarely need that information in real-time."

### Trade-off 2: Sync vs. Async Persistence

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Async via RabbitMQ | Fast response, batch efficiency | Small delay in history availability |
| ❌ Sync PostgreSQL write | Immediate consistency | 5-10ms added latency per placement |

> "We persist events asynchronously because users care about seeing their pixel appear instantly—not about it being in the database. Batching 1000 events into a single INSERT is 50× faster than individual writes. The trade-off is that if a worker crashes, we lose buffered events. We mitigate this with persistent RabbitMQ queues and acknowledgments. In the worst case, we lose 1-2 seconds of history, which is acceptable for a collaborative art project."

### Trade-off 3: Fixed Window vs. Sliding Window Rate Limiting

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Fixed window (TTL) | Single Redis command, O(1) | Burst at window boundaries |
| ❌ Sliding window | Smooth rate limiting | Multiple Redis commands, more complex |

> "We use fixed-window rate limiting because Redis SET NX EX is atomic and simple—one command to check and set the cooldown. Sliding window would require maintaining a sorted set of timestamps and multiple commands per check. The boundary burst issue (user places at 4:59, then again at 5:01) is acceptable because r/place cooldowns are minutes, not seconds—the 'burst' is still just 2 pixels in ~2 minutes. For APIs with sub-second rate limits, sliding window matters more."

---

## 🚨 10. Failure Handling

| Component | Failure Mode | Mitigation |
|-----------|--------------|------------|
| Redis | Down | Circuit breaker, serve cached canvas from CDN |
| PostgreSQL | Down | Buffer events in RabbitMQ, retry on recovery |
| API Server | Crash | Load balancer health checks, client reconnect |
| RabbitMQ | Down | Events lost temporarily, catch up from Redis on recovery |

### Graceful Degradation

"Rate limiting fails OPEN for availability—if we can't check Redis, we allow the placement."

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| Redis rate limit check fails | Allow placement | Better UX than blocking everyone |
| Redis canvas update fails | Reject with retry message | Can't proceed without state |
| PostgreSQL down | Continue operating, buffer events | History is not critical path |

---

## 📝 Summary

"To summarize, I've designed r/place's backend with:

1. **Redis-backed canvas** storing the entire state as a compact byte array with atomic SETRANGE updates
2. **Distributed rate limiting** using Redis SET NX EX for atomic, auto-expiring cooldowns
3. **Redis Pub/Sub** for broadcasting pixel updates across all WebSocket servers in real-time
4. **Async event persistence** via RabbitMQ workers for non-blocking history logging
5. **Circuit breakers** protecting against cascading failures with graceful degradation
6. **Horizontal scaling** through stateless API servers and Redis-based state sharing

The key insight is that the canvas is small enough (250KB) to fit in Redis memory, making reads and writes trivially fast. The challenge is efficiently broadcasting 20,000+ updates per second to 100,000+ connected clients, which we solve through batching, regional distribution, and eventual consistency."
