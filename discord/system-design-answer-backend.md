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

```typescript
interface GatewaySession {
  userId: string;
  socket: WebSocket;
  subscribedChannels: Set<string>;
  currentGuildId: string | null;
  lastHeartbeat: Date;
}

class GatewayServer {
  private sessions: Map<string, GatewaySession> = new Map();
  private channelSubscribers: Map<string, Set<string>> = new Map();
  private redis: Redis;
  private kafka: Kafka;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.kafka = new Kafka({ brokers: [process.env.KAFKA_BROKER] });
  }

  async handleConnection(socket: WebSocket, userId: string): Promise<void> {
    const sessionId = generateSessionId();
    const session: GatewaySession = {
      userId,
      socket,
      subscribedChannels: new Set(),
      currentGuildId: null,
      lastHeartbeat: new Date(),
    };

    this.sessions.set(sessionId, session);

    // Register in Redis for cross-gateway routing
    await this.redis.sadd(`user:${userId}:sessions`, `${this.gatewayId}:${sessionId}`);
    await this.redis.setex(`session:${sessionId}`, 3600, JSON.stringify({
      gatewayId: this.gatewayId,
      userId,
    }));

    // Set up message handlers
    socket.on('message', (data) => this.handleMessage(sessionId, data));
    socket.on('close', () => this.handleDisconnect(sessionId));
    socket.on('pong', () => this.updateHeartbeat(sessionId));

    // Start heartbeat monitoring
    this.startHeartbeatMonitor(sessionId);
  }

  async handleMessage(sessionId: string, data: Buffer): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const payload = JSON.parse(data.toString());

    switch (payload.type) {
      case 'SEND_MESSAGE':
        await this.handleSendMessage(session, payload);
        break;
      case 'SUBSCRIBE_CHANNEL':
        await this.handleSubscribe(sessionId, payload.channelId);
        break;
      case 'UNSUBSCRIBE_CHANNEL':
        await this.handleUnsubscribe(sessionId, payload.channelId);
        break;
      case 'HEARTBEAT':
        this.updateHeartbeat(sessionId);
        break;
    }
  }

  private async handleSendMessage(
    session: GatewaySession,
    payload: { channelId: string; content: string }
  ): Promise<void> {
    // Validate permissions
    const canSend = await this.checkPermissions(session.userId, payload.channelId);
    if (!canSend) {
      session.socket.send(JSON.stringify({ type: 'ERROR', message: 'Permission denied' }));
      return;
    }

    // Rate limiting
    const isRateLimited = await this.checkRateLimit(session.userId, 'message');
    if (isRateLimited) {
      session.socket.send(JSON.stringify({ type: 'ERROR', message: 'Rate limited' }));
      return;
    }

    // Publish to Kafka for processing
    await this.kafka.producer.send({
      topic: 'messages',
      messages: [{
        key: payload.channelId,
        value: JSON.stringify({
          messageId: generateTimeUUID(),
          channelId: payload.channelId,
          authorId: session.userId,
          content: payload.content,
          timestamp: Date.now(),
        }),
      }],
    });
  }

  private startHeartbeatMonitor(sessionId: string): void {
    const interval = setInterval(async () => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        clearInterval(interval);
        return;
      }

      const timeSinceHeartbeat = Date.now() - session.lastHeartbeat.getTime();
      if (timeSinceHeartbeat > 60000) {
        // Connection is dead
        await this.handleDisconnect(sessionId);
        clearInterval(interval);
      } else {
        // Send ping
        session.socket.ping();
      }
    }, 30000);
  }
}
```

### Cross-Gateway Message Routing

When a user on Gateway 1 sends a message, users on Gateway 5 need to receive it:

```typescript
class MessageRouter {
  private redis: Redis;
  private pubsub: Redis;
  private channelSubscriptions: Map<string, Set<string>> = new Map();

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.pubsub = new Redis(process.env.REDIS_URL);

    // Subscribe to all channels this gateway has users for
    this.pubsub.on('message', (channel, data) => {
      this.handlePubSubMessage(channel, data);
    });
  }

  async subscribeToChannel(channelId: string, sessionId: string): Promise<void> {
    if (!this.channelSubscriptions.has(channelId)) {
      this.channelSubscriptions.set(channelId, new Set());
      await this.pubsub.subscribe(`channel:${channelId}`);
    }
    this.channelSubscriptions.get(channelId)!.add(sessionId);
  }

  async publishMessage(channelId: string, message: Message): Promise<void> {
    // Publish to Redis for all gateways
    await this.redis.publish(`channel:${channelId}`, JSON.stringify(message));
  }

  private handlePubSubMessage(channel: string, data: string): void {
    const channelId = channel.replace('channel:', '');
    const subscribers = this.channelSubscriptions.get(channelId);

    if (!subscribers) return;

    const message = JSON.parse(data);

    // Fan out to all local subscribers
    for (const sessionId of subscribers) {
      const session = this.sessions.get(sessionId);
      if (session?.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({
          type: 'MESSAGE',
          ...message,
        }));
      }
    }
  }
}
```

---

## Step 5: Message Storage with Cassandra

### Schema Design

Cassandra is ideal for message storage due to its write-heavy optimization and time-series nature of chat data.

```cql
-- Messages partitioned by channel, clustered by time (descending)
CREATE TABLE messages (
    channel_id UUID,
    bucket TEXT,  -- Daily bucket for partition management: '2024-01-15'
    message_id TIMEUUID,
    author_id UUID,
    content TEXT,
    attachments LIST<FROZEN<attachment>>,
    edited_at TIMESTAMP,
    deleted BOOLEAN,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_size': '1',
                    'compaction_window_unit': 'DAYS'};

CREATE TYPE attachment (
    url TEXT,
    filename TEXT,
    content_type TEXT,
    size INT
);

-- Reactions stored separately for efficient updates
CREATE TABLE message_reactions (
    channel_id UUID,
    message_id TIMEUUID,
    emoji TEXT,
    user_ids SET<UUID>,
    PRIMARY KEY ((channel_id, message_id), emoji)
);

-- User DM channels for quick lookup
CREATE TABLE user_dm_channels (
    user_id UUID,
    other_user_id UUID,
    channel_id UUID,
    last_message_at TIMESTAMP,
    PRIMARY KEY (user_id, last_message_at)
) WITH CLUSTERING ORDER BY (last_message_at DESC);
```

### Chat Service Implementation

```typescript
class ChatService {
  private cassandra: CassandraClient;
  private kafka: KafkaConsumer;
  private redis: Redis;

  constructor() {
    this.cassandra = new CassandraClient({
      contactPoints: process.env.CASSANDRA_HOSTS.split(','),
      localDataCenter: process.env.CASSANDRA_DC,
      keyspace: 'discord',
    });

    this.kafka = new KafkaConsumer({
      topics: ['messages'],
      groupId: 'chat-service',
    });

    this.kafka.on('message', (message) => this.processMessage(message));
  }

  private async processMessage(kafkaMessage: KafkaMessage): Promise<void> {
    const message = JSON.parse(kafkaMessage.value.toString());
    const bucket = this.getBucket(message.timestamp);

    // Write to Cassandra
    await this.cassandra.execute(
      `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, deleted)
       VALUES (?, ?, ?, ?, ?, false)`,
      [message.channelId, bucket, message.messageId, message.authorId, message.content],
      { prepare: true }
    );

    // Publish to Redis for real-time delivery
    await this.redis.publish(`channel:${message.channelId}`, JSON.stringify(message));

    // Update channel's last message timestamp (for sorting in UI)
    await this.redis.zadd(
      `guild:${message.guildId}:channels`,
      message.timestamp,
      message.channelId
    );
  }

  private getBucket(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0]; // '2024-01-15'
  }

  async getMessages(
    channelId: string,
    before?: string,
    limit: number = 50
  ): Promise<Message[]> {
    const buckets = this.getRecentBuckets(7); // Last 7 days
    const messages: Message[] = [];

    for (const bucket of buckets) {
      if (messages.length >= limit) break;

      let query = `SELECT * FROM messages
                   WHERE channel_id = ? AND bucket = ?`;
      const params: any[] = [channelId, bucket];

      if (before) {
        query += ` AND message_id < ?`;
        params.push(before);
      }

      query += ` LIMIT ?`;
      params.push(limit - messages.length);

      const result = await this.cassandra.execute(query, params, { prepare: true });
      messages.push(...result.rows);
    }

    return messages;
  }

  async deleteMessage(channelId: string, messageId: string, userId: string): Promise<boolean> {
    // Verify ownership
    const bucket = this.getBucketFromMessageId(messageId);
    const result = await this.cassandra.execute(
      `SELECT author_id FROM messages WHERE channel_id = ? AND bucket = ? AND message_id = ?`,
      [channelId, bucket, messageId],
      { prepare: true }
    );

    if (result.rows.length === 0 || result.rows[0].author_id !== userId) {
      return false;
    }

    // Soft delete for audit trail
    await this.cassandra.execute(
      `UPDATE messages SET deleted = true WHERE channel_id = ? AND bucket = ? AND message_id = ?`,
      [channelId, bucket, messageId],
      { prepare: true }
    );

    // Notify clients
    await this.redis.publish(`channel:${channelId}`, JSON.stringify({
      type: 'MESSAGE_DELETE',
      messageId,
    }));

    return true;
  }

  private getRecentBuckets(days: number): string[] {
    const buckets: string[] = [];
    const now = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      buckets.push(date.toISOString().split('T')[0]);
    }

    return buckets;
  }
}
```

---

## Step 6: Presence System

### Presence Data Model

Redis is perfect for presence due to its TTL-based expiration and pub/sub capabilities.

```typescript
class PresenceService {
  private redis: Redis;
  private pubsub: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.pubsub = new Redis(process.env.REDIS_URL);
  }

  async setPresence(userId: string, status: 'online' | 'idle' | 'dnd' | 'offline'): Promise<void> {
    const key = `presence:${userId}`;

    // Set with expiry for auto-offline
    await this.redis.setex(key, 60, status);

    // Store custom status if any
    const customStatus = await this.redis.hget(`user:${userId}:status`, 'text');

    // Publish presence update
    await this.publishPresenceUpdate(userId, status, customStatus);
  }

  async heartbeat(userId: string, sessionId: string): Promise<void> {
    // Refresh TTL
    await this.redis.expire(`presence:${userId}`, 60);

    // Track active sessions
    await this.redis.sadd(`user:${userId}:sessions`, sessionId);
    await this.redis.expire(`user:${userId}:sessions`, 60);
  }

  async getPresence(userId: string): Promise<string> {
    const status = await this.redis.get(`presence:${userId}`);
    return status || 'offline';
  }

  async getBulkPresence(userIds: string[]): Promise<Map<string, string>> {
    const pipeline = this.redis.pipeline();

    for (const userId of userIds) {
      pipeline.get(`presence:${userId}`);
    }

    const results = await pipeline.exec();
    const presenceMap = new Map<string, string>();

    userIds.forEach((userId, index) => {
      presenceMap.set(userId, results[index][1] || 'offline');
    });

    return presenceMap;
  }

  private async publishPresenceUpdate(
    userId: string,
    status: string,
    customStatus?: string
  ): Promise<void> {
    // Get user's guilds and friends for targeted updates
    const guilds = await this.redis.smembers(`user:${userId}:guilds`);

    const update = {
      userId,
      status,
      customStatus,
      timestamp: Date.now(),
    };

    // Publish to each guild's presence channel
    for (const guildId of guilds) {
      await this.redis.publish(`presence:guild:${guildId}`, JSON.stringify(update));
    }
  }
}
```

### Lazy Presence Subscription

To avoid the N*M fanout problem (N users with M friends), we use lazy subscriptions:

```typescript
class PresenceSubscriptionManager {
  private redis: Redis;
  private subscriptions: Map<string, Set<string>> = new Map(); // channelId -> sessionIds

  async subscribeToChannelPresence(sessionId: string, channelId: string): Promise<void> {
    // Get channel members
    const members = await this.redis.smembers(`channel:${channelId}:members`);

    // Get their current presence
    const presenceMap = await this.presenceService.getBulkPresence(members);

    // Send initial presence state to client
    const session = this.sessions.get(sessionId);
    session?.socket.send(JSON.stringify({
      type: 'PRESENCE_UPDATE_BATCH',
      presences: Object.fromEntries(presenceMap),
    }));

    // Subscribe to presence updates for this channel
    if (!this.subscriptions.has(channelId)) {
      this.subscriptions.set(channelId, new Set());
      await this.pubsub.subscribe(`presence:channel:${channelId}`);
    }
    this.subscriptions.get(channelId)!.add(sessionId);
  }

  async unsubscribeFromChannelPresence(sessionId: string, channelId: string): Promise<void> {
    const subs = this.subscriptions.get(channelId);
    if (subs) {
      subs.delete(sessionId);
      if (subs.size === 0) {
        await this.pubsub.unsubscribe(`presence:channel:${channelId}`);
        this.subscriptions.delete(channelId);
      }
    }
  }
}
```

---

## Step 7: Message Ordering and Delivery Guarantees

### Kafka for Ordered Processing

```typescript
class MessageProcessor {
  private kafka: Kafka;
  private consumer: Consumer;

  constructor() {
    this.kafka = new Kafka({
      clientId: 'chat-service',
      brokers: process.env.KAFKA_BROKERS.split(','),
    });

    this.consumer = this.kafka.consumer({ groupId: 'chat-service' });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'messages', fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        // Messages with same channel_id go to same partition
        // This ensures ordering per channel
        await this.processMessage(message);
      },
    });
  }

  private async processMessage(message: KafkaMessage): Promise<void> {
    const data = JSON.parse(message.value!.toString());

    try {
      // Write to Cassandra
      await this.chatService.persistMessage(data);

      // Publish to Redis for real-time delivery
      await this.redis.publish(`channel:${data.channelId}`, JSON.stringify(data));

    } catch (error) {
      // Send to dead letter queue for manual review
      await this.producer.send({
        topic: 'messages-dlq',
        messages: [{ value: message.value }],
      });
    }
  }
}
```

### Message ID with TIMEUUID

```typescript
function generateTimeUUID(): string {
  // TIMEUUID format: timestamp + random
  // Provides:
  // 1. Natural time ordering
  // 2. Uniqueness even at same millisecond
  // 3. Extractable timestamp
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  return `${timestamp.toString(16).padStart(12, '0')}-${random}`;
}

function extractTimestamp(messageId: string): number {
  const [timestampHex] = messageId.split('-');
  return parseInt(timestampHex, 16);
}
```

---

## Step 8: Rate Limiting

```typescript
class RateLimiter {
  private redis: Redis;

  private limits: Record<string, { count: number; windowSeconds: number }> = {
    message: { count: 5, windowSeconds: 5 },
    reaction: { count: 10, windowSeconds: 1 },
    channel_create: { count: 10, windowSeconds: 60 },
    dm_create: { count: 10, windowSeconds: 60 },
  };

  async checkLimit(userId: string, action: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const limit = this.limits[action];
    if (!limit) return { allowed: true };

    const key = `ratelimit:${action}:${userId}`;

    const multi = this.redis.multi();
    multi.incr(key);
    multi.ttl(key);
    const [[, count], [, ttl]] = await multi.exec();

    if (ttl === -1) {
      await this.redis.expire(key, limit.windowSeconds);
    }

    if (count > limit.count) {
      return {
        allowed: false,
        retryAfter: ttl > 0 ? ttl : limit.windowSeconds
      };
    }

    return { allowed: true };
  }

  async resetLimit(userId: string, action: string): Promise<void> {
    const key = `ratelimit:${action}:${userId}`;
    await this.redis.del(key);
  }
}
```

---

## Step 9: Search with Elasticsearch

### Elasticsearch Index

```typescript
class SearchService {
  private elasticsearch: Client;
  private kafka: KafkaConsumer;

  constructor() {
    this.elasticsearch = new Client({
      node: process.env.ELASTICSEARCH_URL,
    });

    // Consume messages from Kafka for indexing
    this.kafka = new KafkaConsumer({
      topics: ['messages'],
      groupId: 'search-indexer',
    });

    this.kafka.on('message', (message) => this.indexMessage(message));
  }

  private async indexMessage(kafkaMessage: KafkaMessage): Promise<void> {
    const message = JSON.parse(kafkaMessage.value.toString());

    await this.elasticsearch.index({
      index: 'messages',
      id: message.messageId,
      body: {
        channel_id: message.channelId,
        guild_id: message.guildId,
        author_id: message.authorId,
        content: message.content,
        timestamp: message.timestamp,
        has_attachment: message.attachments?.length > 0,
      },
    });
  }

  async search(
    guildId: string,
    query: string,
    filters?: { channelId?: string; authorId?: string; fromDate?: Date }
  ): Promise<SearchResult[]> {
    const must: any[] = [
      { match: { guild_id: guildId } },
      { match: { content: query } },
    ];

    if (filters?.channelId) {
      must.push({ match: { channel_id: filters.channelId } });
    }
    if (filters?.authorId) {
      must.push({ match: { author_id: filters.authorId } });
    }
    if (filters?.fromDate) {
      must.push({ range: { timestamp: { gte: filters.fromDate.getTime() } } });
    }

    const result = await this.elasticsearch.search({
      index: 'messages',
      body: {
        query: { bool: { must } },
        highlight: { fields: { content: {} } },
        sort: [{ timestamp: 'desc' }],
        size: 25,
      },
    });

    return result.hits.hits.map((hit) => ({
      messageId: hit._id,
      content: hit._source.content,
      highlight: hit.highlight?.content?.[0],
      channelId: hit._source.channel_id,
      authorId: hit._source.author_id,
      timestamp: hit._source.timestamp,
    }));
  }
}
```

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

```typescript
class GatewayHealthMonitor {
  async checkHealth(): Promise<HealthStatus> {
    const checks = await Promise.all([
      this.checkRedisConnection(),
      this.checkKafkaConnection(),
      this.checkConnectionCount(),
    ]);

    return {
      status: checks.every(c => c.healthy) ? 'healthy' : 'unhealthy',
      connections: this.sessions.size,
      redis: checks[0],
      kafka: checks[1],
    };
  }

  async gracefulShutdown(): Promise<void> {
    // Stop accepting new connections
    this.server.close();

    // Notify clients to reconnect elsewhere
    for (const session of this.sessions.values()) {
      session.socket.send(JSON.stringify({
        type: 'RECONNECT',
        reason: 'Gateway shutting down',
      }));
    }

    // Wait for clients to disconnect
    await this.waitForDrain(30000);

    // Cleanup Redis subscriptions
    await this.cleanupSubscriptions();
  }
}
```

### Circuit Breaker for External Services

```typescript
import CircuitBreaker from 'opossum';

class ResilientChatService {
  private cassandraBreaker: CircuitBreaker;
  private redisBreaker: CircuitBreaker;

  constructor() {
    this.cassandraBreaker = new CircuitBreaker(
      (query, params) => this.cassandra.execute(query, params),
      {
        timeout: 5000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    );

    this.cassandraBreaker.on('open', () => {
      logger.error('Cassandra circuit breaker opened');
      metrics.circuitBreakerOpen.inc({ service: 'cassandra' });
    });
  }

  async persistMessage(message: Message): Promise<void> {
    try {
      await this.cassandraBreaker.fire(
        `INSERT INTO messages (...) VALUES (...)`,
        [message.channelId, message.bucket, message.messageId, message.content]
      );
    } catch (error) {
      if (error.name === 'CircuitBreakerOpenError') {
        // Queue message for retry
        await this.retryQueue.push(message);
      }
      throw error;
    }
  }
}
```

---

## Step 12: Monitoring and Observability

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

const registry = new Registry();

const messagesSent = new Counter({
  name: 'discord_messages_sent_total',
  help: 'Total messages sent',
  labelNames: ['guild_id'],
  registers: [registry],
});

const messageLatency = new Histogram({
  name: 'discord_message_latency_seconds',
  help: 'Message delivery latency',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

const activeConnections = new Gauge({
  name: 'discord_active_connections',
  help: 'Number of active WebSocket connections',
  labelNames: ['gateway_id'],
  registers: [registry],
});

const cassandraQueryLatency = new Histogram({
  name: 'discord_cassandra_query_seconds',
  help: 'Cassandra query latency',
  labelNames: ['query_type'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await healthMonitor.checkHealth();
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});
```

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
