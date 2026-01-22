# Twitch - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Stream**: Broadcasters publish live video via RTMP to viewers
- **Watch**: Viewers watch streams with low latency via HLS/DASH
- **Chat**: Real-time messaging during streams (100K+ concurrent users per channel)
- **Subscribe**: Paid channel subscriptions and donations
- **VOD**: Record and store live broadcasts for later viewing

### Non-Functional Requirements
- **Latency**: < 5 seconds glass-to-glass (camera to viewer screen)
- **Scale**: 10M concurrent viewers, 100K concurrent streams
- **Chat**: 1M messages per minute during peak events
- **Availability**: 99.99% for video delivery

### Scale Estimates
| Metric | Estimate |
|--------|----------|
| Concurrent Viewers | 10M |
| Concurrent Streams | 100K |
| Average Bitrate | 4 Mbps |
| Peak Chat Messages | 1M/min |
| VOD Storage/Day | 500TB |

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Broadcaster Layer                            │
│              OBS / Streamlabs (RTMP output)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ RTMP
┌─────────────────────────────────────────────────────────────────┐
│                    Ingest Layer                                 │
│    Multiple ingest servers globally (rtmp://ingest.twitch.tv)   │
│    - Authenticate stream key                                    │
│    - Forward to transcoder                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Transcoding Layer                              │
│    FFmpeg/MediaLive clusters                                    │
│    - Source → 1080p60, 720p60, 720p30, 480p, 360p               │
│    - Generate HLS segments (2-4 second chunks)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Origin Layer                                  │
│    - Store HLS manifests (.m3u8) and segments (.ts)             │
│    - Serve to CDN edge nodes                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CDN Edge Layer                              │
│    CloudFront / Fastly / Custom CDN                             │
│    - Cache segments at edge                                     │
│    - Serve to viewers globally                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Layered Approach?

- **Ingest Separation**: Globally distributed so broadcasters connect to nearby servers
- **Transcoding Layer**: Each stream needs dedicated transcoder for isolation
- **CDN**: Essential for 10M viewers - segments cached at edge (>99% cache hit)

---

## 3. Data Model Design (5 minutes)

### PostgreSQL Schema

```sql
-- Channels (streamers)
CREATE TABLE channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  stream_key VARCHAR(100) UNIQUE NOT NULL,
  title VARCHAR(200),
  category_id INTEGER REFERENCES categories(id),
  follower_count INTEGER DEFAULT 0,
  subscriber_count INTEGER DEFAULT 0,
  is_live BOOLEAN DEFAULT FALSE,
  current_viewers INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,  -- Optimistic locking
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_channels_live ON channels (is_live) WHERE is_live = TRUE;
CREATE INDEX idx_channels_category ON channels (category_id, current_viewers DESC);

-- Each broadcast session
CREATE TABLE streams (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id),
  title VARCHAR(200),
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  peak_viewers INTEGER DEFAULT 0,
  total_views INTEGER DEFAULT 0,
  vod_url VARCHAR(500)
);

CREATE INDEX idx_streams_channel ON streams (channel_id, started_at DESC);

-- Paid subscriptions
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  channel_id INTEGER REFERENCES channels(id),
  tier INTEGER DEFAULT 1, -- Tier 1, 2, or 3
  started_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  is_gift BOOLEAN DEFAULT FALSE,
  gifted_by INTEGER REFERENCES users(id),
  idempotency_key VARCHAR(100) UNIQUE
);

CREATE UNIQUE INDEX idx_subscriptions_active
  ON subscriptions (user_id, channel_id) WHERE expires_at > NOW();

-- Chat messages (partitioned by time for scale)
CREATE TABLE chat_messages (
  id BIGSERIAL,
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create monthly partitions
CREATE TABLE chat_messages_2024_01 PARTITION OF chat_messages
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Channel bans for moderation
CREATE TABLE channel_bans (
  channel_id INTEGER REFERENCES channels(id),
  user_id INTEGER REFERENCES users(id),
  banned_by INTEGER REFERENCES users(id),
  reason TEXT,
  expires_at TIMESTAMP, -- NULL = permanent
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);
```

### Redis Data Structures

```
# Viewer tracking per channel
viewers:{channelId}              -> Counter (INCR/DECR on join/leave)

# Chat rate limiting
ratelimit:chat:{channelId}:{userId} -> Counter with TTL

# Chat deduplication (5 min window)
chat_dedup:{channelId}           -> Set of message IDs

# Stream start lock (prevent duplicate go-live)
stream_lock:{channelId}          -> String with 10s TTL

# Idempotency cache for subscriptions
idempotency:{key}                -> JSON result with 24h TTL

# Pub/Sub channels
chat:{channelId}                 -> Pub/Sub for chat messages
```

---

## 4. Deep Dive: Stream Ingestion Pipeline (8 minutes)

### RTMP Server Flow

```javascript
const rtmpServer = new RTMPServer();

rtmpServer.on('connect', async (session) => {
  const { streamKey } = session.connectCmdObj;

  // Validate stream key against database
  const channel = await validateStreamKey(streamKey);

  if (!channel) {
    session.reject();
    return;
  }

  // Acquire lock to prevent duplicate go-live events
  const lockKey = `stream_lock:${channel.id}`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 10);

  if (!acquired) {
    // Check if already live (reconnect scenario)
    const existing = await getChannel(channel.id);
    if (existing.is_live) {
      session.channelId = channel.id;
      session.isReconnect = true;
      return; // Allow reconnect without creating new stream
    }
    session.reject();
    return;
  }

  try {
    // Create new stream record
    const stream = await createStream(channel.id);

    // Update channel status
    await pool.query(
      `UPDATE channels SET is_live = TRUE, current_viewers = 0 WHERE id = $1`,
      [channel.id]
    );

    // Notify chat system
    await redis.publish(`events:${channel.id}`, JSON.stringify({
      type: 'stream_start',
      channelId: channel.id,
      streamId: stream.id
    }));

    session.channelId = channel.id;
    session.streamId = stream.id;
  } finally {
    await redis.del(lockKey);
  }
});

rtmpServer.on('publish', (session) => {
  // Assign a transcoder for this stream
  const transcoderUrl = assignTranscoder(session.channelId);

  // Pipe RTMP stream to transcoder
  session.pipe(transcoderUrl);
});

rtmpServer.on('disconnect', async (session) => {
  if (session.isReconnect) return; // Don't end stream on reconnect disconnect

  // Wait briefly for potential reconnect
  await sleep(5000);

  // Check if still connected via another session
  const isStillLive = await checkActiveConnection(session.channelId);
  if (isStillLive) return;

  // End the stream
  await pool.query(
    `UPDATE streams SET ended_at = NOW() WHERE id = $1`,
    [session.streamId]
  );

  await pool.query(
    `UPDATE channels SET is_live = FALSE WHERE id = $1`,
    [session.channelId]
  );
});
```

### Transcoding Pipeline

```bash
# FFmpeg command for multi-quality HLS output
ffmpeg -i rtmp://input \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 6000k -s 1920x1080 -f hls \
    -hls_time 2 -hls_list_size 5 -hls_flags delete_segments \
    output_1080p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 3000k -s 1280x720 -f hls \
    -hls_time 2 -hls_list_size 5 -hls_flags delete_segments \
    output_720p.m3u8 \
  -map 0:v -map 0:a -c:v libx264 -preset veryfast \
    -b:v 1500k -s 854x480 -f hls \
    -hls_time 2 -hls_list_size 5 -hls_flags delete_segments \
    output_480p.m3u8
```

### HLS Master Manifest

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
1080p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=854x480
480p/playlist.m3u8
```

### Why RTMP for Ingest?

| Protocol | Latency | Reliability | Complexity |
|----------|---------|-------------|------------|
| RTMP | ~500ms | Good (TCP) | Low |
| SRT | ~200ms | Better | Medium |
| WebRTC | ~100ms | Complex | High |

**Choice**: RTMP for simplicity and universal support (OBS, Streamlabs, etc.)

---

## 5. Deep Dive: Chat System at Scale (10 minutes)

### Chat Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chat Service Cluster                         │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────┤
│  Chat Pod 1 │  Chat Pod 2 │  Chat Pod 3 │  Chat Pod N │   ...   │
│ (WS conns)  │ (WS conns)  │ (WS conns)  │ (WS conns)  │         │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Redis Pub/Sub (or Kafka)                     │
│              chat:{channelId} → all pods subscribed             │
└─────────────────────────────────────────────────────────────────┘
```

### Message Flow with Deduplication

```javascript
async function handleChatMessage(userId, channelId, messageId, content) {
  // 1. Check rate limit
  const rateLimitKey = `ratelimit:chat:${channelId}:${userId}`;
  const messageCount = await redis.incr(rateLimitKey);

  if (messageCount === 1) {
    await redis.expire(rateLimitKey, 1); // 1 message per second default
  }

  const channel = await getChannel(channelId);
  const cooldown = channel.slowModeSeconds || 1;

  if (messageCount > 1) {
    return { error: 'RATE_LIMITED', waitSeconds: cooldown };
  }

  // 2. Check if banned
  const isBanned = await checkBan(userId, channelId);
  if (isBanned) {
    return { error: 'BANNED' };
  }

  // 3. Deduplicate (handle client retries)
  const dedupKey = `chat_dedup:${channelId}`;
  const isNew = await redis.sadd(dedupKey, messageId);
  await redis.expire(dedupKey, 300); // 5 minute dedup window

  if (!isNew) {
    return { status: 'DUPLICATE', dropped: true };
  }

  // 4. Build enriched message
  const chatMessage = {
    id: messageId,
    userId,
    channelId,
    username: await getUsername(userId),
    message: content,
    badges: await getBadges(userId, channelId), // subscriber, mod, etc.
    timestamp: Date.now()
  };

  // 5. Publish to all chat pods via Redis Pub/Sub
  await redis.publish(`chat:${channelId}`, JSON.stringify(chatMessage));

  // 6. Store for moderation replay (async)
  storeChatMessage(chatMessage);

  return { status: 'SENT', message: chatMessage };
}

// Each chat pod subscribes and broadcasts to its WebSocket connections
async function setupChatPod() {
  const subscriber = redis.duplicate();

  subscriber.on('message', (channel, data) => {
    const channelId = channel.split(':')[1];
    const message = JSON.parse(data);
    broadcastToRoom(channelId, message);
  });

  // Subscribe to all active channels this pod handles
  for (const channelId of activeChannels) {
    await subscriber.subscribe(`chat:${channelId}`);
  }
}
```

### Rate Limiting Strategies

| Mode | Limit | Use Case |
|------|-------|----------|
| Normal | 1 msg/sec | Default for all users |
| Slow Mode | 5-120 sec | High-volume channels |
| Subscribers Only | N/A | Reduce spam during events |
| Follower Mode | 10min+ follow age | Only followers can chat |
| Emote Only | N/A | Special events |

### Chat Pod Scaling

```javascript
// Partition channels across chat pods
function getTargetPod(channelId) {
  const podCount = await redis.get('chat:pod_count');
  return channelId % podCount;
}

// Large channels get dedicated pods
async function assignChatPods(channelId) {
  const channel = await getChannel(channelId);

  if (channel.current_viewers > 50000) {
    // Assign 3 dedicated pods
    return ['chat-pod-large-1', 'chat-pod-large-2', 'chat-pod-large-3'];
  }

  // Use shared pod pool
  return [`chat-pod-${channelId % 10}`];
}
```

---

## 6. Deep Dive: VOD Recording (5 minutes)

### Parallel Recording During Live Stream

```javascript
// As transcoder outputs HLS segments, also archive them
async function handleSegment(channelId, streamId, segment) {
  const segmentKey = `${channelId}/${streamId}/${segment.sequence}.ts`;

  // 1. Send to CDN for live viewers (primary path)
  await cdn.uploadSegment(segment);

  // 2. Archive for VOD with retry and idempotency
  await withRetry(
    () => s3.putObject({
      bucket: 'vods',
      key: segmentKey,
      body: segment.data,
      contentType: 'video/mp2t'
    }),
    {
      idempotencyKey: `segment:${streamId}:${segment.sequence}`,
      maxRetries: 5
    }
  );

  // 3. Update VOD manifest
  await appendToVodManifest(channelId, streamId, segment);
}

async function appendToVodManifest(channelId, streamId, segment) {
  const manifestKey = `${channelId}/${streamId}/vod.m3u8`;

  // Get current manifest
  let manifest = await s3.getObject({ bucket: 'vods', key: manifestKey })
    .catch(() => initialManifest());

  // Append segment
  manifest += `#EXTINF:${segment.duration},\n`;
  manifest += `${segment.sequence}.ts\n`;

  // Upload updated manifest
  await s3.putObject({
    bucket: 'vods',
    key: manifestKey,
    body: manifest,
    contentType: 'application/vnd.apple.mpegurl'
  });
}
```

### Why Record Segments Directly?

- **Instant VOD**: No post-processing needed after stream ends
- **Same format**: Live and VOD use identical HLS segments
- **Efficient**: Just copy bytes, no re-encoding required
- **Resumable**: If upload fails, retry individual segment

---

## 7. Reliability & Failure Handling (5 minutes)

### Circuit Breaker Pattern

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
  }

  async call(operation, fallback) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else if (fallback) {
        return fallback();
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback) return fallback();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// Circuit breakers for dependencies
const circuitBreakers = {
  redis: new CircuitBreaker('redis', { failureThreshold: 5, resetTimeoutMs: 5000 }),
  database: new CircuitBreaker('database', { failureThreshold: 3, resetTimeoutMs: 10000 }),
  s3: new CircuitBreaker('s3', { failureThreshold: 5, resetTimeoutMs: 30000 })
};

// Usage with fallback
async function broadcastChatMessage(channelId, message) {
  await circuitBreakers.redis.call(
    () => redis.publish(`chat:${channelId}`, JSON.stringify(message)),
    () => localBroadcast(channelId, message) // Fallback to local-only
  );
}
```

### Idempotency for Subscriptions

```javascript
async function createSubscription(userId, channelId, tier, idempotencyKey) {
  // Check if already processed
  const cached = await redis.get(`idempotency:${idempotencyKey}`);
  if (cached) {
    return JSON.parse(cached); // Return cached result
  }

  // Process subscription in transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check for existing active subscription
    const existing = await client.query(
      `SELECT id FROM subscriptions
       WHERE user_id = $1 AND channel_id = $2 AND expires_at > NOW()`,
      [userId, channelId]
    );

    if (existing.rows.length > 0) {
      // Extend existing subscription
      await client.query(
        `UPDATE subscriptions
         SET expires_at = expires_at + INTERVAL '1 month', tier = $3
         WHERE id = $4`,
        [tier, existing.rows[0].id]
      );
    } else {
      // Create new subscription
      await client.query(
        `INSERT INTO subscriptions (user_id, channel_id, tier, expires_at, idempotency_key)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 month', $4)`,
        [userId, channelId, tier, idempotencyKey]
      );
    }

    // Update channel subscriber count
    await client.query(
      `UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = $1`,
      [channelId]
    );

    await client.query('COMMIT');

    const result = { success: true, tier, expiresAt: addMonths(new Date(), 1) };

    // Cache result for 24 hours
    await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(result));

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 8. Observability (3 minutes)

### Prometheus Metrics

```javascript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

const register = new Registry();

// HTTP request metrics
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

// Business metrics
const activeStreams = new Gauge({
  name: 'twitch_active_streams',
  help: 'Number of currently live streams'
});

const chatMessagesTotal = new Counter({
  name: 'twitch_chat_messages_total',
  help: 'Total chat messages processed',
  labelNames: ['channel_id']
});

const wsConnections = new Gauge({
  name: 'twitch_websocket_connections',
  help: 'Active WebSocket connections'
});

const viewerCount = new Gauge({
  name: 'twitch_viewer_count',
  help: 'Total viewers across all streams'
});

const circuitBreakerState = new Gauge({
  name: 'twitch_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
  labelNames: ['circuit']
});
```

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High API Latency | p95 > 500ms for 5 min | Warning | Check database queries |
| Error Rate Spike | 5xx rate > 1% for 2 min | Critical | Check logs, rollback |
| Redis Connection Lost | Down > 30s | Critical | Chat will degrade |
| No Active Streams | 0 streams for 10 min | Warning | Check ingest service |
| WebSocket Saturation | > 80% limit | Warning | Scale chat pods |

---

## 9. Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Video protocol | HLS | WebRTC | Scalability over latency |
| Chat transport | WebSocket + Pub/Sub | Kafka | Simplicity for learning |
| VOD storage | Segment archive | Re-encode | Instant availability |
| Transcoding | Per-stream workers | Shared pool | Isolation |
| Stream key auth | Database lookup | JWT | Simpler revocation |

---

## 10. Summary

This backend architecture handles Twitch's core systems:

1. **Video Pipeline**: RTMP ingest with stream key auth, FFmpeg transcoding to HLS, CDN delivery with >99% cache hit ratio

2. **Chat System**: WebSocket pods with Redis Pub/Sub fan-out, deduplication, rate limiting, and circuit breakers for graceful degradation

3. **VOD Recording**: Parallel segment archival during live for instant availability

4. **Reliability**: Idempotency keys for payments, distributed locks for stream start, circuit breakers for dependencies

5. **Observability**: Prometheus metrics for streams, chat, connections with alerting thresholds

The system scales horizontally with dedicated transcoders per stream and partitioned chat pods per channel size.
