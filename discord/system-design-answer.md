# Discord (Real-Time Chat System) - System Design Interview Answer

## Introduction

"Today I'll design a real-time chat system similar to Discord. The core challenge is enabling millions of users to send and receive messages instantly across servers and channels, while handling presence updates, message history, and voice communication. Let me walk through my approach."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm what we're building:

1. **Servers & Channels**: Users create servers, servers contain text/voice channels
2. **Real-Time Messaging**: Messages appear instantly for all channel members
3. **Message History**: Scrollable history, searchable
4. **Presence**: Show who's online/offline/idle
5. **Direct Messages**: Private 1-on-1 and group DMs
6. **Reactions & Threads**: Emoji reactions, threaded replies
7. **Voice/Video**: Real-time voice channels (can discuss at high level)

Should I focus on text chat, or also design the voice infrastructure?"

### Non-Functional Requirements

"For a chat system like Discord:

- **Scale**: 100 million users, 10 million concurrent
- **Latency**: Messages delivered in <100ms (real-time feel)
- **Availability**: 99.99% - chat being down is immediately noticeable
- **Ordering**: Messages in a channel must appear in order
- **Persistence**: Messages stored forever (or until deleted)"

---

## Step 2: Scale Estimation

"Let me work through the numbers:

**Concurrent Users:**
- 10 million concurrent connections
- Average user in 5 servers, viewing 1 channel at a time
- Each user receives: presence updates + messages from current channel

**Message Volume:**
- 100 million messages per day
- Peak: 10x average = ~12,000 messages/second
- Each message: ~200 bytes (text) + metadata

**Connection Overhead:**
- 10M WebSocket connections
- Each connection: ~10KB memory
- Total: ~100 GB RAM just for connections (need many servers)

**Storage:**
- 100M messages * 365 days * 1KB (with indexes) = ~36 TB/year
- Need to scale horizontally"

---

## Step 3: High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client Applications                           │
│           (Web, Desktop, Mobile - WebSocket Connections)             │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ WebSocket
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Gateway Layer (WebSocket)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       ┌──────────┐       │
│  │Gateway 1 │  │Gateway 2 │  │Gateway 3 │  ...  │Gateway N │       │
│  │(100K     │  │(100K     │  │(100K     │       │(100K     │       │
│  │ conns)   │  │ conns)   │  │ conns)   │       │ conns)   │       │
│  └──────────┘  └──────────┘  └──────────┘       └──────────┘       │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Message Broker (Kafka/NATS)                      │
│              Topics: messages, presence, typing, reactions           │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Chat Service   │    │Presence Service │    │  Push Service   │
│  (Message CRUD) │    │ (Online Status) │    │ (Mobile Notif)  │
└────────┬────────┘    └────────┬────────┘    └─────────────────┘
         │                      │
         ▼                      ▼
┌─────────────────┐    ┌─────────────────┐
│   Cassandra     │    │     Redis       │
│  (Messages)     │    │   (Presence,    │
│                 │    │    Sessions)    │
└─────────────────┘    └─────────────────┘
```

---

## Step 4: Gateway Layer (WebSocket Servers)

"This is the most interesting part - how do we handle 10 million concurrent connections?

### Gateway Server Design

```
Each Gateway Server:
- Handles 100,000 concurrent WebSocket connections
- Maintains session state (which user, which channels subscribed)
- Fans out messages to connected clients
- Heartbeat to detect dead connections
```

**Why 100K per server?**
- Linux can handle ~1M file descriptors per process
- 100K is comfortable with headroom for CPU/memory
- Gives us 100 gateway servers for 10M connections

### Session State

```python
class GatewaySession:
    user_id: str
    connection: WebSocket
    subscribed_channels: Set[str]
    current_guild_id: str
    last_heartbeat: datetime

class GatewayServer:
    sessions: Dict[str, GatewaySession]  # user_id -> session
    channel_subscribers: Dict[str, Set[str]]  # channel_id -> user_ids

    async def handle_message(self, user_id, payload):
        match payload['type']:
            case 'SEND_MESSAGE':
                await self.publish_to_channel(payload)
            case 'SUBSCRIBE_CHANNEL':
                self.add_subscription(user_id, payload['channel_id'])
            case 'HEARTBEAT':
                self.update_heartbeat(user_id)
```

### Cross-Gateway Message Routing

"When User A (on Gateway 1) sends a message to a channel, User B (on Gateway 5) needs to receive it. How?

**Solution: Pub/Sub with Redis or Kafka**

```
┌──────────────┐                              ┌──────────────┐
│  Gateway 1   │                              │  Gateway 5   │
│   User A     │                              │   User B     │
└──────┬───────┘                              └──────▲───────┘
       │                                             │
       │ PUBLISH channel:12345                       │ SUBSCRIBE channel:12345
       ▼                                             │
┌─────────────────────────────────────────────────────────────┐
│                    Redis Pub/Sub                             │
│                 Channel: channel:12345                       │
└─────────────────────────────────────────────────────────────┘
```

Each Gateway:
1. Subscribes to Redis channels for all channels its users are viewing
2. When a message arrives, fans out to local connections
3. Publishes outgoing messages to Redis

**Trade-off:** Redis Pub/Sub has no persistence. Messages to offline users need separate handling."

---

## Step 5: Message Storage

### Why Cassandra?

"For message storage, I'd use Cassandra because:

1. **Write-Heavy**: Chat is write-heavy, Cassandra excels at writes
2. **Time-Series Like**: Messages are append-only, queried by time range
3. **Horizontal Scale**: Easy to add nodes as data grows
4. **No Single Point of Failure**: Distributed by design

### Schema Design

```cql
-- Messages partitioned by channel, clustered by time (descending)
CREATE TABLE messages (
    channel_id UUID,
    message_id TIMEUUID,  -- Time-based UUID for ordering
    author_id UUID,
    content TEXT,
    attachments LIST<FROZEN<attachment>>,
    edited_at TIMESTAMP,
    PRIMARY KEY (channel_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- User type for attachment metadata
CREATE TYPE attachment (
    url TEXT,
    filename TEXT,
    content_type TEXT,
    size INT
);
```

### Why This Partition Key?

- `channel_id` as partition key: All messages in a channel on same partition
- `message_id` (TIMEUUID) as clustering: Automatic time ordering
- Descending order: Most recent messages first (common access pattern)

### Hot Partition Problem

"What if one channel has millions of messages? That's a hot partition.

**Solution: Bucket by Time**

```cql
CREATE TABLE messages (
    channel_id UUID,
    bucket TEXT,  -- e.g., '2024-01-15' (daily bucket)
    message_id TIMEUUID,
    author_id UUID,
    content TEXT,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

Now each partition holds one day's messages. For very active channels, could use hourly buckets."

---

## Step 6: Message Delivery Flow

### Send Message Flow

```
1. User sends message via WebSocket to Gateway
2. Gateway validates message (auth, permissions, rate limit)
3. Gateway publishes to Kafka topic 'messages'
4. Chat Service consumes, writes to Cassandra
5. Chat Service publishes to Redis Pub/Sub for channel
6. All Gateways subscribed to channel receive message
7. Each Gateway fans out to connected users in that channel
```

**Latency Breakdown:**
- Client → Gateway: ~20ms (network)
- Gateway → Kafka: ~5ms
- Kafka → Chat Service: ~10ms
- Write to Cassandra: ~10ms
- Publish to Redis: ~5ms
- Redis → Gateways: ~5ms
- Gateway → Clients: ~20ms
- **Total: ~75ms** (within 100ms target)

### Message Ordering

"How do we ensure messages appear in order?

1. **Per-Channel Ordering**: Messages within a channel must be ordered
2. **Solution**: Use Kafka with channel_id as partition key
3. **Each partition is ordered**: Single consumer per partition
4. **Message ID**: TIMEUUID from Cassandra provides total ordering

**Edge Case**: What if two users send at the 'same' time?
- Use server-side timestamp (not client)
- TIMEUUID guarantees uniqueness even at same millisecond
- Accept that 'first to reach server' wins"

---

## Step 7: Presence System

"Showing who's online is deceptively complex at scale.

### Presence Data Model

```python
class UserPresence:
    user_id: str
    status: str  # online, idle, dnd, offline
    custom_status: str
    last_seen: datetime
    active_sessions: List[Session]
```

### Presence Storage

"Redis is perfect for presence:

```redis
# Online status (set with expiry for auto-offline)
SETEX presence:user:123 60 'online'

# Custom status
HSET user:123:status text 'Playing Minecraft' emoji '🎮'

# Active sessions
SADD user:123:sessions gateway-5:sess-abc gateway-2:sess-xyz
```

**Heartbeat-Based Status:**
1. Client sends heartbeat every 30 seconds
2. Gateway updates Redis with 60-second expiry
3. If no heartbeat for 60 seconds, key expires → user is offline"

### Presence Fanout Problem

"User has 1000 friends. When they come online, do we notify all 1000?

**Naive Approach**: Publish to all friends
- 10M users * 500 average friends * 2 events/min (online/offline) = 10 billion events/min
- This doesn't scale

**Smart Approach**: Lazy Presence

1. When User A views a channel, subscribe to presence of users in that channel
2. When User A opens DM list, fetch presence of recent DM contacts
3. Don't push presence updates globally

```
┌─────────────────────────────────────────────────────────────┐
│              Presence Subscription Model                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  User views channel #general                                 │
│    → Subscribe to presence of channel members               │
│    → Gateway maintains: channel:general → [user_ids]        │
│                                                              │
│  When member comes online:                                   │
│    → Publish to Redis: presence:channel:general             │
│    → Only Gateways with viewers of #general receive         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Trade-off**: Slight delay in presence updates for non-active channels, but massive reduction in traffic."

---

## Step 8: Direct Messages

"DMs are simpler than channels:

### DM Channel Creation

```python
def get_or_create_dm_channel(user_a, user_b):
    # Consistent ordering for idempotency
    participants = sorted([user_a, user_b])
    channel_id = hash(f'dm:{participants[0]}:{participants[1]}')

    # Check if exists in cache
    if dm_exists(channel_id):
        return channel_id

    # Create in database
    create_dm_channel(channel_id, participants)
    return channel_id
```

### DM Storage

```cql
-- Same structure as channel messages
CREATE TABLE dm_messages (
    dm_channel_id UUID,
    bucket TEXT,
    message_id TIMEUUID,
    author_id UUID,
    content TEXT,
    PRIMARY KEY ((dm_channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

### Privacy

- DM channel IDs are not enumerable
- Only participants can access
- End-to-end encryption possible (but Discord doesn't currently)"

---

## Step 9: Search

"Searching message history requires a different approach than our Cassandra store.

### Architecture

```
Messages → Cassandra (primary store)
         → Kafka → Elasticsearch (search index)
```

### Elasticsearch Index

```json
{
  "mappings": {
    "properties": {
      "channel_id": { "type": "keyword" },
      "guild_id": { "type": "keyword" },
      "author_id": { "type": "keyword" },
      "content": { "type": "text", "analyzer": "standard" },
      "timestamp": { "type": "date" },
      "has_attachment": { "type": "boolean" }
    }
  }
}
```

### Search API

```
GET /api/search
  ?query=meeting notes
  &channel_id=12345
  &from_date=2024-01-01
  &author_id=67890

Response:
{
  "results": [
    {
      "message_id": "...",
      "content": "Here are the meeting notes from...",
      "highlight": "Here are the <em>meeting notes</em> from...",
      "channel_id": "12345",
      "author": {...},
      "timestamp": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 42
}
```

**Trade-off**: Search index may lag behind real-time messages by a few seconds. Acceptable for search use case."

---

## Step 10: Voice Channels

"At a high level, voice uses different infrastructure:

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Voice Signaling                          │
│    (Same Gateway - coordinates who's in voice channel)       │
└────────────────────────────────┬────────────────────────────┘
                                 │ SDP negotiation
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                     Voice Servers                            │
│             (Selective Forwarding Units - SFUs)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ Voice 1  │  │ Voice 2  │  │ Voice 3  │                   │
│  │(Region A)│  │(Region B)│  │(Region C)│                   │
│  └──────────┘  └──────────┘  └──────────┘                   │
└─────────────────────────────────────────────────────────────┘
                                 │
                                 │ UDP/WebRTC
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                        Clients                               │
│              (Send/receive audio/video streams)              │
└─────────────────────────────────────────────────────────────┘
```

### Key Concepts

1. **SFU (Selective Forwarding Unit)**: Receives all streams, forwards relevant ones to each client
2. **WebRTC**: Browser standard for real-time audio/video
3. **TURN/STUN**: NAT traversal for peer connectivity
4. **Opus Codec**: Low-latency audio compression

### Why Not Peer-to-Peer?

- With 10 users in a call, P2P = 90 connections (n*(n-1))
- SFU = 10 connections (each user to server)
- Also enables server-side recording, moderation"

---

## Step 11: Rate Limiting and Abuse Prevention

```python
class RateLimiter:
    def __init__(self, redis):
        self.redis = redis

    async def check_limit(self, user_id, action, limit, window):
        key = f'ratelimit:{action}:{user_id}'

        current = await self.redis.incr(key)
        if current == 1:
            await self.redis.expire(key, window)

        if current > limit:
            raise RateLimitExceeded(
                retry_after=await self.redis.ttl(key)
            )

# Rate limits
RATE_LIMITS = {
    'send_message': (5, 5),    # 5 messages per 5 seconds
    'create_channel': (10, 60), # 10 channels per minute
    'add_reaction': (10, 1),    # 10 reactions per second
}
```

### Spam Detection

```python
class SpamDetector:
    def is_spam(self, message, user):
        # Duplicate message detection
        if self.is_duplicate(message.content, user.recent_messages):
            return True

        # Suspicious patterns
        if self.contains_spam_patterns(message.content):
            return True

        # Velocity check
        if user.messages_last_minute > 30:
            return True

        return False
```

---

## Step 12: Scalability Considerations

### Horizontal Scaling

| Component | Scaling Strategy |
|-----------|------------------|
| Gateway | Add more servers (100K connections each) |
| Kafka | Add partitions (partition by channel_id) |
| Chat Service | Stateless, scale behind load balancer |
| Cassandra | Add nodes, replication factor 3 |
| Redis | Redis Cluster for presence/pub-sub |
| Elasticsearch | Add shards for search |

### Multi-Region

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   US Region     │    │   EU Region     │    │  APAC Region    │
│                 │    │                 │    │                 │
│  Gateways       │◄──►│  Gateways       │◄──►│  Gateways       │
│  Cassandra      │    │  Cassandra      │    │  Cassandra      │
│  Redis          │    │  Redis          │    │  Redis          │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    Cross-Region Sync (Cassandra)
```

- Users connect to nearest region
- Cassandra replicates across regions
- Cross-region messages have ~100-200ms additional latency"

---

## Step 13: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Real-time | WebSocket | HTTP polling, SSE | True bidirectional, lower overhead |
| Message Store | Cassandra | PostgreSQL, ScyllaDB | Write throughput, horizontal scale |
| Presence/Pubsub | Redis | Kafka, custom | Low latency, simple pub/sub |
| Search | Elasticsearch | PostgreSQL full-text | Scale, relevance ranking |
| Voice | SFU (custom) | P2P, MCU | Bandwidth efficient, scales |

### What Would Discord Actually Use?

"Based on public information, Discord uses:
- Elixir for Gateway servers (great for concurrent connections)
- Cassandra for messages (they've blogged about this)
- Custom voice servers (optimized for low latency)
- Google Cloud Platform for infrastructure"

---

## Step 14: Failure Scenarios

### Gateway Failure

"If a Gateway server dies:
1. All 100K connections drop
2. Clients auto-reconnect (to different Gateway)
3. Session state recreated from Redis
4. No messages lost (stored in Cassandra)

**Mitigation**: Graceful shutdown drains connections"

### Cassandra Node Failure

"With replication factor 3:
1. Two other replicas serve reads/writes
2. Hint handoff queues writes for failed node
3. When node returns, anti-entropy repair syncs

**Impact**: Slightly higher latency, no data loss"

### Redis Failure

"Redis Cluster mode:
1. Replica promoted to master
2. ~1-2 seconds of presence data loss possible
3. Subscriptions re-established by Gateways

**Mitigation**: Redis Sentinel for automatic failover"

---

## Summary

"To summarize my Discord design:

1. **Gateway Layer**: WebSocket servers handling 100K connections each, stateless, routing via Redis pub/sub
2. **Message Storage**: Cassandra with time-bucketed partitions for write scalability
3. **Real-Time Delivery**: Kafka for durability, Redis pub/sub for low-latency fanout
4. **Presence**: Redis with TTL-based heartbeats, lazy subscription model
5. **Voice**: SFU-based architecture for efficient media routing

The key insights are:
- WebSocket connection management is the biggest challenge at scale
- Cassandra's write performance and partition model fit chat perfectly
- Presence at scale requires smart subscription patterns, not global broadcast
- Voice and text are separate infrastructures with different requirements

What aspects would you like me to elaborate on?"
