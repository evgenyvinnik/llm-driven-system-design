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

---

## Consistency and Idempotency

### Write Consistency Model

**Messages**: Strong consistency within a channel using PostgreSQL transactions.

```javascript
// Message creation with idempotency key
async function sendMessage(workspaceId, channelId, userId, content, idempotencyKey) {
  // Check for duplicate request (client retry protection)
  const existing = await redis.get(`idem:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing) // Return cached response
  }

  const message = await db.transaction(async (trx) => {
    // Insert message with server-assigned ordering
    const [msg] = await trx('messages').insert({
      workspace_id: workspaceId,
      channel_id: channelId,
      user_id: userId,
      content,
      created_at: new Date()
    }).returning('*')

    // If this is a thread reply, update parent atomically
    if (msg.thread_ts) {
      await trx('messages')
        .where({ id: msg.thread_ts })
        .increment('reply_count', 1)
        .update({
          latest_reply: msg.created_at,
          reply_users: trx.raw(
            "array_append(array_remove(reply_users, ?), ?)",
            [userId, userId]
          )
        })
    }

    return msg
  })

  // Cache idempotency key for 24 hours
  await redis.setex(`idem:${idempotencyKey}`, 86400, JSON.stringify(message))

  return message
}
```

### Consistency Semantics by Operation

| Operation | Consistency | Idempotency | Conflict Resolution |
|-----------|-------------|-------------|---------------------|
| Send message | Strong (PostgreSQL) | Client idempotency key | Server-assigned timestamp wins |
| Edit message | Strong | Last-write-wins | `edited_at` timestamp comparison |
| Delete message | Strong | Idempotent (no error on re-delete) | Soft delete with `deleted_at` |
| Add reaction | Strong | Natural (upsert on PK) | No conflict possible |
| Remove reaction | Strong | Idempotent | No-op if not exists |
| Join channel | Strong | Natural (PK constraint) | No conflict possible |

### Message Ordering

**Server-assigned timestamps** ensure ordering consistency:

```javascript
// Messages ordered by database-assigned created_at
async function getChannelMessages(channelId, cursor, limit = 50) {
  return db('messages')
    .where({ channel_id: channelId })
    .where('created_at', '<', cursor || new Date())
    .orderBy('created_at', 'desc')
    .limit(limit)
}
```

**Eventual consistency for derived data:**
- Search index: Async indexing with 1-5 second lag acceptable
- Reply count: Atomic increment in same transaction
- Presence: Eventually consistent across gateway nodes (60s TTL)

### Replay Handling

```javascript
// Client reconnection - fetch missed messages
async function syncMessages(channelId, lastSeenTs) {
  const missed = await db('messages')
    .where({ channel_id: channelId })
    .where('created_at', '>', lastSeenTs)
    .orderBy('created_at', 'asc')
    .limit(1000)

  return { messages: missed, hasMore: missed.length === 1000 }
}
```

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      CDN (Static Assets)                        │
│              JS bundles, images, emoji sprites                   │
│                    TTL: 1 year (versioned)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API / Gateway Layer                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Valkey Cache Layer                          │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ User Cache  │  │Channel Cache│  │ Workspace   │              │
│  │ TTL: 5min   │  │ TTL: 2min   │  │ TTL: 10min  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Presence   │  │  Sessions   │  │ Rate Limits │              │
│  │  TTL: 60s   │  │ TTL: 24hr   │  │  TTL: 1min  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                                │
└─────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern (Read Path)

```javascript
// Cache-aside for user profile
async function getUser(userId) {
  const cacheKey = `user:${userId}`

  // 1. Check cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // 2. Cache miss - fetch from database
  const user = await db('users').where({ id: userId }).first()

  // 3. Populate cache
  if (user) {
    await redis.setex(cacheKey, 300, JSON.stringify(user)) // 5 min TTL
  }

  return user
}

// Cache-aside for channel members (frequently accessed)
async function getChannelMembers(channelId) {
  const cacheKey = `channel:${channelId}:members`

  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  const members = await db('channel_members')
    .where({ channel_id: channelId })
    .join('users', 'users.id', 'channel_members.user_id')
    .select('users.id', 'users.name', 'users.avatar_url')

  await redis.setex(cacheKey, 120, JSON.stringify(members)) // 2 min TTL

  return members
}
```

### Write-Through for Critical Data

```javascript
// Write-through for workspace settings (rarely updated, frequently read)
async function updateWorkspaceSettings(workspaceId, settings) {
  // 1. Update database
  await db('workspaces')
    .where({ id: workspaceId })
    .update({ settings })

  // 2. Immediately update cache
  const workspace = await db('workspaces').where({ id: workspaceId }).first()
  await redis.setex(`workspace:${workspaceId}`, 600, JSON.stringify(workspace))

  return workspace
}
```

### Cache Invalidation Rules

| Cache Key Pattern | TTL | Invalidation Trigger |
|-------------------|-----|----------------------|
| `user:{id}` | 5 min | Profile update, avatar change |
| `channel:{id}` | 2 min | Channel settings update |
| `channel:{id}:members` | 2 min | Member join/leave |
| `workspace:{id}` | 10 min | Workspace settings update |
| `presence:{workspace}:{user}` | 60 sec | Heartbeat timeout |
| `session:{token}` | 24 hr | Logout, password change |
| `idem:{key}` | 24 hr | No invalidation (expires) |

```javascript
// Explicit invalidation on write
async function addChannelMember(channelId, userId) {
  await db('channel_members').insert({ channel_id: channelId, user_id: userId })

  // Invalidate members cache
  await redis.del(`channel:${channelId}:members`)

  // Publish for real-time update
  await redis.publish(`channel:${channelId}:events`, JSON.stringify({
    type: 'member_joined',
    user_id: userId
  }))
}
```

### CDN Configuration (Static Assets)

```yaml
# Local development: serve from Express static
# Production concept for learning:
cdn_config:
  static_assets:
    path: /static/*
    ttl: 31536000  # 1 year
    headers:
      Cache-Control: "public, max-age=31536000, immutable"

  emoji_sprites:
    path: /emoji/*
    ttl: 604800  # 1 week
    headers:
      Cache-Control: "public, max-age=604800"

  user_avatars:
    path: /avatars/*
    ttl: 86400  # 1 day
    headers:
      Cache-Control: "public, max-age=86400"
    invalidation: on_avatar_upload
```

---

## Authentication, Authorization, and Rate Limiting

### Authentication Flow

**Session-Based Auth** (simpler than JWT for learning):

```javascript
// Login - create session
async function login(email, password) {
  const user = await db('users').where({ email }).first()

  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    throw new AuthError('Invalid credentials')
  }

  // Generate session token
  const sessionToken = crypto.randomBytes(32).toString('hex')

  // Store session in Valkey with 24hr TTL
  await redis.setex(
    `session:${sessionToken}`,
    86400,
    JSON.stringify({
      user_id: user.id,
      email: user.email,
      created_at: Date.now()
    })
  )

  return { token: sessionToken, user: { id: user.id, name: user.name } }
}

// Middleware - validate session
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  const session = await redis.get(`session:${token}`)
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session' })
  }

  req.user = JSON.parse(session)
  next()
}

// Logout - invalidate session
async function logout(token) {
  await redis.del(`session:${token}`)
}
```

### Role-Based Access Control (RBAC)

**Roles per workspace:**

```sql
CREATE TABLE workspace_members (
  workspace_id UUID REFERENCES workspaces(id),
  user_id UUID REFERENCES users(id),
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  -- Roles: owner, admin, member, guest
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);
```

**Permission Matrix:**

| Permission | Guest | Member | Admin | Owner |
|------------|-------|--------|-------|-------|
| Read public channels | Yes | Yes | Yes | Yes |
| Send messages | Yes | Yes | Yes | Yes |
| Create channels | No | Yes | Yes | Yes |
| Delete own messages | Yes | Yes | Yes | Yes |
| Delete any message | No | No | Yes | Yes |
| Manage channel settings | No | No | Yes | Yes |
| Invite members | No | No | Yes | Yes |
| Remove members | No | No | Yes | Yes |
| Manage workspace settings | No | No | No | Yes |
| Delete workspace | No | No | No | Yes |
| Manage integrations | No | No | Yes | Yes |

```javascript
// Authorization middleware
async function requireRole(minRole) {
  const roleHierarchy = { guest: 0, member: 1, admin: 2, owner: 3 }

  return async (req, res, next) => {
    const { workspaceId } = req.params

    const membership = await db('workspace_members')
      .where({ workspace_id: workspaceId, user_id: req.user.user_id })
      .first()

    if (!membership) {
      return res.status(403).json({ error: 'Not a workspace member' })
    }

    if (roleHierarchy[membership.role] < roleHierarchy[minRole]) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    req.membership = membership
    next()
  }
}

// Usage in routes
app.delete('/api/workspaces/:workspaceId/members/:userId',
  authMiddleware,
  requireRole('admin'),
  async (req, res) => {
    // Admin can remove members
    await db('workspace_members')
      .where({
        workspace_id: req.params.workspaceId,
        user_id: req.params.userId
      })
      .del()

    res.status(204).send()
  }
)
```

### Channel-Level Permissions

```javascript
// Private channel access check
async function requireChannelAccess(req, res, next) {
  const { channelId } = req.params

  const channel = await db('channels').where({ id: channelId }).first()

  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' })
  }

  if (channel.is_private) {
    const membership = await db('channel_members')
      .where({ channel_id: channelId, user_id: req.user.user_id })
      .first()

    if (!membership) {
      return res.status(403).json({ error: 'Not a channel member' })
    }
  }

  req.channel = channel
  next()
}
```

### Rate Limiting

```javascript
// Sliding window rate limiter using Valkey
async function rateLimit(key, limit, windowSec) {
  const now = Date.now()
  const windowStart = now - (windowSec * 1000)

  // Use sorted set with timestamp as score
  const multi = redis.multi()
  multi.zremrangebyscore(key, 0, windowStart)  // Remove old entries
  multi.zadd(key, now, `${now}:${Math.random()}`)  // Add current request
  multi.zcard(key)  // Count requests in window
  multi.expire(key, windowSec)  // Set TTL

  const results = await multi.exec()
  const count = results[2][1]

  return { allowed: count <= limit, remaining: Math.max(0, limit - count) }
}

// Rate limit middleware
function rateLimitMiddleware(limit, windowSec) {
  return async (req, res, next) => {
    const key = `ratelimit:${req.user.user_id}:${req.path}`
    const { allowed, remaining } = await rateLimit(key, limit, windowSec)

    res.set('X-RateLimit-Limit', limit)
    res.set('X-RateLimit-Remaining', remaining)

    if (!allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded' })
    }

    next()
  }
}
```

**Rate Limits by Endpoint:**

| Endpoint | User Limit | Window | Admin Multiplier |
|----------|------------|--------|------------------|
| POST /messages | 60 | 1 min | 2x |
| POST /channels | 10 | 1 min | 5x |
| POST /reactions | 30 | 1 min | 2x |
| GET /search | 20 | 1 min | 3x |
| POST /webhooks | 5 | 1 min | 10x |
| POST /files (upload) | 20 | 1 min | 5x |

```javascript
// Apply rate limits in routes
app.post('/api/workspaces/:workspaceId/channels/:channelId/messages',
  authMiddleware,
  requireChannelAccess,
  rateLimitMiddleware(60, 60),  // 60 requests per minute
  async (req, res) => {
    // Send message logic
  }
)

// Admin routes with higher limits
app.get('/api/admin/workspaces/:workspaceId/analytics',
  authMiddleware,
  requireRole('admin'),
  rateLimitMiddleware(100, 60),  // 100 requests per minute for admins
  async (req, res) => {
    // Analytics logic
  }
)
```

### API Boundaries (User vs Admin)

```
User API (/api/v1/*)
├── /workspaces                    # List user's workspaces
├── /workspaces/:id/channels       # List channels in workspace
├── /channels/:id/messages         # CRUD messages
├── /channels/:id/members          # View channel members
├── /users/:id                     # Get user profile
└── /search                        # Search messages

Admin API (/api/v1/admin/*)
├── /workspaces/:id/settings       # Workspace settings
├── /workspaces/:id/members        # Manage all members
├── /workspaces/:id/analytics      # Usage analytics
├── /workspaces/:id/integrations   # Manage webhooks/bots
├── /workspaces/:id/audit-log      # View audit trail
└── /workspaces/:id/export         # Data export
```
