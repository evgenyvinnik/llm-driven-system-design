# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels in real-time. As a backend engineer, I'll focus on the real-time infrastructure, distributed state management, Kafka-based event streaming, and scaling WebSocket connections to handle 10+ million concurrent users. Reddit actually achieved 10.4 million concurrent at peak."

---

## 🎯 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A large grid where any authenticated user can place a colored pixel
2. **Rate Limiting** - Users can only place one pixel every 5 minutes
3. **Real-time Updates** - All users see pixel placements from others instantly
4. **Color Palette** - 16-color selection
5. **Canvas History** - Store all pixel placement events for audit and timelapse
6. **Timelapse Generation** - Create videos showing canvas evolution

### Non-Functional Requirements

- **Latency** - Pixel updates visible to all users within 500ms
- **Scale** - Support 10+ million concurrent WebSocket connections
- **Consistency** - Eventual consistency acceptable with last-write-wins
- **Availability** - 99.9% uptime during the 4-day event

### Backend-Specific Considerations

- Atomic pixel placement to prevent race conditions
- Efficient fan-out to 10 million connections via Kafka
- Distributed rate limiting across server instances
- Durable event logging for history reconstruction

---

## 📊 2. Scale Estimation (3 minutes)

### Traffic Estimates (Reddit 2022 Actual)

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 2000 × 2000 = 4M pixels | Expanded during event |
| Canvas memory | 2 MB | Bit-packed: 4 bits/pixel |
| Concurrent users | 10.4 million | Reddit's actual peak |
| Peak pixel placements | 35,000 RPS | 10.4M users / 5 min cooldown |
| Total pixels placed | 160 million | Over 4 days |

### Storage Estimates

| Data Type | Size | Notes |
|-----------|------|-------|
| Canvas state (Redis) | 2 MB | Bit-packed bitmap |
| Rate limit keys | ~100 bytes/user | Active users only, TTL |
| Pixel events (Kafka) | 32 bytes/event | Compact binary format |
| Pixel events (Cassandra) | ~5 GB | 160M events total |

---

## 🏗️ 3. High-Level Architecture (5 minutes)

"Reddit used a CDN-first architecture with Kafka for event streaming. Here's their actual stack."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CDN (Fastly)                                    │
│              Canvas bitmap snapshots (1-2 second TTL)                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
             │ WebSocket  │  │ WebSocket  │  │ WebSocket  │
             │ Server(Go) │  │ Server(Go) │  │ Server(Go) │
             │  500K conn │  │  500K conn │  │  500K conn │
             └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────▼───────┐     ┌─────────────▼─────────────┐     ┌───────▼───────┐
│  Placement    │     │      Redis Cluster        │     │   Kafka       │
│  Service(Go)  │     │  (Canvas bitmap +         │     │ (Event stream)│
│               │     │   Rate limiting)          │     │               │
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
| WebSocket Servers | Go | Handle 500K connections each via goroutines |
| Placement Service | Go | Validate placements, enforce rate limits |
| Canvas State | Redis | Bit-packed bitmap (4 bits per pixel) |
| Event Stream | Kafka | Real-time fan-out + durable log |
| Event Storage | Cassandra | Time-series storage for history |
| CDN | Fastly | Serve canvas bitmap globally |

---

## 🔧 4. Deep Dive: Bit-Packed Canvas in Redis (8 minutes)

### Why Bit-Packing?

"With 16 colors, each pixel needs only 4 bits. Two pixels fit in one byte, halving storage and bandwidth."

| Approach | Storage for 4M pixels | Bandwidth |
|----------|----------------------|-----------|
| ❌ 1 byte per pixel | 4 MB | 4 MB per CDN request |
| ✅ 4 bits per pixel | 2 MB | 2 MB per CDN request |

### Redis Storage

| Key | Type | Size | Description |
|-----|------|------|-------------|
| `canvas:bitmap` | String (binary) | 2 MB | Bit-packed canvas |
| `ratelimit:{userId}` | String + TTL | — | Auto-expires after 5 min |

### Pixel Addressing

**Reading pixel (x, y):**
1. Calculate bit offset: `bitOffset = (y × WIDTH + x) × 4`
2. Calculate byte offset: `byteOffset = bitOffset / 8`
3. Calculate bit position within byte: `bitPos = bitOffset % 8`
4. Extract 4 bits using bit masking

**Writing pixel (x, y, color):**
1. Calculate offsets (same as above)
2. Use Redis BITFIELD command for atomic update
3. `BITFIELD canvas:bitmap SET u4 #bitOffset color`

### Atomic Updates with BITFIELD

| Operation | Command | Purpose |
|-----------|---------|---------|
| Read pixel | `BITFIELD canvas:bitmap GET u4 #offset` | Extract 4-bit value |
| Write pixel | `BITFIELD canvas:bitmap SET u4 #offset color` | Atomic 4-bit update |
| Bulk read | `GET canvas:bitmap` | Entire canvas for CDN |

---

## 🔧 5. Deep Dive: Kafka Event Streaming (8 minutes)

### Why Kafka over Redis Pub/Sub?

| Feature | Kafka | Redis Pub/Sub |
|---------|-------|---------------|
| Durability | ✅ Persisted to disk | ❌ Fire-and-forget |
| Replay | ✅ Consumers resume from offset | ❌ Missed messages lost |
| Consumer groups | ✅ Automatic partitioning | ❌ Manual coordination |
| Throughput | ✅ 100K+ msg/sec sustained | ✅ Higher peak, no durability |

### Event Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kafka Event Flow                              │
│                                                                  │
│  Placement        Kafka           WebSocket         Cassandra   │
│  Service          Cluster         Servers           Workers     │
│     │                │                │                │        │
│     │ 1. Produce     │                │                │        │
│     │───────────────▶│                │                │        │
│     │   pixel_events │                │                │        │
│     │   partition by │                │                │        │
│     │   region       │                │                │        │
│     │                │                │                │        │
│     │                │ 2. Consume     │                │        │
│     │                │───────────────▶│                │        │
│     │                │ (consumer grp) │                │        │
│     │                │                │                │        │
│     │                │ 3. Broadcast   │                │        │
│     │                │ to clients     │                │        │
│     │                │───────────────▶│                │        │
│     │                │                │                │        │
│     │                │ 4. Persist     │                │        │
│     │                │────────────────────────────────▶│        │
│     │                │ (separate grp) │                │        │
│     ▼                ▼                ▼                ▼        │
└─────────────────────────────────────────────────────────────────┘
```

### Kafka Topic Design

| Topic | Partitions | Retention | Purpose |
|-------|------------|-----------|---------|
| `pixel_events` | 16 | 7 days | All pixel placements |
| `pixel_events.us-west` | 4 | 1 hour | Regional fan-out |
| `pixel_events.us-east` | 4 | 1 hour | Regional fan-out |
| `pixel_events.europe` | 4 | 1 hour | Regional fan-out |

### Consumer Groups

| Group | Consumers | Purpose |
|-------|-----------|---------|
| `ws-broadcast-us-west` | 20 WebSocket servers | Real-time fan-out |
| `ws-broadcast-us-east` | 20 WebSocket servers | Real-time fan-out |
| `cassandra-persist` | 5 workers | History persistence |
| `timelapse-gen` | 1 worker | Snapshot generation |

---

## 🔧 6. Deep Dive: WebSocket at Scale (6 minutes)

### Go Goroutine Model

"Go handles millions of connections efficiently. Each connection is a goroutine (~2KB stack)."

| Metric | Value | Calculation |
|--------|-------|-------------|
| Connections per server | 500,000 | Go handles this well |
| Memory per connection | ~10 KB | Goroutine + buffers |
| Memory per server | ~5 GB | 500K × 10KB |
| Servers needed | 21 | 10.4M / 500K |

### Server Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    WebSocket Server (Go)                         │
│                                                                  │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │ Accept Loop   │  │ Kafka         │  │ Broadcast     │       │
│  │ (goroutine)   │  │ Consumer      │  │ Loop          │       │
│  │               │  │ (goroutine)   │  │ (goroutine)   │       │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘       │
│          │                  │                  │                │
│          │                  │                  │                │
│          ▼                  ▼                  ▼                │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Connection Map (500K entries)                   ││
│  │              map[userId]*websocket.Conn                     ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  Each connection: 1 read goroutine + 1 write goroutine          │
└─────────────────────────────────────────────────────────────────┘
```

### Batched Broadcasting

"Batch updates every 1 second to reduce message overhead."

| Approach | Messages/sec to 10M clients | Feasibility |
|----------|----------------------------|-------------|
| Individual | 35K × 10M = 350 billion | ❌ Impossible |
| 1s batches | 10M × ~5KB | ✅ 50GB/s distributed |

---

## 🔧 7. Deep Dive: Rate Limiting (5 minutes)

### Redis-Based Distributed Rate Limiting

| Operation | Command | Result |
|-----------|---------|--------|
| Place attempt | `SET ratelimit:{uid} 1 NX EX 300` | OK if allowed, null if blocked |
| Get remaining | `TTL ratelimit:{uid}` | Seconds until can place |

### Throughput Calculation

```
35K placements/sec × 2 Redis ops = 70K ops/sec
Redis single node: 100K+ ops/sec ✅
```

### Multi-Layer Rate Limiting

| Layer | Key | Limit | Purpose |
|-------|-----|-------|---------|
| Per-user | `ratelimit:user:{id}` | 1 per 5 min | Primary control |
| Per-IP | `ratelimit:ip:{ip}` | 100 per min | Multi-account abuse |
| Global | `ratelimit:global` | 50K per sec | System protection |

---

## 💾 8. Deep Dive: Event Persistence (4 minutes)

### Cassandra Schema

"Cassandra is ideal for time-series append-only data like pixel events."

| Column | Type | Purpose |
|--------|------|---------|
| date | date | Partition key (by day) |
| timestamp | timeuuid | Clustering key |
| x, y | smallint | Coordinates |
| color | tinyint | Color index (0-15) |
| user_id | bigint | Who placed it |

### Why Cassandra over PostgreSQL?

| Feature | Cassandra | PostgreSQL |
|---------|-----------|------------|
| Write throughput | ✅ 100K+ writes/sec | ⚠️ ~10K with tuning |
| Time-series queries | ✅ Optimized | ⚠️ Needs indexes |
| Horizontal scale | ✅ Linear | ⚠️ Complex sharding |
| ACID transactions | ❌ Eventual | ✅ Full support |

> "We don't need transactions for pixel events—each event is independent. Cassandra's write throughput and time-series optimization make it ideal for 35K events/second sustained."

---

## 📡 9. API Design

### WebSocket Protocol

**Client → Server:**

| Type | Fields | Description |
|------|--------|-------------|
| `place` | x, y, color | Place a pixel |
| `ping` | — | Keepalive (every 30s) |

**Server → Client:**

| Type | Fields | Description |
|------|--------|-------------|
| `init` | canvasUrl, cooldown, info | CDN URL for bitmap |
| `batch` | pixels[], timestamp | Batched updates (1s) |
| `placed` | x, y, color, nextPlacement | Confirmation |
| `error` | code, message, retryAfter | Failure |

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/canvas` | 302 redirect to CDN |
| GET | `/api/v1/canvas/info` | `{ width, height, colors, cooldown }` |
| GET | `/api/v1/pixel?x=&y=` | Pixel history from Cassandra |
| GET | `/api/v1/health` | `{ status, kafka, redis, connections }` |

---

## ⚖️ 10. Trade-offs Analysis

### Trade-off 1: Kafka vs. Redis Pub/Sub

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Kafka | Durable, replayable, consumer groups | 10-50ms latency |
| ❌ Redis Pub/Sub | Sub-millisecond latency | Fire-and-forget |

> "Reddit used Kafka because durability matters for a 4-day event. If a WebSocket server restarts, it resumes from its Kafka offset—no missed events. If they find a bug post-event, they can reprocess the entire log for the timelapse. The 10-50ms latency is invisible with 1-second batching anyway."

### Trade-off 2: Bit-Packing vs. Byte-per-Pixel

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bit-packed (4 bits) | 2MB storage, half bandwidth | Complex bit manipulation |
| ❌ Byte-per-pixel | Simple addressing | 4MB storage, 2x bandwidth |

> "Bit-packing halves CDN bandwidth. With 10 million users fetching the canvas, that's 20TB vs 40TB saved. The bit manipulation complexity is a one-time implementation cost in the placement service."

### Trade-off 3: Cassandra vs. PostgreSQL

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Cassandra | 100K+ writes/sec, linear scale | No joins, eventual consistency |
| ❌ PostgreSQL | ACID, complex queries | Harder to scale writes |

> "Pixel events are append-only and independent—we don't need transactions. Cassandra handles 35K writes/second trivially across 5 nodes. PostgreSQL would require careful tuning and sharding to achieve the same throughput."

---

## 🚨 11. Failure Handling

| Component | Failure | Mitigation |
|-----------|---------|------------|
| Redis | Primary down | Redis Cluster automatic failover |
| Kafka | Broker down | Replication factor 3, automatic leader election |
| WebSocket Server | Crash | Client reconnect, resume from Kafka offset |
| Cassandra | Node down | Replication factor 3, reads from replica |

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Kafka down | Placements succeed (Redis updated), broadcast delayed |
| Redis rate limit fails | Fail OPEN (allow placement) |
| Cassandra down | History unavailable, real-time unaffected |

---

## 📝 Summary

"To summarize, I've designed r/place's backend following Reddit's actual architecture:

1. **Kafka event streaming** - Durable log for 160M events, enables replay and consumer groups
2. **Bit-packed Redis bitmap** - 2MB canvas with atomic BITFIELD updates
3. **Go WebSocket servers** - 500K connections per server via goroutines
4. **Cassandra persistence** - Time-series optimized for 35K writes/second
5. **CDN-first serving** - Fastly handles 10M bitmap requests
6. **Batched broadcasting** - 1-second batches reduce 350B messages to 10M

The key backend insight is that Kafka is the backbone: it provides durability for the timelapse, enables horizontal scaling via consumer groups, and allows WebSocket servers to recover without missing events. The canvas being only 2MB (bit-packed) means Redis handles the hot path trivially."
