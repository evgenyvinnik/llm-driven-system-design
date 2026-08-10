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

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **channels** | id (SERIAL PK), user_id (FK to users), name (UNIQUE), stream_key (UNIQUE), title, category_id (FK), follower_count, subscriber_count, is_live (BOOLEAN), current_viewers, version (optimistic locking), created_at | Partial index on is_live WHERE is_live = TRUE; composite index on (category_id, current_viewers DESC) | Version column enables optimistic concurrency control for viewer count updates |
| **streams** | id (SERIAL PK), channel_id (FK), title, started_at, ended_at, peak_viewers, total_views, vod_url | Composite index on (channel_id, started_at DESC) | Each row represents one broadcast session; ended_at is NULL while live |
| **subscriptions** | id (SERIAL PK), user_id (FK), channel_id (FK), tier (1/2/3), started_at, expires_at, is_gift, gifted_by (FK), idempotency_key (UNIQUE) | Unique partial index on (user_id, channel_id) WHERE expires_at > NOW() | Idempotency key prevents duplicate subscription charges |
| **chat_messages** | id (BIGSERIAL), channel_id (FK), user_id (FK), message (TEXT), created_at | Partitioned by RANGE on created_at (monthly partitions) | Composite PK on (id, created_at) to support partitioning; old partitions can be dropped for cleanup |
| **channel_bans** | channel_id + user_id (composite PK), banned_by (FK), reason, expires_at (NULL = permanent), created_at | -- | expires_at being NULL means a permanent ban |

### Redis Data Structures

| Key | Type | Purpose |
|-----|------|---------|
| `viewers:{channelId}` | Counter | Viewer tracking, incremented/decremented on join and leave |
| `ratelimit:chat:{channelId}:{userId}` | String + TTL | Per-user chat cooldown |
| `chat_dedup:{channelId}` | Set (5-min window) | Message-ID dedup for client retries |
| `stream_lock:{channelId}` | String, 10s TTL | Prevents a duplicate go-live from a reconnecting encoder |
| `idempotency:{key}` | JSON, 24h TTL | Cached subscription result for safe retries |
| `chat:{channelId}` | Pub/Sub channel | Cross-instance chat fan-out |

Note that Redis is carrying four unrelated responsibilities here — cooldowns, dedup, locking, and the message bus. That is convenient and it concentrates risk: an outage takes out rate limiting, dedup, and fan-out simultaneously, which is the reason the publish path needs the circuit breaker described in §5 while the others simply fail.

---

## 4. Deep Dive: Stream Ingestion Pipeline (8 minutes)

### RTMP Server Flow

The RTMP ingest server handles three key events:

**On Connect:**
1. Extract the stream key from the RTMP connection command
2. Validate the stream key against the database; reject the session if invalid
3. Acquire a distributed lock in Redis (`stream_lock:{channelId}` with 10-second TTL) to prevent duplicate go-live events
4. If the lock is already held, check whether the channel is already live -- if so, treat this as a reconnect and allow it without creating a new stream record. Otherwise, reject the session
5. Create a new stream record in the database
6. Update the channel to `is_live = TRUE` and reset `current_viewers` to 0
7. Publish a "stream_start" event via Redis pub/sub to notify the chat system
8. Release the lock

**On Publish:**
1. Assign a transcoder instance to this stream based on the channel ID
2. Pipe the incoming RTMP data to the assigned transcoder

**On Disconnect:**
1. If this was a reconnect session, do nothing (the original session handles cleanup)
2. Wait 5 seconds to allow for potential reconnection (handles brief network drops)
3. Check if the channel has reconnected via another session during that window
4. If still disconnected, mark the stream's `ended_at` timestamp and set the channel to `is_live = FALSE`

### Transcoding Pipeline

The transcoder takes the RTMP input and produces multi-quality HLS output using FFmpeg. It generates three quality tiers simultaneously from a single input stream: 1080p at 6000 kbps, 720p at 3000 kbps, and 480p at 1500 kbps. Each output uses the `veryfast` encoding preset for low latency, produces 2-second HLS segments, keeps only the 5 most recent segments in the playlist (sliding window), and deletes old segments to manage disk usage.

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

### The message pipeline, and why its order is the design

Every chat message runs a gauntlet before it is allowed to exist, and the *sequence* carries more design weight than any individual step:

1. **Deduplicate.** Resolve the message ID (client-supplied, or generated) and check it against a short-lived Redis window. A duplicate is dropped silently — no response at all.
2. **Rate limit.** Read the per-user cooldown key for this channel; reject if the user is inside the window.
3. **Ban check.** Query `channel_bans` with an `expires_at IS NULL OR expires_at > NOW()` predicate, so permanent and timed bans are one query.
4. **Resolve badges.** Role, active subscription tier, channel-moderator status.
5. **Persist to Postgres.**
6. **Publish to Redis**, which fans out to every instance holding sockets in this channel — including the publishing instance, which then writes to its own local sockets.

**Dedup must come before rate limiting.** This looks like a micro-optimization and is actually a correctness requirement. A phone on a flaky connection sends a message, loses the ack, and resends. With rate limiting first, the retry is rejected as "Slow down!" — the user sees an error for a message that already succeeded, and the client now has no way to determine which is true. With dedup first, the retry is a silent no-op and the user's state stays consistent. The retry must not consume budget it already paid.

The silence is deliberate too: returning an error on a duplicate would tell the client the message failed. The cost is that a genuine duplicate looks identical to a bug in the logs, which is why the drop is logged at debug with the message ID attached.

**Persist before publish, not after.** This is the trade-off I would expect to be challenged on, because writing to Postgres synchronously puts the slowest operation in the pipeline directly in the latency path of the highest-volume write in the system. The argument for reversing it is real: publish first and the perceived latency drops to a Redis round trip.

It is still wrong here, because the two failure modes are not symmetric. Publish-then-crash means viewers saw a message that no longer exists — it is absent from the scrollback the next viewer receives on join, and it cannot be moderated after the fact because there is no row to act on. A moderator who saw something and goes to remove it finds nothing there. Write-then-crash produces the opposite: a durable message nobody saw live, which the next join surfaces. For a system that has to answer "what was said in this channel?", *durable but undelivered* is recoverable and *delivered but not durable* is not.

There is an asymmetry worth flagging: guests can chat, but the insert is guarded on having a user ID, so guest messages are live-only and vanish from scrollback. That is a defensible product decision and an easy one to make accidentally.

### Fan-out: pub/sub over a direct mesh

Broadcasting to the local socket set works perfectly on one instance and breaks silently on two — viewers on instance A see each other, viewers on B see each other, and neither group sees the other. No error is raised anywhere; there are simply two parallel realities in the same chat room. That failure is invisible in every single-instance test, which is why the fan-out has to go through a shared bus from the start rather than being retrofitted.

Instances subscribe **per channel, on demand** — the first client to join a channel triggers the subscribe, the last to leave triggers the unsubscribe. A wildcard subscription would be simpler and would mean every instance receives the message volume of every channel on the platform in order to discard almost all of it.

**What pub/sub gives up is delivery guarantees.** Redis pub/sub is fire-and-forget: a message published while a subscriber is momentarily disconnected is gone, with no backlog and no replay. That is only tolerable because durability is Postgres's job, and it is precisely why step 5 precedes step 6. Kafka would give ordered, replayable delivery — at the cost of consumer-group coordination and a broker to operate, for a payload whose value expires in about two seconds.

**The publish is circuit-broken with a local-broadcast fallback.** Without it, a Redis stall means every chat message awaits a doomed publish; that is not a chat outage but a process outage, because thousands of concurrent chatters each hold a pending promise and an open socket while the event loop fills with retries. The breaker converts a hang into a fast failure, and the fallback converts the fast failure into a partial feature — viewers on your instance still see each other. Chat visibly fractures across instances during the outage, which is bad, and still much better than chat stopping.

### One detail that fails at runtime, not compile time

Each instance needs a *dedicated* Redis subscriber connection, separate from the client it uses for cooldown keys and dedup sets. A connection in subscriber mode accepts nothing but subscribe/unsubscribe commands, so sharing a single client means every other Redis operation starts failing the moment the first channel is joined. Nothing in the type system catches it, and it works fine right up until someone opens a chat.

### Counting viewers is harder than it looks

The obvious viewer count is the size of the local socket set, and it is wrong in a specific way: it counts the sockets *one process* holds. Across instances each reports its own slice, so the number a viewer sees depends on which instance they were balanced onto. The count that is actually correct — distinct concurrent viewers across all instances — is a presence problem, not a chat problem: per-instance Redis counters with periodic reconciliation get close, and true accuracy needs a dedicated presence service with heartbeat expiry, because a process that dies without cleaning up leaves its viewers counted forever.

### Rate limiting: a cooldown key, not a sliding window

The limiter is one Redis key per user per channel: read the stored timestamp, compare against the cooldown, re-set with an expiry equal to the cooldown. One GET and one SET per message.

This is deliberately weaker than the sorted-set sliding windows used for API rate limiting, and it is the right weakness here. A sliding window stores one member per request — in a channel with 100K viewers, that is an enormous churn of short-lived sorted-set entries whose only purpose is to enforce a rule expressible as "not more often than every N seconds." The cooldown collapses the entire window into one self-cleaning key.

What it gives up is burst tolerance. A sliding window lets someone send three messages quickly and then wait, which is how people actually type; the cooldown enforces strict spacing and will reject the second half of a legitimate double-post. For chat that is arguably correct — strict spacing is exactly what slow mode *is*, so the limiter and the product feature are the same mechanism at different settings.

### Rate Limiting Strategies

| Mode | Limit | Use Case |
|------|-------|----------|
| Normal | 1 msg/sec | Default for all users |
| Slow Mode | 5-120 sec | High-volume channels |
| Subscribers Only | N/A | Reduce spam during events |
| Follower Mode | 10min+ follow age | Only followers can chat |
| Emote Only | N/A | Special events |

### Bans are enforced on the hot path, not at connection time

The ban check runs per message rather than once at join. Checking at join is one query instead of thousands and is what a naive implementation does — and it means a user banned *during* a stream keeps chatting until they voluntarily reconnect, which is precisely the moment the ban matters. A moderator banning someone mid-argument expects it to take effect on their next message, not their next page load.

The cost is a database read on the highest-volume write in the system. It is affordable because the query is a composite-primary-key lookup on `(channel_id, user_id)` and the predicate `expires_at IS NULL OR expires_at > NOW()` covers permanent and timed bans in the same statement, so timeouts need no expiry job — they simply stop matching. A per-channel ban set in Redis, invalidated on moderation events, would remove the read entirely and is the obvious next step if this becomes hot.

### Chat Pod Scaling

Channels are partitioned across chat pods using modular hashing: a channel is assigned to pod number `channelId % podCount`. However, large channels (over 50,000 concurrent viewers) get 3 dedicated pods to handle the WebSocket connection load and message fan-out volume. Smaller channels share pods from a pool of 10 shared instances.

---

## 6. Deep Dive: VOD Recording (5 minutes)

### Parallel Recording During Live Stream

As the transcoder outputs HLS segments, each segment is handled in parallel for both live delivery and VOD archival:

1. **CDN upload (primary path)**: The segment is immediately pushed to the CDN for live viewers -- this is latency-critical and takes priority
2. **S3 archival (secondary path)**: The same segment is uploaded to an S3 "vods" bucket at path `{channelId}/{streamId}/{sequence}.ts` with retry logic (up to 5 retries) and an idempotency key (`segment:{streamId}:{sequence}`) to prevent duplicate writes
3. **VOD manifest update**: After archiving the segment, append its entry (duration and filename) to a running HLS manifest file at `{channelId}/{streamId}/vod.m3u8` in S3. If the manifest does not exist yet, create it with an initial header.

### Why Record Segments Directly?

- **Instant VOD**: No post-processing needed after stream ends
- **Same format**: Live and VOD use identical HLS segments
- **Efficient**: Just copy bytes, no re-encoding required
- **Resumable**: If upload fails, retry individual segment

---

## 7. Reliability & Failure Handling (5 minutes)

### Circuit Breaker Pattern

We implement circuit breakers for each external dependency (Redis, database, S3) with configurable thresholds. The circuit breaker maintains three states:

- **CLOSED** (normal): Requests pass through. On each failure, increment a failure counter. When failures reach the threshold (e.g., 5 for Redis, 3 for database), transition to OPEN.
- **OPEN** (tripped): All requests immediately fail or invoke a fallback. After a reset timeout (e.g., 5 seconds for Redis, 10 seconds for database, 30 seconds for S3), transition to HALF_OPEN.
- **HALF_OPEN** (testing): Allow one request through. If it succeeds, return to CLOSED and reset the failure counter. If it fails, return to OPEN.

Each circuit breaker accepts an optional fallback function. For example, the chat broadcast circuit breaker falls back to local-only broadcast (only reaching WebSocket connections on the current pod) when Redis pub/sub is unavailable. This means chat degrades to pod-local delivery rather than failing entirely.

### Idempotency for Subscriptions

The subscription creation flow ensures exactly-once payment processing:

1. **Check idempotency cache**: Look up the idempotency key in Redis. If a cached result exists, return it immediately -- this handles client retries safely.
2. **Begin a database transaction**: All subscription changes happen atomically.
3. **Check for existing active subscription**: Query subscriptions for this user and channel where `expires_at > NOW()`.
4. **If already subscribed**: Extend the existing subscription by 1 month and update the tier.
5. **If new subscription**: Insert a new row with the idempotency key, tier, and expiration set to 1 month from now.
6. **Increment subscriber count**: Update the channel's `subscriber_count` within the same transaction.
7. **Commit the transaction**: If anything fails, roll back entirely.
8. **Cache the result**: Store the success response in Redis under the idempotency key with a 24-hour TTL, so retries within that window return the same result without re-processing.

---

## 8. Observability (3 minutes)

### Prometheus Metrics

We track both infrastructure and business metrics:

**Infrastructure metrics:**
- **HTTP request duration** (histogram): Labeled by method, route, and status code, with buckets at 10ms, 50ms, 100ms, 500ms, 1s, 2s, and 5s

**Business metrics:**
- **Active streams** (gauge): Number of currently live streams
- **Chat messages total** (counter): Total chat messages processed, labeled by channel ID
- **WebSocket connections** (gauge): Current active WebSocket connections across all chat pods
- **Viewer count** (gauge): Total viewers across all live streams
- **Circuit breaker state** (gauge): Numeric state per circuit (0=closed, 1=open, 2=half-open), labeled by circuit name

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High API Latency | p95 > 500ms for 5 min | Warning | Check database queries |
| Error Rate Spike | 5xx rate > 1% for 2 min | Critical | Check logs, rollback |
| Redis Connection Lost | Down > 30s | Critical | Chat will degrade |
| No Active Streams | 0 streams for 10 min | Warning | Check ingest service |
| WebSocket Saturation | > 80% limit | Warning | Scale chat pods |

---

## 9. Trade-offs Summary (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Video protocol | HLS | WebRTC | Scales over commodity CDN; WebRTC's sub-second latency needs per-viewer connection state |
| Chat transport | WebSocket + Redis pub/sub | Kafka | At-most-once is acceptable when Postgres holds durability; a broker is not worth operating for a 2-second-lived payload |
| Chat ordering | Persist, then publish | Publish, then persist | "Delivered but not durable" is unrecoverable for a moderated system; the reverse is not |
| Dedup position | Before rate limiting | After | A retry must not consume rate-limit budget it already paid |
| Rate limiting | Per-user cooldown key | Sorted-set sliding window | One key with a self-cleaning TTL instead of one member per message at chat volume |
| Fan-out subscription | Per channel, on demand | Wildcard subscribe | An instance should not receive every channel's traffic to discard it |
| Publish failure | Circuit breaker + local broadcast | Fail the message | Partial delivery beats a stalled event loop holding thousands of promises |
| VOD storage | Archive live segments | Re-encode after stream | Instant availability, no second encode, resumable per segment |
| Stream key auth | Database lookup | JWT | Revocation is immediate; a leaked key must die the moment it is rotated |

### What breaks first

**Chat history.** `chat_messages` grows without bound, and every join reads the most recent 50 rows from it. Monthly range partitioning makes the read touch one partition and makes retention a `DROP PARTITION` rather than a mass `DELETE`. The alternative worth considering is serving scrollback from a capped Redis list per channel and keeping Postgres purely for moderation history — faster joins, at the cost of two sources of truth for the same messages.

**Badge resolution.** Up to three extra queries per message (role, subscription, moderator) on the highest-volume write path, for data that changes rarely. Resolving them once at authentication and caching them on the connection removes almost all of it — but then a ban or a mod promotion does not take effect until the user reconnects, which is exactly wrong for the moderation actions that most need to be immediate. The compromise is to cache badges and invalidate on moderation events specifically.

**The WebSocket authentication seam.** The connection currently trusts the user ID the client sends in its auth frame rather than deriving it from the HTTP session. That is fine on a laptop and disqualifying anywhere else: any client can claim any user ID and inherit their badges and moderator powers. The fix is to read the session cookie during the upgrade handshake, which is the single most important change on this list.

---

## 10. Summary

Four decisions carry this design:

1. **The video path and the chat path are different problems.** Video is bandwidth with a latency budget and almost no application logic; chat is fan-out with a moderation gauntlet on the hot path. They share a page and nothing else, and the interesting distributed-systems content is all on the chat side.
2. **Ordering in the chat pipeline is the design.** Dedup before rate limiting keeps retries honest; persist before publish makes every delivered message moderatable. Both are one-line reorderings that are very hard to diagnose after the fact if they are wrong.
3. **Durability and delivery are separate systems with separate failure modes.** Redis moves messages, Postgres remembers them. Losing the bus degrades the product; losing the record corrupts it.
4. **Degradation is designed, not incidental.** The circuit breaker's local-broadcast fallback, the per-dependency health tiering, and the choice to let chat fracture rather than stop are all the same judgment applied consistently: prefer a visibly partial feature to a stalled one.
