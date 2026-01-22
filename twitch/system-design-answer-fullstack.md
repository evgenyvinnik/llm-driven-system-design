# Twitch - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **Live streaming**: Streamers broadcast via RTMP, viewers watch via HLS
- **Real-time chat**: WebSocket-based chat with emotes, badges, moderation
- **Channel management**: Stream keys, go live/offline, viewer counts
- **Follow/Subscribe**: Social features with real-time notifications
- **Creator dashboard**: Stream management, chat settings, analytics

### Non-Functional Requirements
- **Low latency**: 2-5 second glass-to-glass for video, <100ms for chat
- **High availability**: 99.9% uptime for live streams
- **Scalability**: Support 100K+ concurrent viewers per channel
- **Consistency**: Chat messages delivered exactly once, in order

### Full-Stack Focus Areas
1. Shared TypeScript types for type safety across layers
2. End-to-end data flow from streamer to viewer
3. Real-time synchronization between frontend and backend
4. Error handling and recovery at every layer

---

## 2. High-Level Architecture (5 minutes)

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ VideoPlayer │  │  ChatPanel  │  │ BrowsePage  │  │  Dashboard  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │         │
│         │    HLS         │  WebSocket     │    REST        │  REST   │
└─────────┼────────────────┼────────────────┼────────────────┼─────────┘
          │                │                │                │
          ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                            BACKEND                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  CDN/HLS    │  │ Chat Pods   │  │  API Server │  │ Admin APIs  │ │
│  │  Segments   │  │ (WebSocket) │  │   (REST)    │  │   (REST)    │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │         │
│         │                │     Redis Pub/Sub               │         │
│         │                └────────┬───────┘                │         │
│         │                         │                        │         │
│  ┌──────┴──────┐  ┌───────────────┴───────────────┐       │         │
│  │   S3/Minio  │  │           PostgreSQL          │◀──────┘         │
│  │  (Segments) │  │  (Users, Channels, Messages)  │                 │
│  └─────────────┘  └───────────────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Shared Type Definitions

```typescript
// shared/types.ts - Used by both frontend and backend

// User and Authentication
export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  createdAt: string;
}

export interface Session {
  userId: string;
  token: string;
  expiresAt: string;
}

// Channel and Stream
export interface Channel {
  id: string;
  userId: string;
  name: string;
  title: string;
  categoryId: string;
  isLive: boolean;
  streamKey?: string;  // Only visible to owner
  viewerCount: number;
  thumbnailUrl: string;
  createdAt: string;
}

export interface StreamStatus {
  channelId: string;
  isLive: boolean;
  startedAt: string | null;
  viewerCount: number;
  peakViewers: number;
}

// Chat
export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string;
  username: string;
  displayName: string;
  content: string;
  badges: Badge[];
  emotes: EmotePosition[];
  color: string;
  timestamp: number;
}

export interface Badge {
  type: 'broadcaster' | 'moderator' | 'vip' | 'subscriber';
  version?: number;  // For subscriber tier/months
}

export interface EmotePosition {
  id: string;
  name: string;
  start: number;
  end: number;
}

export interface ChatSettings {
  slowMode: number;  // 0 = off, otherwise seconds
  subscriberOnly: boolean;
  followerOnly: boolean;
  followerMinutes: number;  // Minimum follow time
  emoteOnly: boolean;
}

// WebSocket Events
export type WSClientMessage =
  | { type: 'join'; channelId: string }
  | { type: 'leave'; channelId: string }
  | { type: 'message'; channelId: string; content: string; idempotencyKey: string };

export type WSServerMessage =
  | { type: 'message'; message: ChatMessage }
  | { type: 'user_banned'; userId: string; channelId: string }
  | { type: 'message_deleted'; messageId: string; channelId: string }
  | { type: 'clear_chat'; channelId: string }
  | { type: 'slow_mode'; channelId: string; duration: number }
  | { type: 'viewer_count'; channelId: string; count: number }
  | { type: 'error'; code: string; message: string };

// API Responses
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Follow/Subscribe
export interface Follow {
  userId: string;
  channelId: string;
  followedAt: string;
}

export interface Subscription {
  id: string;
  userId: string;
  channelId: string;
  tier: 1 | 2 | 3;
  startedAt: string;
  expiresAt: string;
  isGift: boolean;
}
```

---

## 3. Chat System - End to End (10 minutes)

### Backend: WebSocket Server with Redis Pub/Sub

```typescript
// backend/src/chat/index.ts
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';
import { pool } from '../shared/db.js';
import { validateSession } from '../shared/auth.js';
import type { ChatMessage, WSClientMessage, WSServerMessage, ChatSettings } from '../../shared/types.js';

const redisSubscriber = createClient({ url: process.env.REDIS_URL });
const redisPublisher = redisSubscriber.duplicate();
const redisCache = redisSubscriber.duplicate();

// Track connections per channel
const channelConnections = new Map<string, Set<WebSocket>>();

// Track user's current channel
const userChannels = new Map<WebSocket, string>();

export async function initChatServer(server: http.Server) {
  await Promise.all([
    redisSubscriber.connect(),
    redisPublisher.connect(),
    redisCache.connect(),
  ]);

  const wss = new WebSocketServer({ server, path: '/ws/chat' });

  wss.on('connection', async (ws, req) => {
    const sessionToken = new URL(req.url!, `http://${req.headers.host}`).searchParams.get('token');
    const user = await validateSession(sessionToken);

    if (!user) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.on('message', async (data) => {
      try {
        const message: WSClientMessage = JSON.parse(data.toString());
        await handleClientMessage(ws, user, message);
      } catch (error) {
        sendToClient(ws, { type: 'error', code: 'PARSE_ERROR', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      const channelId = userChannels.get(ws);
      if (channelId) {
        leaveChannel(ws, channelId);
      }
    });
  });

  // Subscribe to all chat channels via pattern
  await redisSubscriber.pSubscribe('chat:*', (message, channel) => {
    const channelId = channel.replace('chat:', '');
    broadcastToChannel(channelId, JSON.parse(message));
  });
}

async function handleClientMessage(ws: WebSocket, user: User, message: WSClientMessage) {
  switch (message.type) {
    case 'join':
      await joinChannel(ws, user, message.channelId);
      break;

    case 'leave':
      leaveChannel(ws, message.channelId);
      break;

    case 'message':
      await handleChatMessage(ws, user, message);
      break;
  }
}

async function joinChannel(ws: WebSocket, user: User, channelId: string) {
  // Leave previous channel if any
  const previousChannel = userChannels.get(ws);
  if (previousChannel) {
    leaveChannel(ws, previousChannel);
  }

  // Add to channel room
  if (!channelConnections.has(channelId)) {
    channelConnections.set(channelId, new Set());
  }
  channelConnections.get(channelId)!.add(ws);
  userChannels.set(ws, channelId);

  // Send recent messages
  const recentMessages = await getRecentMessages(channelId, 50);
  for (const msg of recentMessages) {
    sendToClient(ws, { type: 'message', message: msg });
  }

  // Update viewer count
  await updateViewerCount(channelId);
}

function leaveChannel(ws: WebSocket, channelId: string) {
  channelConnections.get(channelId)?.delete(ws);
  userChannels.delete(ws);

  // Cleanup empty channels
  if (channelConnections.get(channelId)?.size === 0) {
    channelConnections.delete(channelId);
  }

  updateViewerCount(channelId);
}

async function handleChatMessage(
  ws: WebSocket,
  user: User,
  message: { channelId: string; content: string; idempotencyKey: string }
) {
  const { channelId, content, idempotencyKey } = message;

  // 1. Deduplication check
  const dedupKey = `chat_dedup:${channelId}`;
  const isNew = await redisCache.sAdd(dedupKey, idempotencyKey);
  if (!isNew) {
    return; // Already processed
  }
  await redisCache.expire(dedupKey, 300); // 5 minute TTL

  // 2. Rate limiting
  const rateLimitResult = await checkRateLimit(user.id, channelId);
  if (!rateLimitResult.allowed) {
    sendToClient(ws, {
      type: 'error',
      code: 'RATE_LIMITED',
      message: `Wait ${rateLimitResult.retryAfter}s before sending another message`,
    });
    return;
  }

  // 3. Check channel settings (slow mode, subscriber only, etc.)
  const settingsCheck = await checkChannelSettings(user.id, channelId);
  if (!settingsCheck.allowed) {
    sendToClient(ws, { type: 'error', code: settingsCheck.code, message: settingsCheck.message });
    return;
  }

  // 4. Parse emotes
  const emotes = parseEmotes(content, channelId);

  // 5. Get user badges for this channel
  const badges = await getUserBadges(user.id, channelId);

  // 6. Build chat message
  const chatMessage: ChatMessage = {
    id: crypto.randomUUID(),
    channelId,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    content,
    badges,
    emotes,
    color: user.chatColor || '#FFFFFF',
    timestamp: Date.now(),
  };

  // 7. Store in database (async, don't block)
  storeChatMessage(chatMessage).catch(console.error);

  // 8. Publish to Redis for all chat pods
  await redisPublisher.publish(`chat:${channelId}`, JSON.stringify({
    type: 'message',
    message: chatMessage,
  }));
}

async function checkRateLimit(userId: string, channelId: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  const settings = await getChatSettings(channelId);
  const cooldown = settings.slowMode || 1; // Default 1 second

  const key = `ratelimit:chat:${channelId}:${userId}`;
  const lastMessage = await redisCache.get(key);

  if (lastMessage) {
    const elapsed = (Date.now() - parseInt(lastMessage)) / 1000;
    if (elapsed < cooldown) {
      return { allowed: false, retryAfter: Math.ceil(cooldown - elapsed) };
    }
  }

  await redisCache.setEx(key, cooldown, Date.now().toString());
  return { allowed: true };
}

function broadcastToChannel(channelId: string, message: WSServerMessage) {
  const connections = channelConnections.get(channelId);
  if (!connections) return;

  const data = JSON.stringify(message);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function sendToClient(ws: WebSocket, message: WSServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
```

### Frontend: Chat Integration

```typescript
// frontend/src/hooks/useChat.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { WSClientMessage, WSServerMessage, ChatMessage } from '@shared/types';

export function useChat(channelId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const pendingMessages = useRef<Map<string, { content: string; timestamp: number }>>(new Map());

  const { addMessage, setConnectionStatus, setCooldown } = useChatStore();
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(() => {
    const token = localStorage.getItem('session_token');
    const ws = new WebSocket(
      `${import.meta.env.VITE_WS_URL}/ws/chat?token=${token}`
    );

    ws.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttempts.current = 0;
      setError(null);

      // Join channel
      const joinMessage: WSClientMessage = { type: 'join', channelId };
      ws.send(JSON.stringify(joinMessage));

      // Retry pending messages
      for (const [key, { content }] of pendingMessages.current) {
        ws.send(JSON.stringify({
          type: 'message',
          channelId,
          content,
          idempotencyKey: key,
        }));
      }
    };

    ws.onmessage = (event) => {
      const message: WSServerMessage = JSON.parse(event.data);
      handleServerMessage(message);
    };

    ws.onclose = (event) => {
      setConnectionStatus('disconnected');
      wsRef.current = null;

      if (event.code !== 4001) { // Don't reconnect on auth failure
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      setError('Connection error');
    };

    wsRef.current = ws;
  }, [channelId, addMessage, setConnectionStatus]);

  const handleServerMessage = (message: WSServerMessage) => {
    switch (message.type) {
      case 'message':
        addMessage(message.message);
        // Remove from pending if it was our message
        pendingMessages.current.delete(message.message.id);
        break;

      case 'error':
        if (message.code === 'RATE_LIMITED') {
          setCooldown(parseInt(message.message.match(/\d+/)?.[0] || '0'));
        }
        setError(message.message);
        break;

      case 'slow_mode':
        useChatStore.getState().setSlowMode(message.duration);
        break;

      case 'viewer_count':
        useChatStore.getState().setViewerCount(message.count);
        break;
    }
  };

  const sendMessage = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('Not connected');
      return;
    }

    // Generate idempotency key
    const idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Store pending message for retry
    pendingMessages.current.set(idempotencyKey, { content, timestamp: Date.now() });

    // Clean old pending messages (older than 30s)
    const cutoff = Date.now() - 30000;
    for (const [key, { timestamp }] of pendingMessages.current) {
      if (timestamp < cutoff) pendingMessages.current.delete(key);
    }

    const message: WSClientMessage = {
      type: 'message',
      channelId,
      content,
      idempotencyKey,
    };

    wsRef.current.send(JSON.stringify(message));
  }, [channelId]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendMessage, error };
}
```

### Zustand Store for Chat State

```typescript
// frontend/src/stores/chatStore.ts
import { create } from 'zustand';
import type { ChatMessage, ChatSettings } from '@shared/types';

interface ChatState {
  messages: ChatMessage[];
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
  slowMode: number;
  cooldownRemaining: number;
  viewerCount: number;
  settings: ChatSettings | null;

  addMessage: (message: ChatMessage) => void;
  setConnectionStatus: (status: ChatState['connectionStatus']) => void;
  setSlowMode: (seconds: number) => void;
  setCooldown: (seconds: number) => void;
  setViewerCount: (count: number) => void;
  clearMessages: () => void;
}

const MAX_MESSAGES = 500;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  connectionStatus: 'connecting',
  slowMode: 0,
  cooldownRemaining: 0,
  viewerCount: 0,
  settings: null,

  addMessage: (message) => {
    set((state) => {
      const newMessages = [...state.messages, message];
      // Keep only last MAX_MESSAGES
      if (newMessages.length > MAX_MESSAGES) {
        return { messages: newMessages.slice(-MAX_MESSAGES) };
      }
      return { messages: newMessages };
    });
  },

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setSlowMode: (seconds) => set({ slowMode: seconds }),

  setCooldown: (seconds) => {
    set({ cooldownRemaining: seconds });

    // Countdown timer
    if (seconds > 0) {
      const interval = setInterval(() => {
        const current = get().cooldownRemaining;
        if (current <= 1) {
          clearInterval(interval);
          set({ cooldownRemaining: 0 });
        } else {
          set({ cooldownRemaining: current - 1 });
        }
      }, 1000);
    }
  },

  setViewerCount: (count) => set({ viewerCount: count }),

  clearMessages: () => set({ messages: [] }),
}));
```

---

## 4. Stream Lifecycle - End to End (10 minutes)

### Backend: Stream Management API

```typescript
// backend/src/stream/routes.ts
import { Router } from 'express';
import { pool } from '../shared/db.js';
import { redisClient } from '../shared/cache.js';
import { requireAuth, requireChannelOwner } from '../shared/auth.js';
import type { Channel, StreamStatus } from '../../shared/types.js';

const router = Router();

// Get channel stream status
router.get('/channels/:channelId/status', async (req, res) => {
  const { channelId } = req.params;

  // Try cache first
  const cached = await redisClient.get(`stream_status:${channelId}`);
  if (cached) {
    return res.json({ success: true, data: JSON.parse(cached) });
  }

  const result = await pool.query(
    `SELECT id, is_live, started_at, viewer_count, peak_viewers
     FROM channels WHERE id = $1`,
    [channelId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Channel not found' } });
  }

  const status: StreamStatus = {
    channelId,
    isLive: result.rows[0].is_live,
    startedAt: result.rows[0].started_at,
    viewerCount: result.rows[0].viewer_count,
    peakViewers: result.rows[0].peak_viewers,
  };

  // Cache for 10 seconds
  await redisClient.setEx(`stream_status:${channelId}`, 10, JSON.stringify(status));

  res.json({ success: true, data: status });
});

// Start stream (simulated - in production this would be triggered by RTMP ingest)
router.post('/channels/:channelId/go-live', requireAuth, requireChannelOwner, async (req, res) => {
  const { channelId } = req.params;
  const userId = req.user!.id;

  // Acquire distributed lock to prevent race conditions
  const lockKey = `lock:stream_start:${channelId}`;
  const lockAcquired = await redisClient.set(lockKey, userId, { NX: true, EX: 30 });

  if (!lockAcquired) {
    return res.status(409).json({
      success: false,
      error: { code: 'ALREADY_STARTING', message: 'Stream start already in progress' },
    });
  }

  try {
    // Check if already live
    const current = await pool.query('SELECT is_live FROM channels WHERE id = $1', [channelId]);
    if (current.rows[0]?.is_live) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_LIVE', message: 'Channel is already live' },
      });
    }

    // Update channel status
    await pool.query(
      `UPDATE channels
       SET is_live = true, started_at = NOW(), viewer_count = 0, peak_viewers = 0
       WHERE id = $1`,
      [channelId]
    );

    // Invalidate cache
    await redisClient.del(`stream_status:${channelId}`);

    // Publish event for real-time updates
    await redisClient.publish('stream_events', JSON.stringify({
      type: 'stream_online',
      channelId,
      timestamp: Date.now(),
    }));

    res.json({ success: true, data: { channelId, isLive: true } });
  } finally {
    await redisClient.del(lockKey);
  }
});

// End stream
router.post('/channels/:channelId/go-offline', requireAuth, requireChannelOwner, async (req, res) => {
  const { channelId } = req.params;

  await pool.query(
    `UPDATE channels
     SET is_live = false, ended_at = NOW()
     WHERE id = $1`,
    [channelId]
  );

  // Invalidate cache
  await redisClient.del(`stream_status:${channelId}`);

  // Publish event
  await redisClient.publish('stream_events', JSON.stringify({
    type: 'stream_offline',
    channelId,
    timestamp: Date.now(),
  }));

  res.json({ success: true });
});

// Update viewer count (called by chat servers)
router.post('/internal/viewer-count', async (req, res) => {
  const { channelId, count } = req.body;

  await pool.query(
    `UPDATE channels
     SET viewer_count = $2, peak_viewers = GREATEST(peak_viewers, $2)
     WHERE id = $1`,
    [channelId, count]
  );

  // Broadcast to viewers
  await redisClient.publish(`chat:${channelId}`, JSON.stringify({
    type: 'viewer_count',
    channelId,
    count,
  }));

  res.json({ success: true });
});

export default router;
```

### Frontend: Stream Page Integration

```typescript
// frontend/src/routes/channel.$channelName.tsx
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { VideoPlayer } from '@/components/VideoPlayer';
import { ChatPanel } from '@/components/Chat/ChatPanel';
import { ChannelInfo } from '@/components/Channel/ChannelInfo';
import { useChat } from '@/hooks/useChat';
import type { Channel, StreamStatus } from '@shared/types';

export function ChannelPage() {
  const { channelName } = useParams({ from: '/channel/$channelName' });

  // Fetch channel data
  const { data: channel, isLoading: channelLoading } = useQuery({
    queryKey: ['channel', channelName],
    queryFn: async (): Promise<Channel> => {
      const res = await fetch(`/api/channels/${channelName}`);
      const data = await res.json();
      return data.data;
    },
  });

  // Fetch stream status with polling
  const { data: streamStatus } = useQuery({
    queryKey: ['stream-status', channel?.id],
    queryFn: async (): Promise<StreamStatus> => {
      const res = await fetch(`/api/channels/${channel!.id}/status`);
      const data = await res.json();
      return data.data;
    },
    enabled: !!channel,
    refetchInterval: 30000, // Poll every 30 seconds
  });

  // Initialize chat connection
  const { sendMessage, error: chatError } = useChat(channel?.id || '');

  if (channelLoading) {
    return <ChannelSkeleton />;
  }

  if (!channel) {
    return <ChannelNotFound />;
  }

  return (
    <div className="channel-page">
      <div className="main-content">
        {streamStatus?.isLive ? (
          <VideoPlayer
            streamUrl={`/hls/${channel.id}/playlist.m3u8`}
            channelId={channel.id}
            isLive={true}
          />
        ) : (
          <OfflineScreen channel={channel} />
        )}

        <ChannelInfo
          channel={channel}
          isLive={streamStatus?.isLive || false}
          viewerCount={streamStatus?.viewerCount || 0}
        />
      </div>

      <aside className="chat-sidebar">
        <ChatPanel
          channelId={channel.id}
          onSendMessage={sendMessage}
          error={chatError}
        />
      </aside>
    </div>
  );
}

function OfflineScreen({ channel }: { channel: Channel }) {
  return (
    <div className="offline-screen">
      <div className="offline-avatar">
        <img src={`/avatars/${channel.name}`} alt={channel.name} />
      </div>
      <h2>{channel.name} is offline</h2>
      <p>Check back later or follow to get notified when they go live.</p>
    </div>
  );
}
```

### API Client with Type Safety

```typescript
// frontend/src/api/client.ts
import type { ApiResponse, Channel, StreamStatus, Follow, Subscription } from '@shared/types';

const API_BASE = import.meta.env.VITE_API_URL || '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('session_token');

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options?.headers,
    },
  });

  const data: ApiResponse<T> = await res.json();

  if (!data.success) {
    throw new ApiError(data.error!.code, data.error!.message);
  }

  return data.data!;
}

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  // Channels
  getChannel: (name: string) => request<Channel>(`/api/channels/${name}`),
  getStreamStatus: (channelId: string) => request<StreamStatus>(`/api/channels/${channelId}/status`),

  // Stream Control (for dashboard)
  goLive: (channelId: string) =>
    request<{ channelId: string; isLive: boolean }>(`/api/channels/${channelId}/go-live`, { method: 'POST' }),
  goOffline: (channelId: string) =>
    request<void>(`/api/channels/${channelId}/go-offline`, { method: 'POST' }),
  regenerateStreamKey: (channelId: string) =>
    request<{ streamKey: string }>(`/api/channels/${channelId}/stream-key`, { method: 'POST' }),

  // Follows
  followChannel: (channelId: string) =>
    request<Follow>(`/api/follows/${channelId}`, { method: 'POST' }),
  unfollowChannel: (channelId: string) =>
    request<void>(`/api/follows/${channelId}`, { method: 'DELETE' }),
  getFollowedChannels: () => request<Channel[]>('/api/follows'),

  // Subscriptions
  subscribe: (channelId: string, tier: 1 | 2 | 3, idempotencyKey: string) =>
    request<Subscription>(`/api/subscriptions/${channelId}`, {
      method: 'POST',
      body: JSON.stringify({ tier, idempotencyKey }),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
};
```

---

## 5. Subscription Flow with Idempotency (5 minutes)

### Backend: Idempotent Subscription Handler

```typescript
// backend/src/subscriptions/routes.ts
import { Router } from 'express';
import { pool } from '../shared/db.js';
import { redisClient } from '../shared/cache.js';
import { requireAuth } from '../shared/auth.js';
import type { Subscription } from '../../shared/types.js';

const router = Router();

router.post('/subscriptions/:channelId', requireAuth, async (req, res) => {
  const { channelId } = req.params;
  const { tier, idempotencyKey } = req.body;
  const userId = req.user!.id;

  // Check idempotency key
  const cacheKey = `idempotency:sub:${idempotencyKey}`;
  const cached = await redisClient.get(cacheKey);

  if (cached) {
    // Return cached response
    return res.json({ success: true, data: JSON.parse(cached) });
  }

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
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_SUBSCRIBED', message: 'Already subscribed to this channel' },
      });
    }

    // Create subscription
    const result = await client.query(
      `INSERT INTO subscriptions (user_id, channel_id, tier, started_at, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 month')
       RETURNING id, user_id, channel_id, tier, started_at, expires_at`,
      [userId, channelId, tier]
    );

    const subscription: Subscription = {
      id: result.rows[0].id,
      userId: result.rows[0].user_id,
      channelId: result.rows[0].channel_id,
      tier: result.rows[0].tier,
      startedAt: result.rows[0].started_at,
      expiresAt: result.rows[0].expires_at,
      isGift: false,
    };

    await client.query('COMMIT');

    // Cache idempotency result for 24 hours
    await redisClient.setEx(cacheKey, 86400, JSON.stringify(subscription));

    // Publish event for real-time notification
    await redisClient.publish(`chat:${channelId}`, JSON.stringify({
      type: 'new_subscriber',
      userId,
      username: req.user!.username,
      tier,
    }));

    res.json({ success: true, data: subscription });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export default router;
```

### Frontend: Subscribe Modal

```typescript
// frontend/src/components/Channel/SubscribeModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Subscription } from '@shared/types';

interface SubscribeModalProps {
  channelId: string;
  channelName: string;
  onClose: () => void;
}

export function SubscribeModal({ channelId, channelName, onClose }: SubscribeModalProps) {
  const [selectedTier, setSelectedTier] = useState<1 | 2 | 3>(1);
  const queryClient = useQueryClient();

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      // Generate idempotency key
      const idempotencyKey = `sub-${channelId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return api.subscribe(channelId, selectedTier, idempotencyKey);
    },
    onSuccess: (subscription: Subscription) => {
      queryClient.invalidateQueries({ queryKey: ['subscription', channelId] });
      queryClient.invalidateQueries({ queryKey: ['my-subscriptions'] });
      onClose();
    },
    onError: (error) => {
      if (error.code === 'ALREADY_SUBSCRIBED') {
        // Handle gracefully - maybe refresh subscription status
        queryClient.invalidateQueries({ queryKey: ['subscription', channelId] });
      }
    },
  });

  const tierPrices = { 1: 4.99, 2: 9.99, 3: 24.99 };
  const tierEmotes = { 1: 5, 2: 10, 3: 20 };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2>Subscribe to {channelName}</h2>

        <div className="tier-options">
          {([1, 2, 3] as const).map((tier) => (
            <button
              key={tier}
              className={`tier-option ${selectedTier === tier ? 'selected' : ''}`}
              onClick={() => setSelectedTier(tier)}
            >
              <span className="tier-name">Tier {tier}</span>
              <span className="tier-price">${tierPrices[tier]}/month</span>
              <span className="tier-emotes">{tierEmotes[tier]} emotes</span>
            </button>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={onClose} className="cancel-button">
            Cancel
          </button>
          <button
            onClick={() => subscribeMutation.mutate()}
            disabled={subscribeMutation.isPending}
            className="subscribe-button"
          >
            {subscribeMutation.isPending ? 'Subscribing...' : `Subscribe - $${tierPrices[selectedTier]}`}
          </button>
        </div>

        {subscribeMutation.isError && (
          <p className="error-message">
            {subscribeMutation.error.message}
          </p>
        )}
      </div>
    </div>
  );
}
```

---

## 6. Error Handling Strategy (4 minutes)

### Backend: Centralized Error Handler

```typescript
// backend/src/shared/errorHandler.ts
import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error('Error:', err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }

  // Database errors
  if (err.code === '23505') { // Unique violation
    return res.status(409).json({
      success: false,
      error: { code: 'DUPLICATE', message: 'Resource already exists' },
    });
  }

  // Default to 500
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}
```

### Frontend: Error Boundary and Retry

```typescript
// frontend/src/components/ErrorBoundary.tsx
import { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="error-fallback">
          <h2>Something went wrong</h2>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Query retry configuration
export const queryClientConfig = {
  defaultOptions: {
    queries: {
      retry: (failureCount: number, error: Error) => {
        // Don't retry on 4xx errors
        if (error instanceof ApiError && error.code.startsWith('4')) {
          return false;
        }
        return failureCount < 3;
      },
      retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  },
};
```

---

## 7. Summary (3 minutes)

### Full-Stack Integration Points

| Feature | Frontend | Backend | Shared |
|---------|----------|---------|--------|
| Chat | WebSocket hook, virtualized list | WebSocket server, Redis pub/sub | Message types, badge types |
| Stream Status | Polling + real-time updates | REST API + Redis cache | StreamStatus type |
| Subscriptions | Modal with idempotency key | Transactional handler | Subscription type |
| Error Handling | Error boundaries, retry logic | Centralized error handler | Error response format |

### Type Safety Wins

1. **Shared types** prevent API contract mismatches
2. **Discriminated unions** for WebSocket messages ensure exhaustive handling
3. **ApiResponse wrapper** provides consistent error handling

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| WebSocket per channel | Single connection + room joins | Simpler than connection-per-channel |
| Idempotency keys | Client-generated | Enables safe retries for subscriptions |
| Viewer count | Redis + polling | Real-time updates without per-viewer writes |
| Chat storage | Async write | Don't block message delivery on DB |

### What Would Be Different at Scale

1. **Type Generation**: Use OpenAPI/gRPC for automatic type generation
2. **Message Queues**: Kafka between chat pods for guaranteed delivery
3. **State Sync**: CRDT-based state for offline-first mobile apps
4. **Monitoring**: End-to-end tracing with OpenTelemetry
