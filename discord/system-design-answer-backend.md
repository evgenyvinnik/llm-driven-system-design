# Discord (Real-Time Chat System) - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## Introduction

"Today I'll design a real-time chat system similar to Discord. As a backend engineer, I'll focus on the WebSocket gateway architecture, message storage with Cassandra, pub/sub message routing, presence system, and horizontal scaling strategies. The core challenge is enabling millions of users to send and receive messages instantly while maintaining message ordering and handling concurrent connections."

---

## Step 1: Requirements Clarification

### Functional Requirements

1. **Servers & Channels**: Users create servers, servers contain text/voice channels
2. **Real-Time Messaging**: Messages appear instantly for all channel members
3. **Message History**: Scrollable history with persistent storage
4. **Presence**: Show who's online/offline/idle
5. **Direct Messages**: Private 1-on-1 and group DMs

### Non-Functional Requirements

- **Scale**: 100 million users, 10 million concurrent connections
- **Latency**: Messages delivered in <100ms
- **Availability**: 99.99% uptime
- **Ordering**: Messages in a channel must appear in order
- **Persistence**: Messages stored indefinitely

---

## Step 2: Scale Estimation

```
Concurrent Users:
- 10 million WebSocket connections
- Each connection: ~10KB memory
- Total: ~100 GB RAM for connections (distributed across 100+ gateways)

Message Volume:
- 100 million messages per day
- Peak: 10x average = ~12,000 messages/second
- Each message: ~200 bytes (text) + metadata

Storage:
- 100M messages * 365 days * 1KB = ~36 TB/year
- Need horizontal sharding
```

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

### Gateway Server Design

Each Gateway server handles 100,000 concurrent WebSocket connections. The key is efficient connection management and message fanout.

**Gateway Session Structure:**

| Field | Type | Purpose |
|-------|------|---------|
| userId | string | User identifier |
| socket | WebSocket | Connection handle |
| subscribedChannels | Set<string> | Channels user is monitoring |
| currentGuildId | string or null | Active server |
| lastHeartbeat | Date | Connection liveness |

**Gateway Responsibilities:**
1. Accept WebSocket connections and authenticate users
2. Register sessions in Redis for cross-gateway routing
3. Handle message types: SEND_MESSAGE, SUBSCRIBE_CHANNEL, UNSUBSCRIBE_CHANNEL, HEARTBEAT
4. Validate permissions and rate limits before publishing to Kafka
5. Monitor heartbeats and disconnect dead connections (60s timeout)

**Message Flow (Send):**
```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Client  │───▶│ Gateway  │───▶│  Kafka   │───▶│  Chat    │
│          │    │  Server  │    │ (Topic:  │    │ Service  │
│          │    │          │    │ messages)│    │          │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                                               │
     │              ┌────────────────────────────────┘
     │              ▼
     │         ┌──────────┐    ┌──────────┐
     │         │Cassandra │    │  Redis   │
     │         │ (persist)│    │ (pub/sub)│
     │         └──────────┘    └──────────┘
     │                              │
     └──────────────────────────────┘
           (receive via pub/sub)
```

### Cross-Gateway Message Routing

When a user on Gateway 1 sends a message, users on Gateway 5 need to receive it:

**Redis Pub/Sub Pattern:**
1. Each gateway subscribes to Redis channels for rooms it has users in
2. When message is persisted, Chat Service publishes to Redis channel
3. All gateways with subscribers receive and fan out to local clients

**Channel Subscription Management:**
- Track channelId -> Set of sessionIds locally
- Subscribe to Redis pub/sub when first user joins channel
- Unsubscribe when last user leaves channel
- Fan out received messages to all local subscribers

---

## Step 5: Message Storage with Cassandra

### Schema Design

Cassandra is ideal for message storage due to its write-heavy optimization and time-series nature of chat data.

**Messages Table:**

| Column | Type | Purpose |
|--------|------|---------|
| channel_id | UUID | Partition key (with bucket) |
| bucket | TEXT | Daily bucket: '2024-01-15' |
| message_id | TIMEUUID | Clustering key (DESC) |
| author_id | UUID | Message author |
| content | TEXT | Message body |
| attachments | LIST | File attachments |
| edited_at | TIMESTAMP | Edit timestamp |
| deleted | BOOLEAN | Soft delete flag |

**Primary Key:** ((channel_id, bucket), message_id)
- Partition by channel + day for bounded partition sizes
- Cluster by message_id DESC for chronological reads

**Compaction Strategy:** TimeWindowCompactionStrategy
- Window: 1 day
- Optimized for time-series append workloads

**Supporting Tables:**

| Table | Partition Key | Purpose |
|-------|---------------|---------|
| message_reactions | (channel_id, message_id) | Emoji reactions per message |
| user_dm_channels | user_id | Quick lookup of DM conversations |

### Chat Service Implementation

**Message Processing Pipeline:**
1. Consume from Kafka "messages" topic
2. Calculate bucket from timestamp (YYYY-MM-DD format)
3. Write to Cassandra with prepared statement
4. Publish to Redis for real-time delivery
5. Update channel's last_message timestamp in Redis sorted set

**Get Messages Query Pattern:**
- Iterate through recent buckets (last 7 days)
- Query each bucket until limit reached
- Support cursor-based pagination with "before" message_id

**Delete Message Flow:**
1. Verify ownership (query author_id)
2. Soft delete (set deleted = true)
3. Publish MESSAGE_DELETE event via Redis

---

## Step 6: Presence System

### Presence Data Model

Redis is perfect for presence due to its TTL-based expiration and pub/sub capabilities.

**Redis Key Patterns:**

| Key Pattern | TTL | Value | Purpose |
|-------------|-----|-------|---------|
| presence:{userId} | 60s | status string | Current presence |
| user:{userId}:sessions | 60s | Set of sessionIds | Active sessions |
| user:{userId}:status | - | Hash with text | Custom status |
| user:{userId}:guilds | - | Set of guildIds | User's servers |

**Presence States:** online, idle, dnd (do not disturb), offline

**Heartbeat Flow:**
1. Client sends heartbeat every 30s
2. Gateway refreshes presence TTL to 60s
3. Gateway refreshes session set TTL
4. If heartbeat missed for 60s, key expires = offline

**Publishing Presence Updates:**
1. Get user's guilds from Redis set
2. Publish to each guild's presence channel
3. Only subscribers (users viewing that guild) receive updates

### Lazy Presence Subscription

To avoid the N*M fanout problem (N users with M friends), we use lazy subscriptions:

**Lazy Subscription Pattern:**
```
┌─────────────────────────────────────────────────────────────┐
│  User opens channel                                          │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────┐                                        │
│  │ Get channel     │                                        │
│  │ members list    │                                        │
│  └────────┬────────┘                                        │
│           ▼                                                  │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │ Bulk get        │───▶│ Send initial    │                 │
│  │ presence state  │    │ PRESENCE_BATCH  │                 │
│  └────────┬────────┘    └─────────────────┘                 │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ Subscribe to    │                                        │
│  │ channel presence│                                        │
│  └─────────────────┘                                        │
│                                                              │
│  User leaves channel                                         │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────────┐                                        │
│  │ Unsubscribe     │                                        │
│  │ if last user    │                                        │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

**Benefits:**
- Only fetch presence for visible users
- Only subscribe to updates for active channels
- Unsubscribe on navigation away

---

## Step 7: Message Ordering and Delivery Guarantees

### Kafka for Ordered Processing

**Kafka Configuration:**
- Topic: "messages"
- Partition key: channel_id
- Result: All messages for a channel go to same partition = ordered

**Consumer Group:** chat-service
- Single consumer per partition
- Guarantees in-order processing per channel

**Error Handling:**
- On failure: Send to "messages-dlq" (dead letter queue)
- Manual review and replay for failed messages

### Message ID with TIMEUUID

**TIMEUUID Properties:**
1. Natural time ordering
2. Uniqueness even at same millisecond (random component)
3. Extractable timestamp

**Format:** {timestamp_hex}-{random_hex}
- Timestamp: 12 hex chars (milliseconds since epoch)
- Random: 16 hex chars (collision avoidance)

---

## Step 8: Rate Limiting

**Rate Limits by Action:**

| Action | Limit | Window | Purpose |
|--------|-------|--------|---------|
| message | 5 | 5 seconds | Prevent spam |
| reaction | 10 | 1 second | Prevent reaction spam |
| channel_create | 10 | 60 seconds | Prevent channel flooding |
| dm_create | 10 | 60 seconds | Prevent DM spam |

**Implementation (Redis Sliding Window):**
1. Increment key: ratelimit:{action}:{userId}
2. Set TTL on first increment
3. Check count against limit
4. Return retryAfter if exceeded

---

## Step 9: Search with Elasticsearch

### Elasticsearch Index

**Index Mapping (messages):**

| Field | Type | Purpose |
|-------|------|---------|
| channel_id | keyword | Filter by channel |
| guild_id | keyword | Scope to server |
| author_id | keyword | Filter by author |
| content | text | Full-text search |
| timestamp | date | Sort and filter |
| has_attachment | boolean | Filter attachments |

**Indexing Pipeline:**
1. Consume from Kafka "messages" topic (separate consumer group: search-indexer)
2. Index document to Elasticsearch
3. Async - doesn't block message delivery

**Search Query Building:**
- Must match: guild_id (security)
- Should match: content (relevance)
- Optional filters: channel_id, author_id, fromDate
- Highlight: content field
- Sort: timestamp DESC
- Size: 25 results

---

## Step 10: Horizontal Scaling

### Multi-Region Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   US Region     │    │   EU Region     │    │  APAC Region    │
│                 │    │                 │    │                 │
│  Gateways       │◄──►│  Gateways       │◄──►│  Gateways       │
│  Cassandra      │    │  Cassandra      │    │  Cassandra      │
│  Redis Cluster  │    │  Redis Cluster  │    │  Redis Cluster  │
│  Kafka          │    │  Kafka          │    │  Kafka          │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                    Cross-Region Sync (Cassandra Multi-DC)
```

### Scaling Components

| Component | Scaling Strategy |
|-----------|------------------|
| Gateway | Add servers (100K connections each), DNS-based routing |
| Kafka | Add partitions (partition by channel_id for ordering) |
| Chat Service | Stateless, horizontal pod autoscaling |
| Cassandra | Add nodes, automatic rebalancing, multi-DC replication |
| Redis | Redis Cluster for presence/pub-sub sharding |
| Elasticsearch | Add shards for search |

---

## Step 11: Failure Handling

### Gateway Failure

**Health Check Components:**
1. Redis connection status
2. Kafka connection status
3. Active connection count

**Graceful Shutdown Sequence:**
1. Stop accepting new connections
2. Send RECONNECT event to all clients (reason: "Gateway shutting down")
3. Wait for clients to disconnect (30s drain period)
4. Cleanup Redis subscriptions
5. Exit

### Circuit Breaker for External Services

**Circuit Breaker Configuration:**

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Cassandra | 5000ms | 50% | 30s |
| Redis | 1000ms | 50% | 10s |

**States:**
- CLOSED: Normal operation
- OPEN: Fast-fail all requests
- HALF-OPEN: Allow test requests

**Fallback on Cassandra Open:**
- Queue message for retry
- Return error to client with retry hint

---

## Step 12: Monitoring and Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| discord_messages_sent_total | Counter | guild_id | Message volume |
| discord_message_latency_seconds | Histogram | - | Delivery latency |
| discord_active_connections | Gauge | gateway_id | Connection count |
| discord_cassandra_query_seconds | Histogram | query_type | DB performance |

**Histogram Buckets (latency):** [0.01, 0.05, 0.1, 0.25, 0.5, 1] seconds

**Endpoints:**
- /health: Health check (200 = healthy, 503 = unhealthy)
- /metrics: Prometheus scrape endpoint

---

## Summary

"To summarize my Discord backend design:

1. **Gateway Layer**: WebSocket servers handling 100K connections each, routing via Redis pub/sub
2. **Message Storage**: Cassandra with time-bucketed partitions for write scalability and efficient reads
3. **Message Ordering**: Kafka with channel-based partitioning ensures messages are processed in order
4. **Presence System**: Redis with TTL-based heartbeats, lazy subscription model to avoid N*M fanout
5. **Search**: Elasticsearch for full-text search with async indexing from Kafka

The key backend insights are:
- WebSocket connection management is the biggest scaling challenge
- Cassandra's write performance and partition model fit chat's access patterns perfectly
- Pub/sub is essential for cross-gateway message routing
- Presence at scale requires smart subscription patterns, not global broadcast
- Circuit breakers and graceful degradation are essential for reliability

What aspects would you like me to elaborate on?"
