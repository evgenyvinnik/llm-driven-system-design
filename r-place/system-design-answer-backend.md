# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. As a backend engineer, I'll focus on the real-time infrastructure, distributed state management, efficient broadcasting, and ensuring the system handles massive concurrent connections. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

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

## 2. Scale Estimation (3 minutes)

### Traffic Estimates

| Metric | Value | Calculation |
|--------|-------|-------------|
| Canvas size | 500 x 500 = 250K pixels | Local dev target |
| Canvas memory | 250 KB | 1 byte per pixel (color index) |
| Concurrent users | 100K | Production target |
| Peak pixel placements | 20,000 RPS | 100K users / 5s cooldown |
| WebSocket messages/sec | 2 billion | 20K updates x 100K recipients |

### Storage Estimates

| Data Type | Size | Growth Rate |
|-----------|------|-------------|
| Canvas state (Redis) | 250 KB | Static |
| Rate limit keys | ~50 bytes/user | With active users |
| Pixel events (PostgreSQL) | 48 bytes/event | ~1.7M rows/day |
| Canvas snapshots | 250 KB/snapshot | 24/day |

---

## 3. High-Level Architecture (5 minutes)

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx/HAProxy)|
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v---------+        +-----------v---------+
    |   API Server 1    |        |   API Server 2      |        |   API Server N      |
    |   (Express + WS)  |        |   (Express + WS)    |        |   (Express + WS)    |
    +---------+---------+        +-----------+---------+        +-----------+---------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+        +-----------v---------+        +-----------v---------+
    |   Redis Cluster   |        |   PostgreSQL        |        |   RabbitMQ          |
    |   - Canvas state  |        |   - Pixel events    |        |   - Snapshot jobs   |
    |   - Sessions      |        |   - Snapshots       |        |   - Timelapse gen   |
    |   - Rate limits   |        |   - User accounts   |        |                     |
    |   - Pub/Sub       |        |                     |        |                     |
    +-------------------+        +---------------------+        +---------------------+
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| API Server | HTTP REST + WebSocket server | Express.js + ws |
| Canvas Store | Real-time canvas state, rate limits | Redis/Valkey |
| Event Store | Pixel history, snapshots, users | PostgreSQL |
| Message Queue | Background jobs (snapshots, timelapse) | RabbitMQ |

---

## 4. Deep Dive: Redis Canvas State Management (8 minutes)

### Canvas Storage Strategy

```
# Canvas stored as single binary string (1 byte per pixel)
# 500x500 = 250,000 bytes
# Pixel at (x, y) is at offset: x + y * CANVAS_WIDTH

canvas:main = <250KB binary string>

# Atomic pixel update with SETRANGE
SETRANGE canvas:main <offset> <color_byte>

# Full canvas read for new connections
GET canvas:main
```

### Why Redis Byte Array?

1. **Memory Efficiency** - 250KB for entire canvas (1 byte per pixel for 16 colors)
2. **Atomic Updates** - SETRANGE provides atomic byte-level updates
3. **Fast Reads** - GET returns entire canvas in single operation
4. **Simple Addressing** - offset = x + y * width

### Pixel Placement Implementation

```typescript
async function placePixel(
  userId: string,
  x: number,
  y: number,
  color: number
): Promise<PlacementResult> {
  // 1. Validate coordinates
  if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
    throw new InvalidCoordinatesError();
  }

  if (color < 0 || color >= 16) {
    throw new InvalidColorError();
  }

  // 2. Check rate limit atomically
  const cooldownKey = `ratelimit:user:${userId}`;
  const canPlace = await redis.set(cooldownKey, '1', {
    NX: true,  // Only if not exists
    EX: COOLDOWN_SECONDS
  });

  if (!canPlace) {
    const ttl = await redis.ttl(cooldownKey);
    return { success: false, cooldownRemaining: ttl };
  }

  // 3. Update canvas atomically
  const offset = x + y * CANVAS_WIDTH;
  await redis.setRange('canvas:main', offset, Buffer.from([color]));

  // 4. Create event for history
  const event = {
    x,
    y,
    color,
    userId,
    timestamp: Date.now()
  };

  // 5. Publish to all WebSocket servers
  await redis.publish('canvas:updates', JSON.stringify(event));

  // 6. Queue event for PostgreSQL (async, non-blocking)
  await rabbitMQ.publish('pixel_events', event);

  return {
    success: true,
    nextPlacement: Date.now() + COOLDOWN_SECONDS * 1000
  };
}
```

### Circuit Breaker for Redis Operations

```typescript
class RedisCircuitBreaker {
  private failures = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private openedAt = 0;

  async execute<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt > 30000) {
        this.state = 'HALF_OPEN';
      } else {
        return fallback; // Return fallback during outage
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failures++;
    if (this.failures >= 5) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
    }
  }
}
```

---

## 5. Deep Dive: Distributed Rate Limiting (6 minutes)

### Why Redis-Based Rate Limiting?

1. **Atomic Operation** - SET NX EX prevents race conditions
2. **Distributed** - Works across all server instances
3. **Automatic Cleanup** - TTL expires keys automatically
4. **Simple** - Single Redis command

### Rate Limiting Implementation

```typescript
interface RateLimitResult {
  allowed: boolean;
  remainingSeconds: number;
}

async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const key = `ratelimit:user:${userId}`;

  // Atomic check-and-set
  const result = await redis.set(key, '1', {
    NX: true,   // Only set if not exists
    EX: COOLDOWN_SECONDS  // Auto-expire
  });

  if (result === 'OK') {
    return { allowed: true, remainingSeconds: 0 };
  }

  // Key exists, get remaining TTL
  const ttl = await redis.ttl(key);
  return { allowed: false, remainingSeconds: ttl };
}
```

### Dynamic Rate Limiting Under Load

```typescript
async function getDynamicCooldown(): Promise<number> {
  // Check current system load
  const activeConnections = await getActiveConnectionCount();
  const currentRPS = await getCurrentPixelRPS();

  if (currentRPS > 50000) {
    return 60;  // 1 minute during extreme load
  } else if (currentRPS > 20000) {
    return 30;  // 30 seconds during high load
  } else if (activeConnections > 100000) {
    return 10;  // 10 seconds for many users
  }

  return 5;  // Default 5 seconds
}
```

### Anti-Abuse Measures

```typescript
async function validatePlacement(
  userId: string,
  sessionId: string,
  ip: string
): Promise<void> {
  // IP-based rate limiting (additional layer)
  const ipKey = `ratelimit:ip:${ip}`;
  const ipCount = await redis.incr(ipKey);
  await redis.expire(ipKey, 60);

  if (ipCount > 100) {  // Max 100 placements per IP per minute
    throw new SuspiciousActivityError('IP rate limit exceeded');
  }

  // Session velocity check
  const sessionKey = `session:placements:${sessionId}`;
  const sessionCount = await redis.incr(sessionKey);
  await redis.expire(sessionKey, 300);  // 5 minute window

  if (sessionCount > 60) {  // Max 60 placements per session per 5 min
    await flagForReview(userId);
    throw new SuspiciousActivityError('Unusual activity detected');
  }
}
```

---

## 6. Deep Dive: WebSocket Broadcasting (8 minutes)

### Redis Pub/Sub Architecture

```
+-------------+     PUBLISH      +------------------+
| API Server  | ---------------▶ | Redis Pub/Sub    |
| (placement) |                  | canvas:updates   |
+-------------+                  +--------+---------+
                                          |
                      +-------------------+-------------------+
                      | SUBSCRIBE         | SUBSCRIBE         | SUBSCRIBE
               +------v------+     +------v------+     +------v------+
               | API Server 1|     | API Server 2|     | API Server N|
               | 10K clients |     | 10K clients |     | 10K clients |
               +-------------+     +-------------+     +-------------+
```

### WebSocket Server Implementation

```typescript
class PixelBroadcaster {
  private connections = new Set<WebSocket>();
  private redisSubscriber: Redis;
  private pendingUpdates: PixelEvent[] = [];
  private lastBroadcast = 0;

  async initialize(): Promise<void> {
    // Subscribe to Redis channel
    this.redisSubscriber = new Redis();
    await this.redisSubscriber.subscribe('canvas:updates');

    this.redisSubscriber.on('message', (channel, message) => {
      if (channel === 'canvas:updates') {
        const event = JSON.parse(message);
        this.queueUpdate(event);
      }
    });

    // Start batch broadcast loop
    setInterval(() => this.flushUpdates(), 50);  // 50ms batches
  }

  private queueUpdate(event: PixelEvent): void {
    this.pendingUpdates.push(event);
  }

  private async flushUpdates(): Promise<void> {
    if (this.pendingUpdates.length === 0) return;

    const batch = this.pendingUpdates;
    this.pendingUpdates = [];

    // Create single message for all updates
    const message = JSON.stringify({
      type: 'pixels',
      events: batch
    });

    // Broadcast to all connections
    const promises = Array.from(this.connections).map(ws => {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message, () => resolve());
        } else {
          resolve();
        }
      });
    });

    await Promise.all(promises);
  }

  onConnect(ws: WebSocket): void {
    this.connections.add(ws);

    // Send current canvas state
    this.sendCanvasState(ws);
  }

  onDisconnect(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  private async sendCanvasState(ws: WebSocket): Promise<void> {
    const canvas = await redis.getBuffer('canvas:main');

    ws.send(JSON.stringify({
      type: 'canvas',
      data: canvas.toString('base64'),
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    }));
  }
}
```

### Scaling WebSocket Connections

```
100K connections / 10K per server = 10 WebSocket servers minimum
(Provision 15-20 for headroom)

Per server resource allocation:
- Memory: 1-2 GB (100 bytes per connection)
- CPU: 2-4 cores for JSON encoding/broadcasting
- Network: 100 Mbps for fan-out
```

### Regional Distribution for Global Scale

```
                    +------------------+
                    |   Global LB      |
                    |   (GeoDNS)       |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
    +----v----+         +----v----+         +----v----+
    | US-West |         | US-East |         | Europe  |
    | Cluster |         | Cluster |         | Cluster |
    +----+----+         +----+----+         +----+----+
         |                   |                   |
         +-------------------+-------------------+
                             |
                    +--------v--------+
                    | Kafka (Global)  |
                    | Pixel Events    |
                    +-----------------+
```

---

## 7. Deep Dive: Event Persistence and History (5 minutes)

### PostgreSQL Schema

```sql
-- Pixel placement events (append-only log)
CREATE TABLE pixel_events (
  id BIGSERIAL PRIMARY KEY,
  x SMALLINT NOT NULL CHECK (x >= 0 AND x < 2000),
  y SMALLINT NOT NULL CHECK (y >= 0 AND y < 2000),
  color SMALLINT NOT NULL CHECK (color >= 0 AND color < 16),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX idx_pixel_events_created_at ON pixel_events(created_at);
CREATE INDEX idx_pixel_events_coords ON pixel_events(x, y, created_at DESC);
CREATE INDEX idx_pixel_events_user ON pixel_events(user_id, created_at DESC);

-- Canvas snapshots for timelapse
CREATE TABLE canvas_snapshots (
  id SERIAL PRIMARY KEY,
  canvas_data BYTEA NOT NULL,  -- Compressed
  width SMALLINT NOT NULL,
  height SMALLINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Async Event Processing

```typescript
// Worker consuming from RabbitMQ
async function processPixelEvents(): Promise<void> {
  const channel = await rabbitMQ.createChannel();
  await channel.assertQueue('pixel_events', { durable: true });

  // Batch insert for efficiency
  const batch: PixelEvent[] = [];
  const BATCH_SIZE = 1000;
  const FLUSH_INTERVAL = 1000;  // 1 second

  let lastFlush = Date.now();

  channel.consume('pixel_events', async (msg) => {
    if (!msg) return;

    const event = JSON.parse(msg.content.toString());
    batch.push(event);
    channel.ack(msg);

    // Flush on batch size or interval
    if (batch.length >= BATCH_SIZE || Date.now() - lastFlush > FLUSH_INTERVAL) {
      await flushBatch([...batch]);
      batch.length = 0;
      lastFlush = Date.now();
    }
  });
}

async function flushBatch(events: PixelEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Batch insert
  const values = events.map(e =>
    `(${e.x}, ${e.y}, ${e.color}, '${e.userId}', '${e.sessionId}', to_timestamp(${e.timestamp / 1000}))`
  ).join(',');

  await pool.query(`
    INSERT INTO pixel_events (x, y, color, user_id, session_id, created_at)
    VALUES ${values}
  `);
}
```

### Snapshot Worker

```typescript
async function snapshotScheduler(): Promise<void> {
  while (true) {
    await sleep(3600000);  // Every hour

    // Get current canvas from Redis
    const canvasData = await redis.getBuffer('canvas:main');

    // Compress for storage
    const compressed = await gzip(canvasData);

    // Store snapshot
    await pool.query(`
      INSERT INTO canvas_snapshots (canvas_data, width, height)
      VALUES ($1, $2, $3)
    `, [compressed, CANVAS_WIDTH, CANVAS_HEIGHT]);

    logger.info('Canvas snapshot saved', {
      size: compressed.length,
      originalSize: canvasData.length
    });
  }
}
```

---

## 8. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Canvas storage | Redis byte array | Can't shard, limited to ~16K x 16K | Tile-based sharding |
| Real-time broadcast | Redis Pub/Sub | No message persistence | Kafka for durability |
| Rate limiting | Fixed window | Boundary burst possible | Sliding window |
| Consistency | Eventual (last-write-wins) | Brief inconsistency across regions | Strong consistency (slower) |
| Event persistence | Async via RabbitMQ | Small delay in history | Sync writes (slower) |

---

## 9. Failure Handling

| Component | Failure Mode | Mitigation |
|-----------|--------------|------------|
| Redis | Down | Circuit breaker, serve cached canvas from CDN |
| PostgreSQL | Down | Buffer events in RabbitMQ, retry on recovery |
| API Server | Crash | Load balancer health checks, client reconnect |
| RabbitMQ | Down | Events lost, catch up from Redis on recovery |

### Graceful Degradation

```typescript
// Rate limit fails open for availability
async function checkRateLimitWithFallback(userId: string): Promise<boolean> {
  try {
    return await redisCircuitBreaker.execute(
      () => checkRateLimit(userId),
      { allowed: true, remainingSeconds: 0 }  // Fail open
    );
  } catch (error) {
    logger.warn('Rate limit check failed, allowing placement', { userId });
    return { allowed: true, remainingSeconds: 0 };
  }
}
```

---

## 10. Future Enhancements

1. **Viewport-Based Updates** - Only send updates for visible canvas region
2. **Tile-Based Storage** - Shard canvas across multiple Redis keys for larger sizes
3. **Kafka Integration** - Replace Redis Pub/Sub for durability and replay
4. **Geographic Sharding** - Regional canvases with cross-region sync
5. **Binary WebSocket Protocol** - Reduce message size from JSON

---

## Summary

"To summarize, I've designed r/place's backend with:

1. **Redis-backed canvas** storing the entire state as a compact byte array with atomic SETRANGE updates
2. **Distributed rate limiting** using Redis SET NX EX for atomic, auto-expiring cooldowns
3. **Redis Pub/Sub** for broadcasting pixel updates across all WebSocket servers in real-time
4. **Async event persistence** via RabbitMQ workers for non-blocking history logging
5. **Circuit breakers** protecting against cascading failures with graceful degradation
6. **Horizontal scaling** through stateless API servers and Redis-based state sharing

The key insight is that the canvas is small enough (250KB) to fit in Redis memory, making reads and writes trivially fast. The challenge is efficiently broadcasting 20,000+ updates per second to 100,000+ connected clients, which we solve through batching, regional distribution, and viewport-based filtering."
