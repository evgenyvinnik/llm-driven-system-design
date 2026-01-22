# Discord (Real-Time Chat System) - System Design Answer (Fullstack Focus)

45-minute system design interview format - Fullstack Engineer Position

---

## Introduction

"Today I'll design a real-time chat system similar to Discord. As a fullstack engineer, I'll focus on how the frontend and backend integrate seamlessly - the WebSocket protocol between client and server, shared type definitions, state synchronization patterns, and how user actions flow through the entire system. Let me walk through my approach."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the scope:

1. **Servers & Channels**: Users create servers with text/voice channels
2. **Real-Time Messaging**: Messages appear instantly for all channel members
3. **Message History**: Scrollable history with search
4. **Presence System**: Online/offline/idle status
5. **Direct Messages**: Private 1-on-1 and group DMs
6. **Reactions & Threads**: Emoji reactions, threaded replies

I'll focus on how these features work across the stack."

### Non-Functional Requirements

"Key targets that affect both frontend and backend:

- **Scale**: 100 million users, 10 million concurrent
- **Latency**: <100ms message delivery for real-time feel
- **Consistency**: Messages must appear in order
- **Offline Resilience**: Queue messages when disconnected"

---

## Step 2: Shared Type Definitions

"I'll start with TypeScript types shared between frontend and backend. This ensures type safety across the API boundary."

### Core Domain Types

```typescript
// shared/types/domain.ts

export interface User {
  id: string;
  username: string;
  discriminator: string; // e.g., "1234"
  avatarUrl: string | null;
  status: UserStatus;
  customStatus?: string;
}

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

export interface Guild {
  id: string;
  name: string;
  iconUrl: string | null;
  ownerId: string;
  channels: Channel[];
  memberCount: number;
}

export interface Channel {
  id: string;
  guildId: string;
  name: string;
  type: 'text' | 'voice' | 'category';
  position: number;
  parentId: string | null; // For category grouping
}

export interface Message {
  id: string;
  channelId: string;
  author: User;
  content: string;
  timestamp: string; // ISO 8601
  editedAt: string | null;
  attachments: Attachment[];
  reactions: Reaction[];
  replyTo: string | null; // Parent message ID for threads
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  size: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  users: string[]; // User IDs (first few)
  me: boolean; // Current user reacted
}
```

### WebSocket Protocol Types

```typescript
// shared/types/websocket.ts

// Client -> Server messages
export type ClientMessage =
  | { type: 'IDENTIFY'; token: string; }
  | { type: 'HEARTBEAT'; }
  | { type: 'SUBSCRIBE_CHANNEL'; channelId: string; }
  | { type: 'UNSUBSCRIBE_CHANNEL'; channelId: string; }
  | { type: 'SEND_MESSAGE'; channelId: string; content: string; nonce: string; }
  | { type: 'UPDATE_PRESENCE'; status: UserStatus; }
  | { type: 'START_TYPING'; channelId: string; }
  | { type: 'STOP_TYPING'; channelId: string; };

// Server -> Client messages
export type ServerMessage =
  | { type: 'READY'; user: User; guilds: Guild[]; sessionId: string; }
  | { type: 'HEARTBEAT_ACK'; }
  | { type: 'MESSAGE_CREATE'; message: Message; }
  | { type: 'MESSAGE_UPDATE'; message: Message; }
  | { type: 'MESSAGE_DELETE'; channelId: string; messageId: string; }
  | { type: 'MESSAGE_ACK'; nonce: string; messageId: string; }
  | { type: 'TYPING_START'; channelId: string; userId: string; }
  | { type: 'PRESENCE_UPDATE'; userId: string; status: UserStatus; }
  | { type: 'CHANNEL_UPDATE'; channel: Channel; }
  | { type: 'GUILD_MEMBER_ADD'; guildId: string; member: GuildMember; }
  | { type: 'GUILD_MEMBER_REMOVE'; guildId: string; userId: string; }
  | { type: 'RESYNC'; guilds: Guild[]; }
  | { type: 'ERROR'; code: ErrorCode; message: string; };

export type ErrorCode =
  | 'INVALID_SESSION'
  | 'RATE_LIMITED'
  | 'CHANNEL_NOT_FOUND'
  | 'PERMISSION_DENIED';
```

### Validation Schemas (Zod)

```typescript
// shared/validation/message.ts
import { z } from 'zod';

export const sendMessageSchema = z.object({
  channelId: z.string().uuid(),
  content: z.string().min(1).max(2000),
  nonce: z.string().uuid(),
  replyTo: z.string().uuid().optional(),
});

export const updatePresenceSchema = z.object({
  status: z.enum(['online', 'idle', 'dnd', 'offline']),
  customStatus: z.string().max(128).optional(),
});

export const createGuildSchema = z.object({
  name: z.string().min(2).max(100),
  icon: z.string().url().optional(),
});

export const createChannelSchema = z.object({
  guildId: z.string().uuid(),
  name: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  type: z.enum(['text', 'voice']),
  parentId: z.string().uuid().optional(),
});

// Type inference from schemas
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type UpdatePresenceInput = z.infer<typeof updatePresenceSchema>;
```

---

## Step 3: System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        React Frontend                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ Auth Store  │  │Message Store│  │Presence Store│ │ Guild Store │    │
│  │  (Zustand)  │  │  (Zustand)  │  │  (Zustand)  │  │  (Zustand)  │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │            │
│         └────────────────┴────────────────┴────────────────┘            │
│                                   │                                      │
│                          ┌────────▼────────┐                            │
│                          │ WebSocket Hook  │                            │
│                          │ (Reconnection)  │                            │
│                          └────────┬────────┘                            │
└────────────────────────────────────┼────────────────────────────────────┘
                                     │ WebSocket + REST
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Gateway Layer                                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    WebSocket Servers                              │   │
│  │  - Session Management           - Message Routing                 │   │
│  │  - Heartbeat Monitoring         - Channel Subscriptions           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│  Chat Service   │        │Presence Service │        │  REST API       │
│  (Kafka Consumer)│       │  (Redis)        │        │  (Express)      │
└────────┬────────┘        └────────┬────────┘        └────────┬────────┘
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
│   Cassandra     │        │     Redis       │        │   PostgreSQL    │
│   (Messages)    │        │   (Presence)    │        │   (Metadata)    │
└─────────────────┘        └─────────────────┘        └─────────────────┘
```

---

## Step 4: Backend Implementation

### WebSocket Gateway

```typescript
// backend/src/gateway/server.ts
import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';
import { ClientMessage, ServerMessage } from '@shared/types/websocket';

interface Session {
  userId: string;
  socket: WebSocket;
  subscribedChannels: Set<string>;
  lastHeartbeat: number;
  guilds: Set<string>;
}

export class GatewayServer {
  private sessions = new Map<string, Session>();
  private userSessions = new Map<string, Set<string>>(); // userId -> sessionIds
  private channelSubscribers = new Map<string, Set<string>>(); // channelId -> sessionIds

  private redis: Redis;
  private redisSub: Redis;

  constructor(private wss: WebSocketServer) {
    this.redis = new Redis(process.env.REDIS_URL);
    this.redisSub = new Redis(process.env.REDIS_URL);

    this.setupPubSub();
    this.setupHeartbeat();
  }

  private setupPubSub(): void {
    // Subscribe to channel patterns for cross-gateway routing
    this.redisSub.psubscribe('channel:*', 'presence:*');

    this.redisSub.on('pmessage', (pattern, channel, message) => {
      const data = JSON.parse(message) as ServerMessage;

      if (channel.startsWith('channel:')) {
        const channelId = channel.replace('channel:', '');
        this.broadcastToChannel(channelId, data);
      } else if (channel.startsWith('presence:')) {
        const guildId = channel.replace('presence:', '');
        this.broadcastToGuild(guildId, data);
      }
    });
  }

  async handleConnection(socket: WebSocket): Promise<void> {
    const sessionId = crypto.randomUUID();

    socket.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        await this.handleMessage(sessionId, message);
      } catch (error) {
        this.send(socket, { type: 'ERROR', code: 'INVALID_SESSION', message: 'Invalid message format' });
      }
    });

    socket.on('close', () => this.handleDisconnect(sessionId));
  }

  private async handleMessage(sessionId: string, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'IDENTIFY':
        await this.handleIdentify(sessionId, message.token);
        break;

      case 'HEARTBEAT':
        this.handleHeartbeat(sessionId);
        break;

      case 'SUBSCRIBE_CHANNEL':
        this.handleSubscribe(sessionId, message.channelId);
        break;

      case 'SEND_MESSAGE':
        await this.handleSendMessage(sessionId, message);
        break;

      case 'UPDATE_PRESENCE':
        await this.handlePresenceUpdate(sessionId, message.status);
        break;

      case 'START_TYPING':
        await this.handleTyping(sessionId, message.channelId);
        break;
    }
  }

  private async handleIdentify(sessionId: string, token: string): Promise<void> {
    // Validate token and get user
    const user = await this.authService.validateToken(token);
    if (!user) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.send(session.socket, { type: 'ERROR', code: 'INVALID_SESSION', message: 'Invalid token' });
      }
      return;
    }

    // Load user's guilds
    const guilds = await this.guildService.getUserGuilds(user.id);

    // Create session
    const session = this.sessions.get(sessionId);
    if (session) {
      session.userId = user.id;
      session.guilds = new Set(guilds.map(g => g.id));
      session.lastHeartbeat = Date.now();
    }

    // Track user sessions
    if (!this.userSessions.has(user.id)) {
      this.userSessions.set(user.id, new Set());
    }
    this.userSessions.get(user.id)!.add(sessionId);

    // Update presence in Redis
    await this.redis.setex(`presence:${user.id}`, 60, JSON.stringify({ status: 'online' }));

    // Send ready event
    this.send(session!.socket, {
      type: 'READY',
      user,
      guilds,
      sessionId,
    });

    // Broadcast presence to guilds
    for (const guildId of session!.guilds) {
      await this.redis.publish(`presence:${guildId}`, JSON.stringify({
        type: 'PRESENCE_UPDATE',
        userId: user.id,
        status: 'online',
      }));
    }
  }

  private async handleSendMessage(
    sessionId: string,
    message: { channelId: string; content: string; nonce: string }
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Validate message
    const validation = sendMessageSchema.safeParse(message);
    if (!validation.success) {
      this.send(session.socket, { type: 'ERROR', code: 'INVALID_SESSION', message: 'Invalid message' });
      return;
    }

    // Check rate limit
    const limited = await this.rateLimiter.check(session.userId, 'send_message');
    if (limited) {
      this.send(session.socket, { type: 'ERROR', code: 'RATE_LIMITED', message: 'Slow down!' });
      return;
    }

    // Create message (Kafka will handle persistence and distribution)
    const newMessage = await this.messageService.create({
      channelId: message.channelId,
      authorId: session.userId,
      content: message.content,
    });

    // Acknowledge to sender immediately
    this.send(session.socket, { type: 'MESSAGE_ACK', nonce: message.nonce, messageId: newMessage.id });

    // Publish to channel (Kafka consumer will write to Cassandra and Redis)
    await this.kafka.send('messages', {
      key: message.channelId,
      value: JSON.stringify(newMessage),
    });
  }

  private broadcastToChannel(channelId: string, message: ServerMessage): void {
    const subscribers = this.channelSubscribers.get(channelId);
    if (!subscribers) return;

    for (const sessionId of subscribers) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.send(session.socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}
```

### Message Service with Kafka

```typescript
// backend/src/services/messageService.ts
import { Kafka, Consumer, Producer } from 'kafkajs';
import { Client as CassandraClient } from 'cassandra-driver';
import { Redis } from 'ioredis';

export class MessageService {
  private producer: Producer;
  private consumer: Consumer;
  private cassandra: CassandraClient;
  private redis: Redis;

  async create(input: {
    channelId: string;
    authorId: string;
    content: string;
  }): Promise<Message> {
    const message: Message = {
      id: crypto.randomUUID(),
      channelId: input.channelId,
      author: await this.userService.getById(input.authorId),
      content: input.content,
      timestamp: new Date().toISOString(),
      editedAt: null,
      attachments: [],
      reactions: [],
      replyTo: null,
    };

    return message;
  }

  async startConsumer(): Promise<void> {
    await this.consumer.subscribe({ topic: 'messages', fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const msg = JSON.parse(message.value!.toString()) as Message;

        // Write to Cassandra
        await this.persistMessage(msg);

        // Publish to Redis for gateway distribution
        await this.redis.publish(`channel:${msg.channelId}`, JSON.stringify({
          type: 'MESSAGE_CREATE',
          message: msg,
        }));

        // Update channel last message for sorting
        await this.redis.zadd(
          `guild:${msg.channelId}:channels`,
          Date.now(),
          msg.channelId
        );
      },
    });
  }

  private async persistMessage(message: Message): Promise<void> {
    const bucket = this.getTimeBucket(message.timestamp);

    await this.cassandra.execute(
      `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, timestamp, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.channelId,
        bucket,
        message.id,
        message.author.id,
        message.content,
        new Date(message.timestamp),
        JSON.stringify(message.attachments),
      ]
    );
  }

  private getTimeBucket(timestamp: string): string {
    const date = new Date(timestamp);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  async getHistory(channelId: string, before?: string, limit = 50): Promise<Message[]> {
    // Start with today's bucket
    const buckets = this.getRecentBuckets(7); // Last 7 days

    const messages: Message[] = [];

    for (const bucket of buckets) {
      if (messages.length >= limit) break;

      const query = before
        ? `SELECT * FROM messages WHERE channel_id = ? AND bucket = ? AND message_id < ? ORDER BY message_id DESC LIMIT ?`
        : `SELECT * FROM messages WHERE channel_id = ? AND bucket = ? ORDER BY message_id DESC LIMIT ?`;

      const params = before
        ? [channelId, bucket, before, limit - messages.length]
        : [channelId, bucket, limit - messages.length];

      const result = await this.cassandra.execute(query, params);
      messages.push(...result.rows.map(this.rowToMessage));
    }

    return messages;
  }
}
```

### REST API Routes

```typescript
// backend/src/routes/api.ts
import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';

const router = Router();

// Message history (REST fallback for initial load)
router.get('/channels/:channelId/messages', authenticate, async (req, res) => {
  const { channelId } = req.params;
  const { before, limit } = req.query;

  // Check channel access
  const hasAccess = await checkChannelAccess(req.user.id, channelId);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const messages = await messageService.getHistory(
    channelId,
    before as string,
    Math.min(parseInt(limit as string) || 50, 100)
  );

  res.json({ messages });
});

// Search messages
router.get('/guilds/:guildId/search', authenticate, rateLimit({ points: 10, duration: 60 }), async (req, res) => {
  const { guildId } = req.params;
  const { query, channelId, authorId, before, after } = req.query;

  const results = await searchService.search({
    guildId,
    query: query as string,
    channelId: channelId as string,
    authorId: authorId as string,
    before: before as string,
    after: after as string,
  });

  res.json(results);
});

// File upload
router.post('/channels/:channelId/attachments', authenticate, upload.single('file'), async (req, res) => {
  const { channelId } = req.params;

  const attachment = await attachmentService.upload({
    channelId,
    userId: req.user.id,
    file: req.file!,
  });

  res.json({ attachment });
});

// Guild management
router.post('/guilds', authenticate, async (req, res) => {
  const input = createGuildSchema.parse(req.body);

  const guild = await guildService.create({
    ...input,
    ownerId: req.user.id,
  });

  res.status(201).json({ guild });
});

router.post('/guilds/:guildId/channels', authenticate, async (req, res) => {
  const input = createChannelSchema.parse({ ...req.body, guildId: req.params.guildId });

  // Check permission
  const canManage = await checkPermission(req.user.id, input.guildId, 'MANAGE_CHANNELS');
  if (!canManage) {
    return res.status(403).json({ error: 'Permission denied' });
  }

  const channel = await channelService.create(input);

  res.status(201).json({ channel });
});

export { router };
```

---

## Step 5: Frontend Implementation

### Zustand Stores

```typescript
// frontend/src/stores/messageStore.ts
import { create } from 'zustand';
import { Message, Channel } from '@shared/types/domain';

interface PendingMessage {
  nonce: string;
  content: string;
  channelId: string;
  status: 'pending' | 'sent' | 'failed';
}

interface MessageState {
  // Messages by channel
  messagesByChannel: Map<string, Message[]>;

  // Optimistic updates
  pendingMessages: Map<string, PendingMessage>;

  // Typing indicators
  typingUsers: Map<string, Set<string>>; // channelId -> userIds

  // Actions
  addMessage: (message: Message) => void;
  addPendingMessage: (pending: PendingMessage) => void;
  confirmMessage: (nonce: string, messageId: string) => void;
  failMessage: (nonce: string) => void;
  setTyping: (channelId: string, userId: string, isTyping: boolean) => void;
  loadHistory: (channelId: string, messages: Message[]) => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: new Map(),
  pendingMessages: new Map(),
  typingUsers: new Map(),

  addMessage: (message) => set((state) => {
    const messages = state.messagesByChannel.get(message.channelId) || [];

    // Check if already exists (deduplication)
    if (messages.some(m => m.id === message.id)) {
      return state;
    }

    // Insert in sorted order
    const newMessages = [...messages, message].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const newMap = new Map(state.messagesByChannel);
    newMap.set(message.channelId, newMessages);

    return { messagesByChannel: newMap };
  }),

  addPendingMessage: (pending) => set((state) => {
    const newMap = new Map(state.pendingMessages);
    newMap.set(pending.nonce, pending);
    return { pendingMessages: newMap };
  }),

  confirmMessage: (nonce, messageId) => set((state) => {
    const pending = state.pendingMessages.get(nonce);
    if (!pending) return state;

    const newPending = new Map(state.pendingMessages);
    newPending.delete(nonce);

    return { pendingMessages: newPending };
  }),

  failMessage: (nonce) => set((state) => {
    const pending = state.pendingMessages.get(nonce);
    if (!pending) return state;

    const newPending = new Map(state.pendingMessages);
    newPending.set(nonce, { ...pending, status: 'failed' });

    return { pendingMessages: newPending };
  }),

  setTyping: (channelId, userId, isTyping) => set((state) => {
    const typing = new Map(state.typingUsers);
    const users = typing.get(channelId) || new Set();

    if (isTyping) {
      users.add(userId);
    } else {
      users.delete(userId);
    }

    typing.set(channelId, users);
    return { typingUsers: typing };
  }),

  loadHistory: (channelId, messages) => set((state) => {
    const existing = state.messagesByChannel.get(channelId) || [];
    const merged = [...messages, ...existing];

    // Deduplicate and sort
    const unique = Array.from(
      new Map(merged.map(m => [m.id, m])).values()
    ).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const newMap = new Map(state.messagesByChannel);
    newMap.set(channelId, unique);

    return { messagesByChannel: newMap };
  }),
}));
```

### WebSocket Client Hook

```typescript
// frontend/src/hooks/useDiscordSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { ClientMessage, ServerMessage } from '@shared/types/websocket';
import { useAuthStore } from '../stores/authStore';
import { useMessageStore } from '../stores/messageStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useGuildStore } from '../stores/guildStore';

const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

export function useDiscordSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptRef = useRef(0);
  const messageQueueRef = useRef<ClientMessage[]>([]);

  const { token, setConnected } = useAuthStore();
  const { addMessage, confirmMessage, failMessage, setTyping } = useMessageStore();
  const { updatePresence } = usePresenceStore();
  const { setGuilds } = useGuildStore();

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(import.meta.env.VITE_WS_URL);
    socketRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttemptRef.current = 0;

      // Identify
      send({ type: 'IDENTIFY', token: token! });

      // Flush message queue
      while (messageQueueRef.current.length > 0) {
        const msg = messageQueueRef.current.shift()!;
        send(msg);
      }

      // Start heartbeat
      heartbeatRef.current = setInterval(() => {
        send({ type: 'HEARTBEAT' });
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as ServerMessage;
      handleMessage(message);
    };

    ws.onclose = () => {
      setConnected(false);
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);

      // Reconnect with backoff
      const delay = RECONNECT_DELAYS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS.length - 1)];
      reconnectAttemptRef.current++;

      setTimeout(connect, delay);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [token]);

  const send = useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    } else {
      // Queue for later
      messageQueueRef.current.push(message);
    }
  }, []);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'READY':
        setConnected(true);
        setGuilds(message.guilds);
        break;

      case 'HEARTBEAT_ACK':
        // Connection is alive
        break;

      case 'MESSAGE_CREATE':
        addMessage(message.message);
        break;

      case 'MESSAGE_ACK':
        confirmMessage(message.nonce, message.messageId);
        break;

      case 'TYPING_START':
        setTyping(message.channelId, message.userId, true);
        // Auto-clear after 10 seconds
        setTimeout(() => {
          setTyping(message.channelId, message.userId, false);
        }, 10000);
        break;

      case 'PRESENCE_UPDATE':
        updatePresence(message.userId, message.status);
        break;

      case 'ERROR':
        console.error('Server error:', message.code, message.message);
        if (message.code === 'INVALID_SESSION') {
          // Force re-auth
          useAuthStore.getState().logout();
        }
        break;
    }
  }, [addMessage, confirmMessage, setTyping, updatePresence, setGuilds, setConnected]);

  // Exposed actions
  const sendMessage = useCallback((channelId: string, content: string) => {
    const nonce = crypto.randomUUID();

    // Optimistic update
    useMessageStore.getState().addPendingMessage({
      nonce,
      content,
      channelId,
      status: 'pending',
    });

    send({ type: 'SEND_MESSAGE', channelId, content, nonce });

    // Fail after timeout
    setTimeout(() => {
      const pending = useMessageStore.getState().pendingMessages.get(nonce);
      if (pending?.status === 'pending') {
        failMessage(nonce);
      }
    }, 30000);
  }, [send, failMessage]);

  const subscribeChannel = useCallback((channelId: string) => {
    send({ type: 'SUBSCRIBE_CHANNEL', channelId });
  }, [send]);

  const startTyping = useCallback((channelId: string) => {
    send({ type: 'START_TYPING', channelId });
  }, [send]);

  useEffect(() => {
    if (token) {
      connect();
    }

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      socketRef.current?.close();
    };
  }, [token, connect]);

  return {
    sendMessage,
    subscribeChannel,
    startTyping,
    isConnected: socketRef.current?.readyState === WebSocket.OPEN,
  };
}
```

### Chat Component with Integration

```tsx
// frontend/src/components/ChatView.tsx
import { useEffect, useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useParams } from '@tanstack/react-router';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useDiscordSocket } from '../hooks/useDiscordSocket';
import { api } from '../services/api';
import { Message } from '@shared/types/domain';

export function ChatView() {
  const { channelId } = useParams({ from: '/channels/$channelId' });
  const parentRef = useRef<HTMLDivElement>(null);
  const { user } = useAuthStore();
  const { sendMessage, subscribeChannel, startTyping } = useDiscordSocket();

  const messages = useMessageStore((state) => state.messagesByChannel.get(channelId) || []);
  const pendingMessages = useMessageStore((state) =>
    Array.from(state.pendingMessages.values()).filter(p => p.channelId === channelId)
  );
  const typingUsers = useMessageStore((state) => state.typingUsers.get(channelId) || new Set());
  const loadHistory = useMessageStore((state) => state.loadHistory);

  // Combine real and pending messages
  const allMessages = useMemo(() => {
    const pending = pendingMessages.map(p => ({
      id: p.nonce,
      channelId,
      author: user!,
      content: p.content,
      timestamp: new Date().toISOString(),
      editedAt: null,
      attachments: [],
      reactions: [],
      replyTo: null,
      _pending: true,
      _failed: p.status === 'failed',
    }));

    return [...messages, ...pending];
  }, [messages, pendingMessages, user, channelId]);

  // Group messages by author for condensed display
  const groupedMessages = useMemo(() => {
    const groups: { author: Message['author']; messages: Message[]; timestamp: string }[] = [];

    for (const msg of allMessages) {
      const lastGroup = groups[groups.length - 1];
      const timeDiff = lastGroup
        ? new Date(msg.timestamp).getTime() - new Date(lastGroup.timestamp).getTime()
        : Infinity;

      if (lastGroup && lastGroup.author.id === msg.author.id && timeDiff < 300000) {
        lastGroup.messages.push(msg);
      } else {
        groups.push({
          author: msg.author,
          messages: [msg],
          timestamp: msg.timestamp,
        });
      }
    }

    return groups;
  }, [allMessages]);

  // Virtualization
  const virtualizer = useVirtualizer({
    count: groupedMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const group = groupedMessages[index];
      return 44 + group.messages.length * 22; // Header + messages
    },
    overscan: 5,
  });

  // Subscribe and load history on mount
  useEffect(() => {
    subscribeChannel(channelId);

    api.get(`/channels/${channelId}/messages?limit=50`)
      .then(res => loadHistory(channelId, res.data.messages))
      .catch(console.error);
  }, [channelId, subscribeChannel, loadHistory]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (parentRef.current) {
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    }
  }, [allMessages.length]);

  // Load more on scroll to top
  const handleScroll = useCallback(() => {
    if (!parentRef.current) return;

    if (parentRef.current.scrollTop < 100 && messages.length > 0) {
      const oldestId = messages[0].id;
      api.get(`/channels/${channelId}/messages?before=${oldestId}&limit=50`)
        .then(res => {
          if (res.data.messages.length > 0) {
            loadHistory(channelId, res.data.messages);
          }
        });
    }
  }, [channelId, messages, loadHistory]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto px-4"
        onScroll={handleScroll}
      >
        <div
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const group = groupedMessages[virtualRow.index];

            return (
              <div
                key={virtualRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageGroup group={group} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Typing indicator */}
      {typingUsers.size > 0 && (
        <TypingIndicator userIds={Array.from(typingUsers)} />
      )}

      {/* Input */}
      <MessageInput
        channelId={channelId}
        onSend={(content) => sendMessage(channelId, content)}
        onTyping={() => startTyping(channelId)}
      />
    </div>
  );
}

function MessageGroup({ group }: { group: { author: Message['author']; messages: Message[]; timestamp: string } }) {
  return (
    <div className="flex gap-4 py-2 hover:bg-gray-800/30">
      <img
        src={group.author.avatarUrl || '/default-avatar.png'}
        alt={group.author.username}
        className="w-10 h-10 rounded-full"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-white">{group.author.username}</span>
          <span className="text-xs text-gray-400">
            {formatTimestamp(group.timestamp)}
          </span>
        </div>
        {group.messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'text-gray-200',
              (msg as any)._pending && 'opacity-50',
              (msg as any)._failed && 'text-red-400'
            )}
          >
            {msg.content}
            {(msg as any)._failed && (
              <button className="ml-2 text-xs text-red-400 hover:underline">
                Retry
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Message Input with Typing

```tsx
// frontend/src/components/MessageInput.tsx
import { useState, useRef, useCallback } from 'react';
import { useDebouncedCallback } from 'use-debounce';

interface MessageInputProps {
  channelId: string;
  onSend: (content: string) => void;
  onTyping: () => void;
}

export function MessageInput({ channelId, onSend, onTyping }: MessageInputProps) {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Debounce typing indicator
  const debouncedTyping = useDebouncedCallback(onTyping, 2000, { leading: true, trailing: false });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    debouncedTyping();

    // Auto-resize
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;

    onSend(trimmed);
    setContent('');

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [content, onSend]);

  return (
    <div className="px-4 pb-4">
      <div className="bg-[#40444b] rounded-lg flex items-end">
        <button className="p-3 text-gray-400 hover:text-gray-200">
          <PlusCircleIcon className="w-6 h-6" />
        </button>

        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={`Message #${channelId}`}
          className="flex-1 bg-transparent py-3 px-1 text-white placeholder-gray-400 resize-none focus:outline-none"
          rows={1}
        />

        <div className="flex items-center gap-1 p-2">
          <button className="p-1.5 text-gray-400 hover:text-gray-200">
            <GiftIcon className="w-5 h-5" />
          </button>
          <button className="p-1.5 text-gray-400 hover:text-gray-200">
            <EmojiIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Step 6: End-to-End Data Flow

### Message Send Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MESSAGE SEND DATA FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

1. USER TYPES MESSAGE
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ MessageInput Component                                                    │
   │ - Captures input                                                          │
   │ - Debounces typing indicator (2s)                                        │
   │ - Sends START_TYPING via WebSocket                                       │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
2. USER HITS ENTER
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ useDiscordSocket.sendMessage()                                            │
   │ - Generates nonce (UUID)                                                  │
   │ - Adds pending message to store (optimistic)                             │
   │ - Sends SEND_MESSAGE { channelId, content, nonce }                       │
   │ - Sets 30s timeout for failure                                           │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
3. GATEWAY RECEIVES
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ GatewayServer.handleSendMessage()                                         │
   │ - Validates with Zod schema                                               │
   │ - Checks rate limit (Redis)                                               │
   │ - Creates message object with TIMEUUID                                    │
   │ - Sends to Kafka topic 'messages' (key = channelId)                      │
   │ - Immediately sends MESSAGE_ACK { nonce, messageId } to sender           │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
          ┌─────────────────────────────┼─────────────────────────────┐
          ▼                             ▼                             ▼
4. PARALLEL PROCESSING
   ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
   │ Kafka Consumer     │  │ Redis Pub/Sub      │  │ Client Receives    │
   │ - Writes to        │  │ - Publishes to     │  │ MESSAGE_ACK        │
   │   Cassandra        │  │   channel:X        │  │ - Confirms pending │
   │ - Time-bucketed    │  │ - All gateways     │  │ - Removes opacity  │
   │   partition        │  │   receive          │  │                    │
   └────────────────────┘  └────────────────────┘  └────────────────────┘
                                        │
                                        ▼
5. BROADCAST TO SUBSCRIBERS
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ All Gateways with channel:X subscribers                                   │
   │ - Receive MESSAGE_CREATE from Redis                                       │
   │ - Broadcast to local WebSocket connections                               │
   │ - Each client's MessageStore.addMessage() called                         │
   │ - Virtualized list re-renders                                            │
   └──────────────────────────────────────────────────────────────────────────┘

LATENCY BREAKDOWN:
├── User → Gateway: ~20ms (network)
├── Gateway validation: ~5ms
├── Kafka produce: ~10ms
├── MESSAGE_ACK to sender: ~5ms (parallel with Kafka)
├── Kafka → Consumer: ~10ms
├── Cassandra write: ~10ms
├── Redis publish: ~5ms
├── Redis → Gateways: ~5ms
├── Gateway → Subscribers: ~20ms
└── TOTAL: ~75ms (sender sees ACK in ~40ms)
```

### Presence Update Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PRESENCE UPDATE DATA FLOW                             │
└─────────────────────────────────────────────────────────────────────────────┘

1. USER CHANGES STATUS
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Frontend                                                                  │
   │ - User clicks "Set to DND"                                               │
   │ - Sends UPDATE_PRESENCE { status: 'dnd' }                                │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
2. GATEWAY PROCESSES
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ GatewayServer.handlePresenceUpdate()                                      │
   │ - Updates Redis: SETEX presence:userId 60 '{"status":"dnd"}'             │
   │ - For each guild user belongs to:                                         │
   │   - Publishes to presence:guildId channel                                 │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
3. LAZY SUBSCRIPTION MODEL
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Only Gateways with active viewers of the guild                           │
   │ - Subscribe to presence:guildId when user opens member list              │
   │ - Unsubscribe when user navigates away                                   │
   │ - Prevents N*M fanout (millions of updates)                              │
   └──────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
4. CLIENT RECEIVES
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ usePresenceStore.updatePresence()                                         │
   │ - Updates presence map                                                    │
   │ - MemberList component re-renders                                        │
   │ - Status indicator updates                                               │
   └──────────────────────────────────────────────────────────────────────────┘
```

---

## Step 7: Error Handling Across Stack

### Backend Error Handling

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Zod validation errors
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: err.errors.map(e => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Application errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      details: err.details,
    });
  }

  // Unexpected errors
  logger.error('Unhandled error', { error: err, path: req.path });

  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
}
```

### Frontend Error Handling

```typescript
// frontend/src/services/api.ts
import axios, { AxiosError } from 'axios';
import { useAuthStore } from '../stores/authStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error: string; message: string }>) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }

    if (error.response?.status === 429) {
      const retryAfter = error.response.headers['retry-after'];
      // Show rate limit toast
      toast.error(`Rate limited. Try again in ${retryAfter}s`);
    }

    return Promise.reject(error);
  }
);

export { api };
```

### WebSocket Error Recovery

```typescript
// frontend/src/hooks/useDiscordSocket.ts (error handling section)

const handleMessage = useCallback((message: ServerMessage) => {
  switch (message.type) {
    case 'ERROR':
      handleError(message);
      break;

    case 'RESYNC':
      // Server requested full resync (after reconnect or error recovery)
      setGuilds(message.guilds);
      // Clear stale data
      useMessageStore.getState().clear();
      // Reload current channel
      if (currentChannelId) {
        api.get(`/channels/${currentChannelId}/messages?limit=50`)
          .then(res => loadHistory(currentChannelId, res.data.messages));
      }
      break;
  }
}, []);

function handleError(error: { code: ErrorCode; message: string }) {
  switch (error.code) {
    case 'INVALID_SESSION':
      // Session expired, re-authenticate
      useAuthStore.getState().logout();
      break;

    case 'RATE_LIMITED':
      toast.error(error.message);
      break;

    case 'CHANNEL_NOT_FOUND':
      // Navigate away from deleted channel
      navigate('/channels/@me');
      toast.error('Channel was deleted');
      break;

    case 'PERMISSION_DENIED':
      toast.error('You do not have permission to do that');
      break;
  }
}
```

---

## Step 8: Testing Strategy

### Shared Type Testing

```typescript
// shared/types/__tests__/validation.test.ts
import { describe, it, expect } from 'vitest';
import { sendMessageSchema, createGuildSchema } from '../validation/message';

describe('sendMessageSchema', () => {
  it('validates correct message', () => {
    const result = sendMessageSchema.safeParse({
      channelId: '550e8400-e29b-41d4-a716-446655440000',
      content: 'Hello world',
      nonce: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty content', () => {
    const result = sendMessageSchema.safeParse({
      channelId: '550e8400-e29b-41d4-a716-446655440000',
      content: '',
      nonce: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(false);
  });

  it('rejects content over 2000 chars', () => {
    const result = sendMessageSchema.safeParse({
      channelId: '550e8400-e29b-41d4-a716-446655440000',
      content: 'a'.repeat(2001),
      nonce: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(false);
  });
});
```

### Integration Testing

```typescript
// backend/src/__tests__/messageFlow.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createTestServer } from './helpers/testServer';
import { createTestUser, getAuthToken } from './helpers/auth';

describe('Message Flow Integration', () => {
  let server: ReturnType<typeof createTestServer>;
  let ws1: WebSocket;
  let ws2: WebSocket;
  let user1Token: string;
  let user2Token: string;
  let channelId: string;

  beforeAll(async () => {
    server = await createTestServer();
    const user1 = await createTestUser('alice');
    const user2 = await createTestUser('bob');
    user1Token = await getAuthToken(user1.id);
    user2Token = await getAuthToken(user2.id);

    // Create a test channel
    channelId = await server.createChannel('test-channel');
  });

  afterAll(async () => {
    ws1?.close();
    ws2?.close();
    await server.close();
  });

  it('delivers messages in real-time to all subscribers', async () => {
    const receivedMessages: any[] = [];

    // Connect both users
    ws1 = new WebSocket(server.wsUrl);
    ws2 = new WebSocket(server.wsUrl);

    await Promise.all([
      waitForOpen(ws1),
      waitForOpen(ws2),
    ]);

    // Identify
    ws1.send(JSON.stringify({ type: 'IDENTIFY', token: user1Token }));
    ws2.send(JSON.stringify({ type: 'IDENTIFY', token: user2Token }));

    await Promise.all([
      waitForMessage(ws1, 'READY'),
      waitForMessage(ws2, 'READY'),
    ]);

    // Subscribe to channel
    ws1.send(JSON.stringify({ type: 'SUBSCRIBE_CHANNEL', channelId }));
    ws2.send(JSON.stringify({ type: 'SUBSCRIBE_CHANNEL', channelId }));

    // User 1 sends message
    const nonce = crypto.randomUUID();
    ws1.send(JSON.stringify({
      type: 'SEND_MESSAGE',
      channelId,
      content: 'Hello from Alice!',
      nonce,
    }));

    // User 1 should get ACK
    const ack = await waitForMessage(ws1, 'MESSAGE_ACK');
    expect(ack.nonce).toBe(nonce);

    // User 2 should receive the message
    const msgEvent = await waitForMessage(ws2, 'MESSAGE_CREATE');
    expect(msgEvent.message.content).toBe('Hello from Alice!');
    expect(msgEvent.message.author.username).toBe('alice');
  });
});
```

---

## Step 9: Deployment Considerations

### Shared Package Publishing

```json
// shared/package.json
{
  "name": "@discord-clone/shared",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest"
  },
  "dependencies": {
    "zod": "^3.22.0"
  }
}
```

### Monorepo Structure

```
discord/
├── packages/
│   └── shared/                 # Shared types and validation
│       ├── types/
│       │   ├── domain.ts
│       │   └── websocket.ts
│       ├── validation/
│       │   └── schemas.ts
│       └── package.json
├── backend/
│   ├── src/
│   │   ├── gateway/
│   │   ├── services/
│   │   └── routes/
│   └── package.json           # depends on @discord-clone/shared
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── stores/
│   │   └── hooks/
│   └── package.json           # depends on @discord-clone/shared
├── package.json               # workspace root
└── turbo.json                 # build orchestration
```

---

## Summary

"To summarize my fullstack Discord design:

1. **Shared Types**: TypeScript interfaces and Zod schemas ensure type safety across the API boundary between frontend and backend

2. **WebSocket Protocol**: Defined message types for client-server communication with proper handling for identification, heartbeat, messaging, and presence

3. **State Management**: Zustand stores on the frontend handle messages, presence, and guilds with optimistic updates and pending message tracking

4. **Real-Time Sync**: WebSocket hook manages connection lifecycle, automatic reconnection with backoff, and message queuing during disconnection

5. **Data Flow**: Messages flow through WebSocket -> Gateway -> Kafka -> Cassandra for persistence, and Redis Pub/Sub for cross-gateway distribution

6. **Error Handling**: Consistent error handling across the stack with proper error codes, validation errors, and recovery mechanisms

7. **Testing**: Integration tests verify the complete message flow from sender to receiver

The key fullstack insights are:
- Shared types prevent API contract drift
- Optimistic updates provide instant feedback
- WebSocket reconnection is critical for reliability
- Validation at both ends catches errors early
- Message nonces enable reliable delivery confirmation

What aspects of the frontend-backend integration would you like me to elaborate on?"
