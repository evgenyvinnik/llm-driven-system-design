# r/place - Collaborative Real-time Pixel Canvas - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. This is a fascinating real-time systems problem. Let me clarify the requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A large grid where any authenticated user can place a colored pixel
2. **Rate Limiting** - Users can only place one pixel every N minutes (e.g., 5 minutes)
3. **Real-time Updates** - All users see pixel placements from others instantly
4. **Color Palette** - Limited color selection (e.g., 16-32 colors)
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

## 2. Scale Estimation (3 minutes)

### Assumptions
- Canvas size: 2000 x 2000 pixels = 4 million pixels
- Rate limit: 1 pixel per 5 minutes per user
- Peak concurrent users: 1 million
- Event duration: 4 days

### Traffic Estimates
- **Max pixel placements**: 1M users / 5 minutes = 3,333 pixels/second
- **Canvas reads**: 1M users refreshing = ~100,000 reads/second (with caching)
- **WebSocket connections**: 1 million concurrent

### Storage Estimates
- Canvas state: 4M pixels x 1 byte (color) = 4 MB
- Pixel event: ~50 bytes (x, y, color, user_id, timestamp)
- 3,333 pixels/second x 86,400 seconds x 4 days = 1.15 billion events
- **Event storage**: 1.15B x 50 bytes = ~58 GB

### Bandwidth
- Full canvas download: 4 MB
- Incremental updates: 50 bytes x 3,333/second = 167 KB/second outbound per connection cluster

---

## 3. High-Level Architecture (8 minutes)

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

1. **WebSocket Servers** - Maintain connections with clients, push pixel updates
2. **Pixel Service** - Validates and processes pixel placement requests
3. **Redis Cluster** - Stores live canvas state and rate limiting data
4. **Redis Pub/Sub** - Broadcasts pixel events to all WebSocket servers
5. **Kafka** - Durable event log for all pixel placements
6. **History Service** - Generates snapshots and timelapses

---

## 4. Data Model (5 minutes)

### Canvas State in Redis

```
# Canvas stored as a bitmap or string
# Key: canvas:current
# Value: 4MB byte array where each byte represents one pixel's color

# For 2000x2000 canvas, pixel at (x, y) is at index: y * 2000 + x
SETRANGE canvas:current <offset> <color_byte>
GETRANGE canvas:current 0 -1  # Get entire canvas
```

### Rate Limiting in Redis

```
# Per-user cooldown
# Key: cooldown:{user_id}
# Value: timestamp of last placement + TTL auto-expiry

SET cooldown:user123 1699900000 EX 300  # 5 minute TTL
```

### Event Schema (Kafka/PostgreSQL)

```sql
CREATE TABLE pixel_events (
    id              BIGSERIAL PRIMARY KEY,
    x               SMALLINT NOT NULL,
    y               SMALLINT NOT NULL,
    color           SMALLINT NOT NULL,
    user_id         UUID NOT NULL,
    placed_at       TIMESTAMP NOT NULL,
    session_id      UUID  -- For anti-abuse tracking
);

-- Partitioned by time for efficient timelapse queries
CREATE INDEX idx_pixel_events_time ON pixel_events(placed_at);
```

### Canvas Snapshots

```sql
CREATE TABLE canvas_snapshots (
    id              SERIAL PRIMARY KEY,
    captured_at     TIMESTAMP NOT NULL,
    canvas_data     BYTEA NOT NULL,  -- Compressed canvas state
    pixel_count     INTEGER          -- Total pixels placed so far
);
```

---

## 5. Deep Dive: Pixel Placement Flow (10 minutes)

"Let me walk through what happens when a user places a pixel."

### The Flow

```
User clicks      WebSocket        Pixel           Redis           Redis
canvas    ─────▶ Server    ─────▶ Service  ─────▶ (Rate Limit) ─▶ (Canvas)
                    │                                   │             │
                    │                                   │             │
                    │◀──────────────────────────────────┴─────────────┘
                    │                    │
                    │                    ▼
                    │              Redis Pub/Sub
                    │                    │
                    ▼                    ▼
               Broadcast to      All WebSocket Servers
               this client       broadcast to their clients
```

### Pixel Placement Logic

```python
async def place_pixel(user_id, x, y, color):
    # 1. Validate coordinates
    if not (0 <= x < CANVAS_WIDTH and 0 <= y < CANVAS_HEIGHT):
        raise InvalidCoordinatesError()

    if color not in VALID_COLORS:
        raise InvalidColorError()

    # 2. Check rate limit (Redis atomic operation)
    cooldown_key = f"cooldown:{user_id}"

    # SET NX = only set if not exists, returns True if set
    can_place = await redis.set(
        cooldown_key,
        int(time.time()),
        nx=True,      # Only if not exists
        ex=COOLDOWN_SECONDS  # 5 minute expiry
    )

    if not can_place:
        # Get remaining cooldown time
        ttl = await redis.ttl(cooldown_key)
        raise RateLimitError(f"Wait {ttl} seconds")

    # 3. Update canvas state atomically
    offset = y * CANVAS_WIDTH + x
    await redis.setrange('canvas:current', offset, bytes([color]))

    # 4. Create event record
    event = {
        'x': x,
        'y': y,
        'color': color,
        'user_id': user_id,
        'timestamp': time.time()
    }

    # 5. Publish to all WebSocket servers
    await redis.publish('pixel_updates', json.dumps(event))

    # 6. Log to Kafka for durability and history
    await kafka.produce('pixel_events', event)

    return {'success': True, 'next_placement': time.time() + COOLDOWN_SECONDS}
```

### WebSocket Server Handling

```python
class PixelWebSocketServer:
    def __init__(self):
        self.connections = set()
        self.redis_sub = None

    async def start(self):
        # Subscribe to pixel updates
        self.redis_sub = redis.pubsub()
        await self.redis_sub.subscribe('pixel_updates')

        # Start broadcast loop
        asyncio.create_task(self.broadcast_loop())

    async def broadcast_loop(self):
        async for message in self.redis_sub.listen():
            if message['type'] == 'message':
                event = message['data']
                await self.broadcast_to_all(event)

    async def broadcast_to_all(self, event):
        # Batch events for efficiency (every 50ms)
        self.pending_events.append(event)

        if time.time() - self.last_broadcast > 0.05:
            batch = self.pending_events
            self.pending_events = []

            message = json.dumps({'type': 'pixels', 'events': batch})

            await asyncio.gather(*[
                conn.send(message)
                for conn in self.connections
            ])

    async def on_connect(self, websocket):
        self.connections.add(websocket)

        # Send current canvas state
        canvas = await redis.get('canvas:current')
        await websocket.send(json.dumps({
            'type': 'canvas',
            'data': base64.b64encode(canvas).decode()
        }))

    async def on_disconnect(self, websocket):
        self.connections.discard(websocket)
```

### Client-Side Implementation

```javascript
class PixelCanvas {
    constructor() {
        this.canvas = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
        this.ws = new WebSocket('wss://place.example.com/ws');

        this.ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'canvas') {
                // Initial canvas load
                this.canvas = new Uint8Array(atob(msg.data).split('').map(c => c.charCodeAt(0)));
                this.render();
            } else if (msg.type === 'pixels') {
                // Incremental updates
                for (const pixel of msg.events) {
                    const offset = pixel.y * CANVAS_WIDTH + pixel.x;
                    this.canvas[offset] = pixel.color;
                }
                this.renderDirty(msg.events);
            }
        };
    }

    async placePixel(x, y, color) {
        const response = await fetch('/api/pixel', {
            method: 'POST',
            body: JSON.stringify({ x, y, color })
        });

        if (!response.ok) {
            const error = await response.json();
            showCooldownTimer(error.seconds_remaining);
        }
    }
}
```

---

## 6. Deep Dive: Scaling WebSocket Connections (5 minutes)

"With 1 million concurrent users, we need careful WebSocket scaling."

### Connection Distribution

```
1 million connections / 100,000 per server = 10 WebSocket servers minimum
(We'd provision 15-20 for headroom)
```

### Server Sizing
- Each WebSocket connection: ~10 KB memory
- 100,000 connections: 1 GB base memory
- Plus CPU for JSON encoding and broadcast

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
                    │ Global Redis  │
                    │   Pub/Sub     │
                    └───────────────┘
```

### Cross-Region Pub/Sub

```python
# Each region has local Redis for pub/sub
# Global coordination via Kafka

class RegionalPixelBroadcaster:
    def __init__(self, region):
        self.region = region
        self.local_redis = get_regional_redis(region)
        self.kafka_consumer = KafkaConsumer('pixel_events')

    async def run(self):
        # Consume global events, publish to local Redis
        async for event in self.kafka_consumer:
            await self.local_redis.publish('pixel_updates', event)
```

---

## 7. Canvas History and Timelapse (3 minutes)

### Snapshot Strategy

```python
async def snapshot_scheduler():
    while True:
        # Snapshot every 30 seconds
        await asyncio.sleep(30)

        canvas_data = await redis.get('canvas:current')
        compressed = zlib.compress(canvas_data)

        await db.insert_snapshot(
            captured_at=datetime.now(),
            canvas_data=compressed,
            pixel_count=await get_total_pixel_count()
        )
```

### Timelapse Generation

```python
def generate_timelapse(start_time, end_time, fps=30):
    snapshots = db.get_snapshots(start_time, end_time)

    video = VideoWriter('timelapse.mp4', fps=fps)

    for snapshot in snapshots:
        canvas = zlib.decompress(snapshot.canvas_data)
        frame = canvas_to_image(canvas)
        video.write(frame)

    video.close()
```

### Point-in-Time Reconstruction

```python
def get_canvas_at_time(target_time):
    # Find nearest snapshot before target time
    snapshot = db.get_snapshot_before(target_time)
    canvas = zlib.decompress(snapshot.canvas_data)

    # Replay events from snapshot to target time
    events = db.get_events(
        start_time=snapshot.captured_at,
        end_time=target_time
    )

    for event in events:
        offset = event.y * CANVAS_WIDTH + event.x
        canvas[offset] = event.color

    return canvas
```

---

## 8. Rate Limiting Deep Dive (3 minutes)

### Basic Rate Limiting

```python
# Redis-based cooldown
async def check_and_set_cooldown(user_id):
    key = f"cooldown:{user_id}"

    # Atomic check-and-set
    result = await redis.set(key, 1, nx=True, ex=COOLDOWN_SECONDS)

    if not result:
        ttl = await redis.ttl(key)
        return (False, ttl)

    return (True, 0)
```

### Dynamic Rate Limiting

"During the event, we might want to adjust rate limits based on load."

```python
async def get_dynamic_cooldown():
    # Check current load
    current_rps = await get_current_rps()

    if current_rps > 5000:
        return 600  # 10 minutes during extreme load
    elif current_rps > 3000:
        return 450  # 7.5 minutes
    else:
        return 300  # 5 minutes default
```

### Anti-Abuse Measures

```python
async def validate_placement(user_id, x, y, session_id):
    # Check for bot patterns
    recent_placements = await get_recent_placements(user_id, limit=100)

    # Pattern detection
    if detect_grid_pattern(recent_placements):
        await flag_for_review(user_id)
        raise SuspiciousActivityError()

    # Velocity check across sessions
    if count_sessions_today(user_id) > 10:
        await require_captcha(user_id)
```

---

## 9. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Single Canvas vs. Sharded Canvas

**Chose**: Single canvas in Redis (fits in memory)
**Trade-off**: Limited to ~16K x 16K pixels (256 MB)
**Alternative**: Sharded canvas across Redis nodes (more complex, but unlimited size)

### Trade-off 2: Eventual Consistency vs. Strong Consistency

**Chose**: Eventual consistency with ~500ms lag acceptable
**Trade-off**: Users in different regions might see slightly different states briefly
**Alternative**: Single-region deployment (lower latency but less resilient)

### Trade-off 3: WebSocket vs. Server-Sent Events

**Chose**: WebSocket for bidirectional communication
**Trade-off**: More complex but allows pixel placement through same connection
**Alternative**: SSE for updates + HTTP POST for placements (simpler but two connections)

---

## 10. Failure Scenarios (2 minutes)

### Redis Failure

```python
# Fallback to read-only mode
async def handle_redis_failure():
    # Serve cached canvas from CDN
    # Reject new placements with friendly message
    # Auto-recover when Redis returns
```

### WebSocket Server Crash

```python
# Client auto-reconnect with exponential backoff
class ResilientWebSocket {
    connect() {
        this.ws = new WebSocket(this.url);
        this.ws.onclose = () => this.reconnect();
    }

    reconnect() {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
    }
}
```

---

## Summary

"To summarize, I've designed r/place with:

1. **Redis-backed canvas** storing the entire 4 MB state in memory for instant reads
2. **Redis Pub/Sub** for broadcasting pixel updates across all WebSocket servers
3. **Atomic rate limiting** ensuring fair cooldowns per user
4. **Kafka event log** for durability and history reconstruction
5. **Regional clusters** with global coordination for worldwide scale
6. **Snapshot system** enabling timelapse generation

The key insight is that the canvas is small enough to fit in memory, making reads trivial, while the challenge is efficiently broadcasting 3,000+ updates per second to 1 million connected clients."

---

## Questions I'd Expect

**Q: What if someone tries to overwrite pixels programmatically?**
A: Rate limiting applies equally to all users. We can add CAPTCHA for suspicious accounts and IP-based rate limits. The 5-minute cooldown makes botting ineffective.

**Q: How do you handle the initial canvas load for a million users?**
A: The canvas is served from CDN as a compressed file. Only ~4 MB compressed. CDN can handle millions of concurrent downloads.

**Q: What about moderating inappropriate content?**
A: We log all placements with user IDs. Moderators can view the history of any region, ban users, and use ML-based image recognition to flag problematic content in near-real-time.
