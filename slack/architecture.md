# Design Slack - Architecture

## System Overview

Slack is a team communication platform with real-time messaging. Core challenges involve message delivery, workspace isolation, threading, and integrations.

**Learning Goals:**
- Build real-time messaging at scale
- Design threading/reply models
- Implement workspace isolation
- Create integration/bot platform

---

## Requirements

### Functional Requirements

1. **Workspace**: Isolated team environments
2. **Channels**: Organized conversations
3. **Messages**: Send, edit, delete, react
4. **Threads**: Reply to specific messages
5. **Search**: Find messages across workspace

### Non-Functional Requirements

- **Latency**: < 200ms message delivery
- **Availability**: 99.99% for messaging
- **Scale**: 10M workspaces, 1B messages/day
- **Ordering**: Messages appear in order

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│       Desktop App │ Web │ Mobile (React Native)                 │
└─────────────────────────────────────────────────────────────────┘
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway Cluster                              │
│         (WebSocket management, presence, routing)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Service                              │
│              - Send - Threads - Reactions                       │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  PostgreSQL   │    │   Valkey      │    │ Elasticsearch │
│  - Messages   │    │ - Connections │    │ - Search index│
│  - Channels   │    │ - Presence    │    │               │
│  - Workspaces │    │ - Pub/Sub     │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

---

## Core Components

### 1. Message Model

**Messages and Threads:**
```sql
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL,
  channel_id UUID REFERENCES channels(id),
  user_id UUID REFERENCES users(id),

  -- Threading support
  thread_ts BIGINT, -- NULL for top-level, parent ID for replies
  reply_count INTEGER DEFAULT 0,
  latest_reply TIMESTAMP,
  reply_users UUID[], -- Users who replied

  content TEXT NOT NULL,
  attachments JSONB,
  edited_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_ts) WHERE thread_ts IS NOT NULL;
```

**Thread Query:**
```javascript
async function getThread(messageTs) {
  // Get parent message
  const parent = await db('messages').where({ id: messageTs }).first()

  // Get all replies
  const replies = await db('messages')
    .where({ thread_ts: messageTs })
    .orderBy('created_at', 'asc')

  return { parent, replies }
}
```

### 2. Real-Time Delivery

**Fan-Out to Channel Members:**
```javascript
async function sendMessage(workspaceId, channelId, userId, content) {
  // 1. Store message
  const message = await db('messages').insert({
    workspace_id: workspaceId,
    channel_id: channelId,
    user_id: userId,
    content
  }).returning('*')

  // 2. Get channel members
  const members = await db('channel_members')
    .where({ channel_id: channelId })
    .pluck('user_id')

  // 3. Publish to each member's subscription
  for (const memberId of members) {
    await redis.publish(
      `user:${memberId}:messages`,
      JSON.stringify(message)
    )
  }

  // 4. Index for search (async)
  await searchQueue.add({ type: 'index_message', message })

  return message
}

// Gateway subscribes to user's channel
gateway.on('connection', async (ws, userId) => {
  const subscriber = redis.duplicate()
  await subscriber.subscribe(`user:${userId}:messages`)

  subscriber.on('message', (channel, data) => {
    ws.send(data)
  })
})
```

### 3. Presence System

**Tracking Online Status:**
```javascript
// Client sends heartbeat every 30 seconds
async function heartbeat(userId, workspaceId) {
  // Update presence with TTL
  await redis.setex(
    `presence:${workspaceId}:${userId}`,
    60, // Expires in 60s if no heartbeat
    JSON.stringify({ status: 'online', lastSeen: Date.now() })
  )

  // Broadcast presence change
  await broadcastPresence(workspaceId, userId, 'online')
}

// Check if user is online
async function isOnline(workspaceId, userId) {
  const presence = await redis.get(`presence:${workspaceId}:${userId}`)
  return presence !== null
}

// Get all online users in workspace
async function getOnlineUsers(workspaceId) {
  const keys = await redis.keys(`presence:${workspaceId}:*`)
  return keys.map(k => k.split(':')[2])
}
```

### 4. Search

**Message Indexing:**
```javascript
async function indexMessage(message) {
  await es.index({
    index: 'messages',
    id: message.id,
    body: {
      workspace_id: message.workspace_id,
      channel_id: message.channel_id,
      user_id: message.user_id,
      content: message.content,
      created_at: message.created_at
    }
  })
}

async function searchMessages(workspaceId, query, filters) {
  return await es.search({
    index: 'messages',
    body: {
      query: {
        bool: {
          must: [
            { term: { workspace_id: workspaceId } },
            { match: { content: query } }
          ],
          filter: [
            filters.channelId && { term: { channel_id: filters.channelId } },
            filters.userId && { term: { user_id: filters.userId } },
            filters.dateRange && {
              range: { created_at: { gte: filters.from, lte: filters.to } }
            }
          ].filter(Boolean)
        }
      },
      highlight: {
        fields: { content: {} }
      }
    }
  })
}
```

### 5. Integrations

**Incoming Webhooks:**
```javascript
// Generate webhook URL for channel
async function createWebhook(workspaceId, channelId) {
  const token = crypto.randomBytes(32).toString('hex')

  await db('webhooks').insert({
    workspace_id: workspaceId,
    channel_id: channelId,
    token,
    created_at: new Date()
  })

  return `https://hooks.slack.com/services/${workspaceId}/${channelId}/${token}`
}

// Handle incoming webhook
app.post('/services/:workspace/:channel/:token', async (req, res) => {
  const webhook = await db('webhooks')
    .where({
      workspace_id: req.params.workspace,
      channel_id: req.params.channel,
      token: req.params.token
    })
    .first()

  if (!webhook) {
    return res.status(404).send('Webhook not found')
  }

  await sendMessage(
    webhook.workspace_id,
    webhook.channel_id,
    SYSTEM_USER_ID,
    req.body.text
  )

  res.status(200).send('ok')
})
```

---

## Database Schema

```sql
-- Workspaces
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  domain VARCHAR(100) UNIQUE,
  settings JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Channels
CREATE TABLE channels (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  name VARCHAR(100) NOT NULL,
  topic TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(workspace_id, name)
);

-- Channel membership
CREATE TABLE channel_members (
  channel_id UUID REFERENCES channels(id),
  user_id UUID REFERENCES users(id),
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- Messages
CREATE TABLE messages (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  channel_id UUID REFERENCES channels(id),
  user_id UUID REFERENCES users(id),
  thread_ts BIGINT REFERENCES messages(id),
  content TEXT NOT NULL,
  attachments JSONB,
  reply_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  edited_at TIMESTAMP
);

-- Reactions
CREATE TABLE reactions (
  message_id BIGINT REFERENCES messages(id),
  user_id UUID REFERENCES users(id),
  emoji VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);
```

---

## Key Design Decisions

### 1. Thread as Attribute

**Decision**: Threads are replies referencing parent message ID

**Rationale**:
- Simple query for thread
- Parent message contains reply metadata
- Compatible with existing message table

### 2. Valkey Pub/Sub for Delivery

**Decision**: Publish messages to user-specific channels

**Rationale**:
- Decouples message store from delivery
- Scales to millions of connections
- Gateway clusters subscribe independently

### 3. Workspace Isolation

**Decision**: All tables have workspace_id foreign key

**Rationale**:
- Clear data separation
- Efficient queries within workspace
- Supports sharding by workspace

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Threading | Parent reference | Separate table | Simplicity |
| Delivery | Valkey pub/sub | Direct push | Scale |
| Presence | Valkey with TTL | Database | Speed |
| Search | Elasticsearch | PostgreSQL FTS | Scale, features |
