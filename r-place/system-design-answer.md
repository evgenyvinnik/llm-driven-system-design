# r/place - Collaborative Real-time Pixel Canvas - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. Reddit actually ran this at massive scale—10.4 million concurrent users in 2022. Let me clarify the requirements."

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
- **Scale** - Support 10+ million concurrent users during peak events
- **Consistency** - Every user sees the same canvas state (eventual consistency acceptable with <1s lag)
- **Availability** - Must stay up during the event; downtime ruins the experience

### Out of Scope

"For this discussion, I'll set aside: user authentication details, moderation tools, and mobile app specifics."

---

## 📊 2. Scale Estimation (3 minutes)

### Assumptions (Based on Reddit 2022 r/place)

- Canvas size: 2000 x 2000 pixels = 4 million pixels (expanded during event)
- Rate limit: 1 pixel per 5 minutes per user
- Peak concurrent users: 10.4 million
- Event duration: 4 days
- Total pixels placed: 160+ million

### Traffic Estimates

| Metric | Value | Calculation |
|--------|-------|-------------|
| Max pixel placements | ~35,000/second | 10.4M users / 5 min cooldown |
| Canvas state requests | Served via CDN | Bitmap snapshots cached at edge |
| WebSocket connections | 10.4 million | Concurrent users |

### Storage Estimates

| Data Type | Size | Notes |
|-----------|------|-------|
| Canvas state | 2 MB | 4M pixels × 4 bits (bit-packed for 16 colors) |
| Single pixel event | ~32 bytes | x, y, color, user_id, timestamp (packed) |
| Total events (4 days) | ~5 GB | 160M events × 32 bytes |

---

## 🏗️ 3. High-Level Architecture (8 minutes)

"Reddit's architecture was CDN-first: Fastly served canvas snapshots, while Kafka handled the real-time event stream."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CDN (Fastly)                                    │
│              Canvas bitmap snapshots (1-2 second TTL)                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Cache MISS only
┌─────────────┐     ┌───────────────▼───────────────┐     ┌──────────────┐
│   Web       │────▶│        Load Balancer          │◀────│   Mobile     │
│   Client    │     │                               │     │   Client     │
└─────────────┘     └───────────────┬───────────────┘     └──────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
             │ WebSocket  │  │ WebSocket  │  │ WebSocket  │
             │ Server(Go) │  │ Server(Go) │  │ Server(Go) │
             └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐     ┌─────────────▼─────────────┐     ┌───────▼───────┐
│  Placement    │     │      Redis Cluster        │     │   Kafka       │
│  Service(Go)  │     │  (Canvas bitmap + Rate    │     │ (Event stream)│
│               │     │   limiting)               │     │               │
└───────────────┘     └───────────────────────────┘     └───────┬───────┘
                                                                │
                                                        ┌───────▼───────┐
                                                        │  Cassandra    │
                                                        │ (Event store) │
                                                        └───────────────┘
```

### Core Components (Reddit's Stack)

| Component | Technology | Key Responsibility |
|-----------|------------|-------------------|
| WebSocket Servers | Go | Handle millions of connections via goroutines |
| Placement Service | Go | Validate placements, enforce rate limits |
| Canvas State | Redis | Bit-packed bitmap (4 bits per pixel) |
| Event Stream | Kafka | Real-time fan-out to all WebSocket servers |
| Event Storage | Cassandra | Time-series storage for history/replay |
| CDN | Fastly | Serve canvas snapshots globally |

---

## 💾 4. Data Model (5 minutes)

### Canvas State in Redis (Bit-Packed)

"Reddit stored the canvas as a bit-packed bitmap. With 16 colors (4 bits each), two pixels fit in one byte, halving storage and bandwidth."

| Key | Type | Size | Description |
|-----|------|------|-------------|
| `canvas:bitmap` | String (binary) | 2 MB | Pixel (x,y) at byte (y×width+x)/2, bit offset (y×width+x)%2×4 |
| `ratelimit:{user_id}` | String + TTL | — | Auto-expires after cooldown |

### Kafka Event Schema (Compact)

| Field | Type | Bytes | Description |
|-------|------|-------|-------------|
| x | uint16 | 2 | X coordinate |
| y | uint16 | 2 | Y coordinate |
| color | uint8 | 1 | Color index (0-15) |
| user_id | uint64 | 8 | User identifier |
| timestamp | uint64 | 8 | Unix timestamp (ms) |

### Cassandra Event Table

| Column | Type | Purpose |
|--------|------|---------|
| date | date | Partition key (by day) |
| timestamp | timeuuid | Clustering key, time-ordered |
| x, y | smallint | Coordinates |
| color | tinyint | Color index |
| user_id | bigint | Who placed it |

---

## 🔧 5. Deep Dive: CDN-First Architecture (8 minutes)

### Why CDN-First?

"The key insight: don't serve canvas state from your servers—let the CDN handle it."

```
┌─────────────────────────────────────────────────────────────────┐
│                    CDN-First Canvas Serving                       │
│                                                                  │
│  Client Request                                                  │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────┐     Cache HIT (99.9%)     ┌─────────────────────┐  │
│  │  Fastly │ ──────────────────────────▶│ Return cached       │  │
│  │   CDN   │                            │ bitmap (< 10ms)     │  │
│  └────┬────┘                            └─────────────────────┘  │
│       │                                                          │
│       │ Cache MISS (0.1%)                                        │
│       ▼                                                          │
│  ┌─────────────────────┐                                         │
│  │ Origin: Redis GET   │                                         │
│  │ + Set cache headers │                                         │
│  └─────────────────────┘                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Canvas Update Flow

1. **Snapshot Service** reads canvas from Redis every 1-2 seconds
2. Generates binary bitmap (optionally PNG)
3. Pushes to CDN with short TTL (1-2 seconds)
4. CDN serves globally with edge caching

**Why this works:** 10 million users requesting a 2MB file would be 20 petabytes of bandwidth. CDN handles this trivially. Origin only sees cache misses.

---

## 🔧 6. Deep Dive: Real-time Updates via Kafka (5 minutes)

"Reddit used Kafka as the real-time event bus, not Redis Pub/Sub, because durability matters."

### Event Flow

```
Placement      Kafka         WebSocket      WebSocket      Client
Service    ──▶ Topic    ──▶  Consumers  ──▶ Broadcast  ──▶ Update
   │                           (Go)
   │
   └──▶ Redis SETBIT (update canvas state)
```

### Why Kafka over Redis Pub/Sub?

| Aspect | Kafka | Redis Pub/Sub |
|--------|-------|---------------|
| Durability | ✅ Persisted, replayable | ❌ Fire-and-forget |
| Consumer recovery | ✅ Resume from offset | ❌ Missed messages lost |
| Consumer groups | ✅ Built-in partitioning | ❌ Manual coordination |
| Throughput | ✅ 100K+ msg/sec | ✅ Similar |

### Batched WebSocket Updates

"WebSocket servers batch updates every 1 second to reduce message overhead."

| Approach | Messages/sec to 10M clients | Feasibility |
|----------|----------------------------|-------------|
| Individual pixels | 35,000 × 10M = 350B/s | ❌ Impossible |
| Batched (1s window) | 10M × ~5KB | ✅ 50GB/s (distributed) |

---

## 🔧 7. Deep Dive: Rate Limiting at Scale (3 minutes)

### Redis-Based Rate Limiting

"The key is using Redis SET NX EX for atomic check-and-set."

| Operation | Redis Command | Purpose |
|-----------|---------------|---------|
| Place attempt | `SET ratelimit:{uid} 1 NX EX 300` | Only sets if not exists, expires in 5 min |
| Check remaining | `TTL ratelimit:{uid}` | Returns seconds until can place again |

### Throughput Calculation

```
35K placements/sec × 2 Redis ops = 70K ops/sec
Redis single node capacity: 100K+ ops/sec ✅
```

---

## 📡 8. API Design

### WebSocket Protocol

**Client → Server:**

| Type | Fields | Description |
|------|--------|-------------|
| `place` | x, y, color | Place a pixel |

**Server → Client:**

| Type | Fields | Description |
|------|--------|-------------|
| `init` | canvasUrl, cooldownRemaining | Connection established, CDN URL for canvas |
| `batch` | pixels[] | Batch of pixel updates (every 1s) |
| `placed` | x, y, color, nextPlacement | Confirmation + cooldown end time |
| `error` | code, message, retryAfter | Placement failed |

### REST API Endpoints

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| GET | `/api/v1/canvas` | Redirect to CDN | 302 → CDN URL |
| GET | `/api/v1/canvas/info` | Canvas metadata | `{ width, height, colors, cooldownSec }` |
| GET | `/api/v1/history?t={iso}` | Canvas at timestamp | Binary bitmap |
| GET | `/api/v1/pixel?x={x}&y={y}` | Pixel history | `{ placements: [...] }` |

---

## ⚖️ 9. Trade-offs Analysis

### Trade-off 1: CDN-First vs. Direct Serving

| Approach | Pros | Cons |
|----------|------|------|
| ✅ CDN-first (Fastly) | Handles 10M+ users, global edge caching | 1-2s staleness for full canvas |
| ❌ Direct from Redis | Always fresh | Can't scale to millions of requests |

> "Reddit chose CDN-first because serving a 2MB bitmap to 10 million users directly is impossible—that's 20 petabytes of bandwidth. The CDN handles global distribution with edge caching. The trade-off is 1-2 second staleness for the full canvas, but real-time WebSocket updates provide the latest pixels. Clients render CDN bitmap as background with WebSocket deltas overlaid. This hybrid gives both scalability and real-time feel."

### Trade-off 2: Kafka vs. Redis Pub/Sub for Event Stream

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Kafka | Durable, replayable, consumer groups | 10-50ms latency, operational complexity |
| ❌ Redis Pub/Sub | Sub-millisecond latency | Fire-and-forget, no replay |

> "Reddit used Kafka because durability matters. If a WebSocket server restarts, it replays recent events from Kafka to catch up. If they discover a bug, they can reprocess from the log. With 1-second batching anyway, Kafka's latency is invisible. For a 4-day event where every pixel matters for the final timelapse, Kafka's durability is essential. The trade-off is operational complexity, but Reddit already had Kafka expertise."

### Trade-off 3: Bit-Packed vs. Byte-per-Pixel Storage

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bit-packed (4 bits) | 2MB for 4M pixels, half the bandwidth | Complex bit manipulation |
| ❌ Byte-per-pixel | Simple addressing (offset = y×width+x) | 4MB storage, 2x bandwidth |

> "Reddit bit-packed the canvas because bandwidth is the constraint at scale. With 16 colors, each pixel needs only 4 bits, so two pixels fit in one byte. This halves storage and CDN bandwidth. The trade-off is more complex code: reading pixel (x,y) requires calculating byte offset and bit shift. But this is a one-time implementation cost, and the bandwidth savings compound across 10 million users."

---

## 🚨 10. Failure Scenarios (2 minutes)

| Component | Failure Mode | Mitigation |
|-----------|--------------|------------|
| Redis | Primary down | Redis Cluster with automatic failover |
| Kafka | Broker down | Replication factor 3, leader election |
| WebSocket Server | Crash | Client auto-reconnect, replay from Kafka |
| CDN | Edge failure | Multiple edge PoPs, automatic failover |

### Client Reconnection Strategy

- Exponential backoff: 1s, 2s, 4s, 8s... up to 30s max
- Random jitter to prevent thundering herd
- On reconnect: fetch fresh canvas from CDN, resume WebSocket stream

---

## 📝 Summary

"To summarize, I've designed r/place following Reddit's actual architecture:

1. **CDN-first canvas serving** - Fastly serves 2MB bitmap snapshots, handling 10M+ users
2. **Kafka event stream** - Durable, replayable event log for all pixel placements
3. **Redis for hot state** - Bit-packed canvas bitmap and rate limit keys
4. **Go WebSocket servers** - Millions of connections via goroutines + Kafka consumers
5. **Cassandra for persistence** - Time-series storage for history and timelapse
6. **Batched updates** - 1-second WebSocket batches reduce message overhead 1000x

The key insight is that the canvas is small enough (2MB) to serve via CDN, while real-time updates flow through Kafka → WebSocket. This separation lets the CDN handle read load while the backend focuses on write coordination and real-time fan-out."

---

## ❓ Questions I'd Expect

**Q: How did Reddit handle 10 million WebSocket connections?**
A: Go's goroutine model handles millions of connections efficiently (~10KB per connection). Each server handled ~500K connections, requiring about 20 servers. They used epoll/kqueue for I/O multiplexing.

**Q: How did they expand the canvas mid-event?**
A: The 2022 r/place used a tile-based system where each tile was a separate Redis key. They could add new tiles without touching existing ones, allowing expansion from 1000×1000 to 4000×4000.

**Q: What about the final timelapse?**
A: Kafka retained all 160M events. A batch job read the entire log, reconstructed canvas state at each second, and rendered frames. Processing took a few hours after the event ended.
