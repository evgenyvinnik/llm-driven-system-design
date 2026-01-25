# r/place - Collaborative Real-time Pixel Canvas - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. This is a fascinating real-time systems problem. Let me clarify the requirements."

---

## 🎯 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A large grid where any authenticated user can place a colored pixel
2. **Rate Limiting** - Users can only place one pixel every N minutes (e.g., 5 minutes)
3. **Real-time Updates** - All users see pixel placements from others instantly
4. **Color Palette** - Limited color selection (16-32 colors)
5. **Canvas History** - Ability to view canvas state at any point in time
6. **Timelapse Generation** - Create videos showing canvas evolution

### Non-Functional Requirements

- **Latency** - Pixel updates visible to all users within 500ms
- **Scale** - Support 1+ million concurrent users during peak events
- **Consistency** - Every user sees the same canvas state (eventual consistency acceptable with <1s lag)
- **Availability** - Must stay up during the event; downtime ruins the experience

### Out of Scope

"For this discussion, I'll set aside: user authentication details, moderation tools, and mobile app specifics."

---

## 📊 2. Scale Estimation (3 minutes)

### Assumptions

- Canvas size: 2000 x 2000 pixels = 4 million pixels
- Rate limit: 1 pixel per 5 minutes per user
- Peak concurrent users: 1 million
- Event duration: 4 days

### Traffic Estimates

| Metric | Value | Calculation |
|--------|-------|-------------|
| Max pixel placements | 3,333/second | 1M users / 5 min cooldown |
| Canvas reads | ~100,000/second | With aggressive caching |
| WebSocket connections | 1 million | Concurrent users |

### Storage Estimates

| Data Type | Size | Notes |
|-----------|------|-------|
| Canvas state | 4 MB | 4M pixels × 1 byte (color index) |
| Single pixel event | ~50 bytes | x, y, color, user_id, timestamp |
| Total events (4 days) | ~58 GB | 1.15B events × 50 bytes |

### Bandwidth

- Full canvas download: 4 MB (served from CDN)
- Incremental updates: ~167 KB/second outbound per server cluster

---

## 🏗️ 3. High-Level Architecture (8 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CDN                                        │
│                    (Canvas snapshots, static assets)                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌─────────────┐     ┌───────────────▼───────────────┐     ┌──────────────┐
│   Web       │────▶│        Load Balancer          │◀────│   Mobile     │
│   Client    │     │   (Sticky sessions optional)  │     │   Client     │
└─────────────┘     └───────────────┬───────────────┘     └──────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
             │ WebSocket  │  │ WebSocket  │  │ WebSocket  │
             │ Server 1   │  │ Server 2   │  │ Server N   │
             └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │       Redis Pub/Sub           │
                    │   (Pixel event broadcast)     │
                    └───────────────┬───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐     ┌─────────────▼─────────────┐     ┌───────▼───────┐
│  Pixel        │     │      Redis Cluster        │     │   Kafka       │
│  Service      │     │  (Canvas state + Rate     │     │ (Event log)   │
│               │     │   limiting)               │     │               │
└───────────────┘     └───────────────────────────┘     └───────┬───────┘
                                                                │
                                                        ┌───────▼───────┐
                                                        │  History      │
                                                        │  Service      │
                                                        └───────┬───────┘
                                                                │
                                                        ┌───────▼───────┐
                                                        │  PostgreSQL   │
                                                        │  (Events)     │
                                                        └───────────────┘
```

### Core Components

| Component | Purpose | Key Responsibility |
|-----------|---------|-------------------|
| WebSocket Servers | Client connections | Maintain 100K connections each, push pixel updates |
| Pixel Service | Business logic | Validate placements, enforce rate limits |
| Redis Cluster | Live state | Canvas bitmap, rate limit keys with TTL |
| Redis Pub/Sub | Event broadcast | Fan out pixel events to all WebSocket servers |
| Kafka | Durable log | Persist all pixel events for history/replay |
| History Service | Analytics | Generate snapshots, timelapses, point-in-time views |

---

## 💾 4. Data Model (5 minutes)

### Canvas State in Redis

"I store the entire canvas as a single binary string where each byte represents one pixel's color index (0-15 for 16 colors)."

| Key | Type | Description |
|-----|------|-------------|
| `canvas:current` | String (binary) | 4MB byte array, pixel at (x,y) = offset y × width + x |
| `cooldown:{user_id}` | String + TTL | Timestamp of last placement, auto-expires after 5 min |

**Why this works:** SETRANGE provides atomic single-byte updates. GET returns the entire canvas in one operation. No locking needed.

### Event Schema (PostgreSQL)

| Column | Type | Purpose |
|--------|------|---------|
| id | BIGSERIAL | Primary key |
| x | SMALLINT | X coordinate (0-1999) |
| y | SMALLINT | Y coordinate (0-1999) |
| color | SMALLINT | Color index (0-15) |
| user_id | UUID | Who placed it |
| placed_at | TIMESTAMP | When (partitioned by time) |

### Canvas Snapshots

| Column | Type | Purpose |
|--------|------|---------|
| id | SERIAL | Primary key |
| captured_at | TIMESTAMP | Snapshot time |
| canvas_data | BYTEA | Compressed canvas state |
| pixel_count | INTEGER | Running total of placements |

---

## 🔧 5. Deep Dive: Pixel Placement Flow (10 minutes)

### Request Flow

```
User clicks      WebSocket        Pixel           Redis           Redis
canvas    ─────▶ Server    ─────▶ Service  ─────▶ (Rate Limit) ─▶ (Canvas)
                    │                                   │             │
                    │◀──────────────────────────────────┴─────────────┘
                    │                    │
                    │                    ▼
                    │              Redis Pub/Sub ────▶ All WebSocket Servers
                    │                                        │
                    ▼                                        ▼
               Response to                           Broadcast to
               this client                           all clients
```

### Placement Logic (Step by Step)

1. **Validate coordinates** - Ensure 0 ≤ x < WIDTH and 0 ≤ y < HEIGHT
2. **Validate color** - Ensure color is in valid palette (0-15)
3. **Check rate limit atomically** - Redis SET with NX (only if not exists) and EX (5 min expiry)
4. **Update canvas** - Redis SETRANGE at calculated offset
5. **Publish event** - Redis PUBLISH to `pixel_updates` channel
6. **Log to Kafka** - For durability and history reconstruction
7. **Return success** - Include `next_placement` timestamp for client cooldown UI

### Rate Limiting Deep Dive

"The key insight is using Redis SET NX EX as an atomic check-and-set operation."

| Operation | Redis Command | Purpose |
|-----------|---------------|---------|
| Check + Set | `SET cooldown:{uid} 1 NX EX 300` | Only sets if key doesn't exist, auto-expires |
| Get TTL | `TTL cooldown:{uid}` | Returns remaining cooldown seconds |

**Why this works:** NX prevents race conditions where two requests slip through. EX auto-cleans expired keys. No separate check-then-set that could race.

---

## 🔧 6. Deep Dive: Scaling WebSocket Connections (5 minutes)

### Connection Distribution

```
1 million connections / 100,000 per server = 10 WebSocket servers minimum
(Provision 15-20 for headroom and rolling deploys)
```

### Server Resource Requirements

| Resource | Per Server | Notes |
|----------|------------|-------|
| Memory | 1-2 GB | ~10KB per connection |
| CPU | 4-8 cores | JSON encoding, broadcast loops |
| Network | 100+ Mbps | Fan-out to 100K clients |

### Regional Distribution

```
                    ┌─────────────────┐
                    │   Global LB     │
                    │  (GeoDNS)       │
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────▼─────┐       ┌─────▼────┐       ┌─────▼────┐
    │  US-West │       │  US-East │       │  Europe  │
    │  Cluster │       │  Cluster │       │  Cluster │
    └────┬─────┘       └────┬─────┘       └────┬─────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                    ┌───────▼───────┐
                    │ Kafka (Global)│
                    │  Event Stream │
                    └───────────────┘
```

"Each region has local Redis for pub/sub. Kafka provides global ordering and cross-region replication. Users connect to nearest region for lowest latency."

---

## 🔧 7. Deep Dive: Canvas History and Timelapse (3 minutes)

### Snapshot Strategy

| Interval | Purpose | Storage |
|----------|---------|---------|
| Every 30 seconds | Fine-grained history | ~2,880/day |
| Compressed | Reduce storage | ~1MB per snapshot (zlib) |

### Point-in-Time Reconstruction

1. Find nearest snapshot before target time
2. Decompress snapshot into memory
3. Replay events from snapshot time to target time
4. Each event: set canvas[y × width + x] = color

### Timelapse Generation

1. Query snapshots at desired frame interval
2. Decompress each snapshot
3. Convert to image frame (color palette lookup)
4. Encode as video (ffmpeg or similar)

---

## 📡 8. API Design

### WebSocket Protocol

**Client → Server Messages:**

| Type | Fields | Description |
|------|--------|-------------|
| `place` | x, y, color, requestId | Place a pixel |
| `ping` | — | Keep connection alive |

**Server → Client Messages:**

| Type | Fields | Description |
|------|--------|-------------|
| `welcome` | userId, cooldownRemaining, canvasInfo | Connection established |
| `canvas` | data (base64), width, height | Full canvas state |
| `pixels` | events[] | Batch of pixel updates |
| `success` | requestId, nextPlacement | Placement confirmed |
| `error` | code, message, requestId?, remainingSeconds? | Placement failed |
| `pong` | — | Heartbeat response |

### REST API Endpoints

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| GET | `/api/v1/canvas` | Full canvas binary | Binary data (4MB) |
| GET | `/api/v1/canvas/info` | Canvas metadata | `{ width, height, colorCount, cooldownSeconds }` |
| GET | `/api/v1/history/pixel?x={x}&y={y}` | Pixel history | `{ placements: [{ color, userId, placedAt }] }` |
| GET | `/api/v1/history/snapshot?time={iso}` | Canvas at time | Binary data |
| GET | `/api/v1/auth/me` | Current user info | `{ userId, username, isGuest }` |
| POST | `/api/v1/auth/login` | Login | `{ success, username }` |
| POST | `/api/v1/auth/logout` | Logout | `{ success }` |

---

## ⚖️ 9. Trade-offs Analysis

### Trade-off 1: Single Redis Key vs. Tile-Based Sharding

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Single Redis key | Atomic updates, simple addressing, no coordination | Limited to ~16K×16K (256MB) |
| ❌ Tile-based sharding | Unlimited canvas size | Cross-tile transactions, cache invalidation complexity |

> "We chose a single Redis byte array because our 2000×2000 canvas (4MB) fits comfortably in memory. With SETRANGE, pixel updates are atomic single-byte writes requiring zero coordination. A tile system would need cross-shard transactions when users view tile boundaries, and cache invalidation becomes complex when tiles overlap in the viewport. The 256MB theoretical limit far exceeds our needs. If we needed a 100K×100K canvas, we'd redesign with tiles—but for r/place's actual scale, simplicity wins. The trade-off is we can't horizontally scale canvas storage itself, but a single Redis instance handles our write throughput easily."

### Trade-off 2: Redis Pub/Sub vs. Kafka for Real-time Broadcast

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Redis Pub/Sub | Sub-millisecond latency, simple | No persistence, missed messages are lost |
| ❌ Kafka for broadcast | Durable, replayable | Higher latency (10-50ms), overkill for ephemeral updates |

> "We use Redis Pub/Sub for real-time broadcast because pixel updates are ephemeral—if a client misses one update, the next batch will include the current state anyway. Pub/Sub delivers in under 1ms, critical for the 'instant' feel users expect. Kafka's durability is wasted here since we don't need replay for live updates. However, we DO send events to Kafka in parallel for history—this gives us durability for timelapse without adding latency to the hot path. The trade-off is that during Redis Pub/Sub failures, clients see stale canvases until reconnection triggers a full canvas fetch."

### Trade-off 3: Eventual Consistency vs. Strong Consistency

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Eventual consistency | Multi-region deployment, high availability | Users may briefly see different states |
| ❌ Strong consistency | Perfect agreement | Single region or high latency, reduced availability |

> "We accept eventual consistency with ~500ms lag because r/place is fundamentally a collaborative art project, not a financial system. If two users in different regions place pixels simultaneously, last-write-wins is acceptable—there's no 'incorrect' pixel, just the most recent one. Strong consistency would require either single-region deployment (bad latency for global users) or distributed consensus (adding 100-200ms per write). During the 2017 r/place event, Reddit observed that users naturally adapted to brief inconsistencies. The trade-off is that during network partitions, regions may diverge temporarily, but Kafka's global ordering reconciles them within seconds."

---

## 🚨 10. Failure Scenarios (2 minutes)

| Component | Failure Mode | Mitigation |
|-----------|--------------|------------|
| Redis | Primary down | Replica promotion, serve cached canvas from CDN |
| WebSocket Server | Crash | Load balancer health checks, client auto-reconnect |
| Kafka | Partition unavailable | Buffer events in memory, retry on recovery |
| PostgreSQL | Down | History writes queued in Kafka, catch up on recovery |

### Client Reconnection Strategy

- Exponential backoff: 1s, 2s, 4s, 8s... up to 30s max
- Random jitter: ±0-1000ms to prevent thundering herd
- On reconnect: fetch fresh canvas state, resume from current

---

## 📝 Summary

"To summarize, I've designed r/place with:

1. **Redis-backed canvas** storing the entire 4MB state as a byte array for atomic reads/writes
2. **Redis Pub/Sub** for broadcasting pixel updates across all WebSocket servers in sub-millisecond time
3. **Atomic rate limiting** using SET NX EX to prevent race conditions
4. **Kafka event log** for durability, history reconstruction, and cross-region sync
5. **Regional clusters** with global coordination for worldwide scale
6. **Snapshot system** enabling point-in-time views and timelapse generation

The key insight is that the canvas is small enough to fit in memory, making reads trivial, while the real challenge is efficiently broadcasting 3,000+ updates per second to 1 million connected clients. We solve this through batched WebSocket messages, regional distribution, and accepting eventual consistency."

---

## ❓ Questions I'd Expect

**Q: What if someone tries to overwrite pixels programmatically?**
A: Rate limiting applies equally to all users. We can add CAPTCHA for suspicious accounts and IP-based rate limits. The 5-minute cooldown makes botting ineffective for claiming territory.

**Q: How do you handle the initial canvas load for a million users?**
A: Canvas is served from CDN as a compressed file (~1MB with gzip). CDN handles millions of concurrent downloads. WebSocket connection only needed for real-time updates after initial load.

**Q: What about moderating inappropriate content?**
A: We log all placements with user IDs. Moderators can view history of any region, ban users retroactively, and use ML-based image recognition to flag problematic patterns in near-real-time.
