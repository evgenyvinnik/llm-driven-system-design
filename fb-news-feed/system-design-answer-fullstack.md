# Facebook News Feed - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

---

## Introduction

"Today I'll design a personalized news feed system similar to Facebook's, taking a full-stack perspective. The core challenges span both domains: on the backend, we need to solve the write amplification problem for celebrities while maintaining low read latency; on the frontend, we need to render a performant virtualized feed with real-time updates. I'll focus on the integration points where frontend and backend work together - the API contract, WebSocket protocol, optimistic updates, and data consistency patterns."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the end-to-end requirements:

1. **Feed Generation**: Backend ranks and serves personalized posts, frontend renders infinite scroll
2. **Post Creation**: Frontend composer submits to API, backend fans out to followers
3. **Real-time Updates**: Backend pushes via WebSocket, frontend queues and displays
4. **Engagement**: Frontend shows optimistic likes/comments, backend validates and persists
5. **Follow System**: Frontend profile actions, backend updates social graph and backfills feed"

### Non-Functional Requirements

"End-to-end requirements:

- **Latency**: < 200ms from click to rendered feed (including network + render)
- **Consistency**: Eventual consistency for feed (< 10 seconds), optimistic UI makes it feel instant
- **Reliability**: Graceful degradation - offline viewing, retry with idempotency
- **Bundle + API**: Initial load < 3s on 3G connection"

---

## Step 2: System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React + Zustand)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   Feed UI    │  │   Composer   │  │  WebSocket   │  │   Optimistic │    │
│  │ (Virtualized)│  │    Modal     │  │    Hook      │  │    Updates   │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
└─────────┼─────────────────┼─────────────────┼─────────────────┼─────────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          API Gateway / Load Balancer                         │
│                     REST (HTTPS) + WebSocket (WSS)                          │
└─────────────────────────────────────────────────────────────────────────────┘
          │                 │                 │                 │
          ▼                 ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Services                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Feed Service │  │ Post Service │  │ WS Gateway   │  │ Engagement   │    │
│  │  (Ranking)   │  │  (Fan-out)   │  │ (Real-time)  │  │   Service    │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    Shared: Redis + PostgreSQL + Kafka                   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Shared Type Definitions

### TypeScript Types Package

"Creating a shared types package ensures API contract consistency:

```typescript
// packages/shared-types/src/index.ts

// ================ User Types ================
export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bio?: string;
  followerCount: number;
  followingCount: number;
  isCelebrity: boolean;  // >= 10K followers
  createdAt: string;     // ISO date
}

export interface UserProfile extends User {
  isFollowing: boolean;  // Viewer-specific
  mutualFriends: number;
}

// ================ Post Types ================
export type PostPrivacy = 'public' | 'friends';
export type PostType = 'text' | 'image' | 'video' | 'link';

export interface Post {
  id: string;
  authorId: string;
  author: UserSummary;  // Denormalized for display
  content: string;
  imageUrl?: string;
  postType: PostType;
  privacy: PostPrivacy;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;     // Viewer-specific
  createdAt: string;
  updatedAt: string;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

// ================ Comment Types ================
export interface Comment {
  id: string;
  postId: string;
  userId: string;
  user: UserSummary;
  content: string;
  likeCount: number;
  createdAt: string;
}

// ================ API Request/Response Types ================
export interface CreatePostRequest {
  content: string;
  imageUrl?: string;
  privacy: PostPrivacy;
}

export interface CreatePostResponse {
  post: Post;
  conflicts?: string[];  // If any validation warnings
}

export interface FeedResponse {
  posts: Post[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export interface CreateCommentRequest {
  content: string;
}

export interface EngagementUpdate {
  postId: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
}

// ================ WebSocket Message Types ================
export type ClientMessageType =
  | 'subscribe_feed'
  | 'unsubscribe_feed'
  | 'ping';

export type ServerMessageType =
  | 'new_post'
  | 'post_update'
  | 'engagement_update'
  | 'connection_ack'
  | 'pong'
  | 'error';

export interface ClientMessage {
  type: ClientMessageType;
  payload?: unknown;
  requestId?: string;
}

export interface ServerMessage {
  type: ServerMessageType;
  payload: unknown;
  timestamp: string;
  correlationId?: string;  // Matches requestId
}

export interface NewPostPayload {
  post: Post;
}

export interface EngagementUpdatePayload {
  postId: string;
  field: 'likeCount' | 'commentCount' | 'shareCount';
  delta: number;
  newValue: number;
}

// ================ API Error Types ================
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError };
```

---

## Step 4: REST API Design

### API Endpoints

```typescript
// Backend: routes/feed.ts
import { Router } from 'express';
import { FeedResponse, Post } from '@fb-clone/shared-types';

const router = Router();

/**
 * GET /api/v1/feed
 * Fetch personalized feed for authenticated user
 *
 * Query params:
 *   - cursor: string (optional) - Pagination cursor
 *   - limit: number (optional, default 20, max 50)
 *
 * Response: FeedResponse
 */
router.get('/feed', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { cursor, limit = 20 } = req.query;

  const feedResult = await feedService.getFeed(userId, {
    cursor: cursor as string,
    limit: Math.min(Number(limit), 50),
  });

  // Attach viewer-specific data (isLiked)
  const postsWithLikes = await engagementService.attachLikeStatus(
    feedResult.posts,
    userId
  );

  const response: FeedResponse = {
    posts: postsWithLikes,
    pagination: feedResult.pagination,
  };

  res.json({ success: true, data: response });
});

/**
 * POST /api/v1/posts
 * Create a new post
 *
 * Headers:
 *   - X-Idempotency-Key: string (required for retry safety)
 *
 * Body: CreatePostRequest
 * Response: CreatePostResponse
 */
router.post('/posts', authMiddleware, idempotencyMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { content, imageUrl, privacy } = req.body;

  // Validate
  if (!content && !imageUrl) {
    return res.status(400).json({
      success: false,
      error: { code: 'EMPTY_POST', message: 'Post must have content or image' }
    });
  }

  // Create post
  const post = await postService.createPost(userId, { content, imageUrl, privacy });

  // Trigger async fan-out
  await fanoutQueue.enqueue({
    type: 'new_post',
    postId: post.id,
    authorId: userId,
    createdAt: post.createdAt,
  });

  res.status(201).json({ success: true, data: { post } });
});

/**
 * POST /api/v1/posts/:postId/like
 * Like a post (idempotent)
 */
router.post('/posts/:postId/like', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const { postId } = req.params;

  const result = await engagementService.likePost(postId, userId);

  // Broadcast engagement update
  if (result.changed) {
    await realtimeService.broadcastEngagementUpdate(postId, 'likeCount', 1);
  }

  res.json({ success: true, data: { liked: true, likeCount: result.newCount } });
});

export default router;
```

### Frontend API Client

```typescript
// Frontend: api/feed.ts
import { FeedResponse, CreatePostRequest, Post, ApiResponse } from '@fb-clone/shared-types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'include', // Send session cookie
  });

  const json = await response.json() as ApiResponse<T>;

  if (!json.success) {
    throw new ApiError(json.error.code, json.error.message);
  }

  return json.data;
}

export const feedApi = {
  getFeed: (cursor?: string): Promise<FeedResponse> =>
    request(`/feed${cursor ? `?cursor=${cursor}` : ''}`),

  createPost: (data: CreatePostRequest, idempotencyKey: string): Promise<{ post: Post }> =>
    request('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
    }),

  likePost: (postId: string): Promise<{ liked: boolean; likeCount: number }> =>
    request(`/posts/${postId}/like`, { method: 'POST' }),

  unlikePost: (postId: string): Promise<{ liked: boolean; likeCount: number }> =>
    request(`/posts/${postId}/like`, { method: 'DELETE' }),
};

class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
```

---

## Step 5: WebSocket Protocol Design

### Backend WebSocket Gateway

```typescript
// Backend: services/websocketGateway.ts
import WebSocket from 'ws';
import { Redis } from 'ioredis';
import {
  ClientMessage,
  ServerMessage,
  NewPostPayload,
  EngagementUpdatePayload,
} from '@fb-clone/shared-types';

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  subscribedFeeds: Set<string>;
}

export class WebSocketGateway {
  private clients = new Map<string, ConnectedClient>();
  private redis: Redis;
  private subscriber: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
    this.subscriber = redis.duplicate();
    this.setupRedisSubscriber();
  }

  private setupRedisSubscriber() {
    // Subscribe to all user feed channels
    this.subscriber.psubscribe('feed_updates:*');
    this.subscriber.psubscribe('celebrity_updates:*');

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      this.handleRedisMessage(channel, message);
    });
  }

  handleConnection(ws: WebSocket, userId: string) {
    const clientId = `${userId}:${Date.now()}`;

    const client: ConnectedClient = {
      ws,
      userId,
      subscribedFeeds: new Set(),
    };

    this.clients.set(clientId, client);

    // Send connection acknowledgment
    this.send(ws, {
      type: 'connection_ack',
      payload: { clientId },
      timestamp: new Date().toISOString(),
    });

    // Auto-subscribe to user's feed updates
    client.subscribedFeeds.add(`feed_updates:${userId}`);

    // Subscribe to followed celebrities
    this.subscribeToFollowedCelebrities(client);

    ws.on('message', (data) => this.handleMessage(client, data.toString()));
    ws.on('close', () => this.handleDisconnect(clientId));
    ws.on('error', (err) => console.error('WebSocket error:', err));
  }

  private async subscribeToFollowedCelebrities(client: ConnectedClient) {
    const celebrities = await this.getCelebrityFollows(client.userId);
    for (const celebId of celebrities) {
      client.subscribedFeeds.add(`celebrity_updates:${celebId}`);
    }
  }

  private handleMessage(client: ConnectedClient, data: string) {
    try {
      const message: ClientMessage = JSON.parse(data);

      switch (message.type) {
        case 'ping':
          this.send(client.ws, {
            type: 'pong',
            payload: {},
            timestamp: new Date().toISOString(),
            correlationId: message.requestId,
          });
          break;

        case 'subscribe_feed':
          // Handle additional subscriptions
          const { userId } = message.payload as { userId: string };
          client.subscribedFeeds.add(`feed_updates:${userId}`);
          break;

        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  private handleRedisMessage(channel: string, message: string) {
    const payload = JSON.parse(message);

    // Find all clients subscribed to this channel
    for (const client of this.clients.values()) {
      if (client.subscribedFeeds.has(channel)) {
        if (channel.startsWith('feed_updates:')) {
          this.send(client.ws, {
            type: 'new_post',
            payload: payload as NewPostPayload,
            timestamp: new Date().toISOString(),
          });
        } else if (channel.startsWith('celebrity_updates:')) {
          this.send(client.ws, {
            type: 'new_post',
            payload: payload as NewPostPayload,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  async broadcastEngagementUpdate(postId: string, field: string, delta: number) {
    const payload: EngagementUpdatePayload = {
      postId,
      field: field as 'likeCount' | 'commentCount' | 'shareCount',
      delta,
      newValue: await this.getEngagementCount(postId, field),
    };

    // Publish to Redis for all instances
    await this.redis.publish(`engagement:${postId}`, JSON.stringify(payload));
  }

  private send(ws: WebSocket, message: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private handleDisconnect(clientId: string) {
    this.clients.delete(clientId);
  }
}
```

### Frontend WebSocket Hook

```typescript
// Frontend: hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { useFeedStore } from '../stores/feedStore';
import {
  ServerMessage,
  ClientMessage,
  NewPostPayload,
  EngagementUpdatePayload,
} from '@fb-clone/shared-types';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const reconnectAttempts = useRef(0);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout>();

  const { handleNewPost, handleEngagementUpdate } = useFeedStore();

  const sendMessage = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const connect = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts.current = 0;

      // Start heartbeat
      heartbeatIntervalRef.current = setInterval(() => {
        sendMessage({ type: 'ping', requestId: `ping-${Date.now()}` });
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);

        switch (message.type) {
          case 'new_post':
            const newPostPayload = message.payload as NewPostPayload;
            handleNewPost(newPostPayload.post);
            break;

          case 'engagement_update':
            const engagementPayload = message.payload as EngagementUpdatePayload;
            handleEngagementUpdate(
              engagementPayload.postId,
              engagementPayload.field,
              engagementPayload.newValue
            );
            break;

          case 'pong':
            // Heartbeat acknowledged
            break;

          case 'error':
            console.error('WebSocket error from server:', message.payload);
            break;
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      clearInterval(heartbeatIntervalRef.current);
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [handleNewPost, handleEngagementUpdate, sendMessage]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttempts.current >= 10) {
      console.error('Max reconnection attempts reached');
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... max 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
    reconnectAttempts.current += 1;

    reconnectTimeoutRef.current = setTimeout(() => {
      console.log(`Reconnecting (attempt ${reconnectAttempts.current})...`);
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      wsRef.current?.close();
      clearTimeout(reconnectTimeoutRef.current);
      clearInterval(heartbeatIntervalRef.current);
    };
  }, [connect]);

  return { sendMessage };
}
```

---

## Step 6: Optimistic Updates with Reconciliation

### Frontend Store with Optimistic Updates

```typescript
// Frontend: stores/feedStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { Post } from '@fb-clone/shared-types';
import { feedApi } from '../api/feed';
import { v4 as uuidv4 } from 'uuid';

interface PendingAction {
  id: string;
  type: 'like' | 'unlike' | 'create_post';
  postId?: string;
  originalState?: Partial<Post>;
  timestamp: number;
}

interface FeedState {
  posts: Post[];
  postsById: Record<string, Post>;
  pendingActions: Map<string, PendingAction>;

  // Actions with optimistic updates
  likePost: (postId: string) => Promise<void>;
  unlikePost: (postId: string) => Promise<void>;
  createPost: (content: string, imageUrl?: string) => Promise<Post>;

  // Server reconciliation
  handleEngagementUpdate: (postId: string, field: string, newValue: number) => void;
  handleNewPost: (post: Post) => void;
}

export const useFeedStore = create<FeedState>()(
  immer((set, get) => ({
    posts: [],
    postsById: {},
    pendingActions: new Map(),

    likePost: async (postId) => {
      const actionId = uuidv4();
      const post = get().postsById[postId];

      if (!post || post.isLiked) return;

      // Record pending action with original state
      set((state) => {
        state.pendingActions.set(actionId, {
          id: actionId,
          type: 'like',
          postId,
          originalState: { isLiked: post.isLiked, likeCount: post.likeCount },
          timestamp: Date.now(),
        });

        // Optimistic update
        const p = state.postsById[postId];
        p.isLiked = true;
        p.likeCount += 1;
      });

      try {
        await feedApi.likePost(postId);

        // Success - remove pending action
        set((state) => {
          state.pendingActions.delete(actionId);
        });
      } catch (error) {
        // Rollback on failure
        set((state) => {
          const action = state.pendingActions.get(actionId);
          if (action?.originalState) {
            const p = state.postsById[postId];
            p.isLiked = action.originalState.isLiked!;
            p.likeCount = action.originalState.likeCount!;
          }
          state.pendingActions.delete(actionId);
        });

        throw error;
      }
    },

    createPost: async (content, imageUrl) => {
      const idempotencyKey = uuidv4();
      const tempId = `temp-${idempotencyKey}`;
      const currentUser = useUserStore.getState().currentUser!;

      // Create optimistic post
      const optimisticPost: Post = {
        id: tempId,
        authorId: currentUser.id,
        author: {
          id: currentUser.id,
          username: currentUser.username,
          displayName: currentUser.displayName,
          avatarUrl: currentUser.avatarUrl,
        },
        content,
        imageUrl,
        postType: imageUrl ? 'image' : 'text',
        privacy: 'public',
        likeCount: 0,
        commentCount: 0,
        shareCount: 0,
        isLiked: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Add optimistic post at top
      set((state) => {
        state.posts.unshift(optimisticPost);
        state.postsById[tempId] = optimisticPost;
        state.pendingActions.set(tempId, {
          id: tempId,
          type: 'create_post',
          timestamp: Date.now(),
        });
      });

      try {
        const { post: realPost } = await feedApi.createPost(
          { content, imageUrl, privacy: 'public' },
          idempotencyKey
        );

        // Replace temp post with real post
        set((state) => {
          const index = state.posts.findIndex(p => p.id === tempId);
          if (index !== -1) {
            state.posts[index] = realPost;
          }
          delete state.postsById[tempId];
          state.postsById[realPost.id] = realPost;
          state.pendingActions.delete(tempId);
        });

        return realPost;
      } catch (error) {
        // Remove optimistic post on failure
        set((state) => {
          state.posts = state.posts.filter(p => p.id !== tempId);
          delete state.postsById[tempId];
          state.pendingActions.delete(tempId);
        });

        throw error;
      }
    },

    handleEngagementUpdate: (postId, field, newValue) => {
      set((state) => {
        const post = state.postsById[postId];
        if (!post) return;

        // Check if we have a pending action for this post
        const hasPendingAction = Array.from(state.pendingActions.values())
          .some(action => action.postId === postId);

        if (hasPendingAction) {
          // Don't override optimistic update - server will catch up
          return;
        }

        // Apply server value
        (post as any)[field] = newValue;
      });
    },

    handleNewPost: (post) => {
      set((state) => {
        // Skip if already have this post (from our own optimistic update)
        if (state.postsById[post.id]) return;

        // Don't interrupt scrolling - queue for "new posts" banner
        if (window.scrollY > 200) {
          state.pendingUpdates.push(post);
          state.newPostsCount += 1;
        } else {
          state.posts.unshift(post);
          state.postsById[post.id] = post;
        }
      });
    },
  }))
);
```

---

## Step 7: Idempotency Implementation

### Backend Idempotency Middleware

```typescript
// Backend: middleware/idempotency.ts
import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const IDEMPOTENCY_TTL = 86400; // 24 hours

interface CachedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only apply to mutating requests
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['x-idempotency-key'] as string;

  if (!idempotencyKey) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key header is required',
      },
    });
  }

  // Create composite key including user and path
  const userId = req.user?.id || 'anonymous';
  const compositeKey = `idempotency:${userId}:${req.path}:${idempotencyKey}`;

  (async () => {
    try {
      // Check for existing response
      const cached = await redis.get(compositeKey);

      if (cached) {
        const response: CachedResponse = JSON.parse(cached);

        // Return cached response
        Object.entries(response.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        res.setHeader('X-Idempotency-Replayed', 'true');

        return res.status(response.status).json(response.body);
      }

      // Capture the response
      const originalJson = res.json.bind(res);
      res.json = function(body: unknown) {
        // Cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const cacheData: CachedResponse = {
            status: res.statusCode,
            body,
            headers: {
              'Content-Type': res.getHeader('Content-Type') as string || 'application/json',
            },
          };

          redis.setex(compositeKey, IDEMPOTENCY_TTL, JSON.stringify(cacheData))
            .catch(err => console.error('Failed to cache idempotent response:', err));
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      console.error('Idempotency check failed:', error);
      // Fail open - allow request to proceed
      next();
    }
  })();
}
```

### Frontend Retry with Idempotency

```typescript
// Frontend: api/client.ts
import { v4 as uuidv4 } from 'uuid';

interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const defaultRetryConfig: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

export async function mutationRequest<T>(
  path: string,
  options: RequestInit,
  retryConfig = defaultRetryConfig
): Promise<T> {
  // Generate idempotency key once per logical request
  const idempotencyKey = uuidv4();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
          ...options.headers,
        },
        credentials: 'include',
      });

      const json = await response.json();

      // Check if replayed
      if (response.headers.get('X-Idempotency-Replayed') === 'true') {
        console.log(`Request replayed from idempotency cache: ${idempotencyKey}`);
      }

      if (!json.success) {
        // Don't retry client errors (4xx)
        if (response.status >= 400 && response.status < 500) {
          throw new ApiError(json.error.code, json.error.message);
        }
        throw new Error(json.error.message);
      }

      return json.data;
    } catch (error) {
      lastError = error as Error;

      // Don't retry if this is a client error
      if (error instanceof ApiError) {
        throw error;
      }

      if (attempt < retryConfig.maxRetries) {
        const delay = Math.min(
          retryConfig.baseDelay * Math.pow(2, attempt),
          retryConfig.maxDelay
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## Step 8: Feed Caching Integration

### Backend Cache-Aside with Write-Through

```typescript
// Backend: services/feedService.ts
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { Post, FeedResponse } from '@fb-clone/shared-types';

export class FeedService {
  constructor(
    private redis: Redis,
    private db: Pool,
    private rankingService: RankingService
  ) {}

  async getFeed(userId: string, options: { cursor?: string; limit: number }): Promise<FeedResponse> {
    const { cursor, limit } = options;

    // Step 1: Try cache
    const cacheKey = `feed:${userId}`;
    let postIds = await this.getCachedFeed(cacheKey, limit * 2);

    // Step 2: Cache miss - rebuild from DB
    if (!postIds.length) {
      postIds = await this.buildFeedFromDb(userId);
      await this.cacheFeed(cacheKey, postIds);
    }

    // Step 3: Get celebrity posts (pull model)
    const celebrityPostIds = await this.getCelebrityPosts(userId);
    const allPostIds = this.mergeAndDedupe(postIds, celebrityPostIds);

    // Step 4: Fetch post data
    const posts = await this.batchGetPosts(allPostIds);

    // Step 5: Filter by privacy
    const visiblePosts = await this.filterByPrivacy(posts, userId);

    // Step 6: Apply ranking
    const rankedPosts = await this.rankingService.rank(userId, visiblePosts);

    // Step 7: Paginate
    return this.paginateFeed(rankedPosts, cursor, limit);
  }

  private async getCachedFeed(key: string, limit: number): Promise<string[]> {
    return await this.redis.zrevrange(key, 0, limit - 1);
  }

  private async cacheFeed(key: string, postIds: string[]): Promise<void> {
    if (postIds.length === 0) return;

    const pipeline = this.redis.pipeline();

    // Add posts with their creation timestamps as scores
    for (const postId of postIds) {
      const timestamp = this.extractTimestamp(postId);
      pipeline.zadd(key, timestamp, postId);
    }

    // Set TTL
    pipeline.expire(key, 86400); // 24 hours

    await pipeline.exec();
  }

  async invalidateFeedCache(userId: string): Promise<void> {
    await this.redis.del(`feed:${userId}`);
  }

  async warmFeedOnLogin(userId: string): Promise<void> {
    const cacheKey = `feed:${userId}`;

    // Check if cache exists and is fresh
    const ttl = await this.redis.ttl(cacheKey);
    if (ttl > 3600) return; // Still has > 1 hour, skip warming

    // Rebuild cache in background
    setImmediate(async () => {
      const postIds = await this.buildFeedFromDb(userId);
      await this.cacheFeed(cacheKey, postIds);
    });
  }
}
```

### Frontend Cache with Persistence

```typescript
// Frontend: stores/feedStore.ts - persistence configuration
import { persist } from 'zustand/middleware';

export const useFeedStore = create<FeedState>()(
  persist(
    immer((set, get) => ({
      // ... state and actions
    })),
    {
      name: 'feed-cache',
      storage: {
        getItem: async (name) => {
          const value = localStorage.getItem(name);
          if (!value) return null;

          const parsed = JSON.parse(value);

          // Check cache freshness (max 1 hour)
          if (Date.now() - parsed.timestamp > 3600000) {
            localStorage.removeItem(name);
            return null;
          }

          return parsed.state;
        },
        setItem: async (name, value) => {
          localStorage.setItem(name, JSON.stringify({
            state: value,
            timestamp: Date.now(),
          }));
        },
        removeItem: async (name) => {
          localStorage.removeItem(name);
        },
      },
      partialize: (state) => ({
        // Only persist essential data
        posts: state.posts.slice(0, 20), // Keep only recent 20 posts
        postsById: Object.fromEntries(
          Object.entries(state.postsById).slice(0, 20)
        ),
      }),
    }
  )
);
```

---

## Step 9: End-to-End Flow Example

### Post Creation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. User clicks "Post" in Composer                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│   Frontend:                                                                  │
│   - Generate idempotencyKey = uuid()                                        │
│   - Create optimistic post with temp ID                                     │
│   - Add to posts array at index 0                                           │
│   - Show post in feed immediately                                           │
│   - Set pending action for rollback                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. POST /api/v1/posts (with X-Idempotency-Key)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│   Backend:                                                                   │
│   - Check idempotency cache → miss                                          │
│   - Validate content                                                         │
│   - Insert into PostgreSQL (posts table)                                    │
│   - Enqueue fan-out event to Kafka                                          │
│   - Cache response with idempotencyKey                                      │
│   - Return 201 with post data                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Response received                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│   Frontend:                                                                  │
│   - Replace temp post with real post                                        │
│   - Update postsById with real ID                                           │
│   - Clear pending action                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Fan-out (async background)                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│   Backend Fan-out Worker:                                                   │
│   - Consume Kafka event                                                     │
│   - Check author follower count                                             │
│   - If < 10K: Push to all followers' Redis feeds                           │
│   - If >= 10K: Add to celebrity_posts sorted set                           │
│   - Publish to Redis pub/sub for online users                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. WebSocket notification                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│   Backend WebSocket Gateway:                                                │
│   - Receive Redis pub/sub message                                           │
│   - Find subscribed clients                                                 │
│   - Send "new_post" message to each                                         │
│                                                                              │
│   Frontend (other users):                                                   │
│   - Receive WebSocket message                                               │
│   - If scrolled: Add to pendingUpdates, show "1 new post" banner           │
│   - If at top: Insert post into feed                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Step 10: Integration Testing Strategy

### E2E Test Example

```typescript
// tests/e2e/feed.spec.ts
import { test, expect } from '@playwright/test';
import { setupTestUser, cleanupTestData } from './helpers';

test.describe('Feed Integration', () => {
  let testUser: { token: string; userId: string };

  test.beforeAll(async () => {
    testUser = await setupTestUser();
  });

  test.afterAll(async () => {
    await cleanupTestData(testUser.userId);
  });

  test('creates post and sees it in feed', async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.fill('[name="username"]', 'testuser');
    await page.fill('[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    // Wait for feed to load
    await page.waitForSelector('[data-testid="feed"]');

    // Create post
    const postContent = `Test post ${Date.now()}`;
    await page.fill('[data-testid="composer-input"]', postContent);
    await page.click('[data-testid="post-button"]');

    // Verify optimistic update (immediate)
    await expect(page.locator(`text="${postContent}"`)).toBeVisible();

    // Verify post persists after refresh
    await page.reload();
    await page.waitForSelector('[data-testid="feed"]');
    await expect(page.locator(`text="${postContent}"`)).toBeVisible();
  });

  test('handles like with optimistic update and rollback', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="post-card"]');

    const likeButton = page.locator('[data-testid="like-button"]').first();
    const likeCount = page.locator('[data-testid="like-count"]').first();

    const initialCount = await likeCount.textContent();

    // Click like
    await likeButton.click();

    // Verify optimistic update (immediate)
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true');
    await expect(likeCount).toHaveText(String(Number(initialCount) + 1));

    // Simulate network failure for rollback test
    await page.route('**/api/v1/posts/*/like', route => route.abort());

    // Click unlike (will fail)
    await likeButton.click();

    // Should rollback to liked state
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('receives real-time updates via WebSocket', async ({ page, context }) => {
    // Open two browser contexts
    const page2 = await context.newPage();

    // Login both pages
    await Promise.all([
      loginPage(page, 'user1'),
      loginPage(page2, 'user2'),
    ]);

    // User1 follows User2
    await page.goto('/profile/user2');
    await page.click('[data-testid="follow-button"]');

    // User2 creates a post
    await page2.goto('/');
    const postContent = `Real-time test ${Date.now()}`;
    await page2.fill('[data-testid="composer-input"]', postContent);
    await page2.click('[data-testid="post-button"]');

    // User1 should see the new post (via WebSocket or banner)
    await page.waitForSelector(`text="${postContent}"`, { timeout: 10000 });
  });
});
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| **API Style** | REST with JSON | GraphQL | Simpler caching, familiar patterns, cursor pagination |
| **Shared Types** | TypeScript package | OpenAPI/Swagger | Direct type sharing, compile-time safety |
| **Real-time** | WebSocket | Server-Sent Events | Bidirectional for future features (typing indicators) |
| **Optimistic Updates** | Zustand with rollback | React Query mutations | More control over complex multi-step updates |
| **Idempotency** | Client-generated key | Server-generated | Enables retry without round-trip |
| **State Persistence** | localStorage | IndexedDB | Simpler API, sufficient for feed cache |

---

## Future Enhancements

1. **Service Worker**: Background sync for offline post creation
2. **GraphQL Subscriptions**: Replace WebSocket for more structured real-time
3. **Conflict Resolution**: CRDT-based merge for collaborative features
4. **Request Batching**: Combine multiple API calls into single request
5. **Prefetching**: Anticipate next page of feed during scroll
6. **A/B Testing**: Feature flags shared between frontend and backend

---

## Summary

"For the Facebook News Feed full-stack architecture:

1. **Shared Types Package**: Single source of truth for API contracts, WebSocket messages, and domain models ensures type safety across the stack

2. **Optimistic Updates with Rollback**: Frontend immediately reflects user actions; pending action map tracks original state for rollback on failure

3. **Idempotency Pattern**: Client generates idempotency key, backend caches responses - enables safe retries without duplicate posts

4. **WebSocket Protocol**: Structured message types with correlation IDs enable reliable real-time updates without disrupting scroll position

5. **Cache Strategy**: Backend write-through to Redis on fan-out, frontend persists recent posts to localStorage for instant initial render

6. **Graceful Degradation**: Each layer has fallbacks - cache miss hits DB, WebSocket disconnect falls back to polling, network failure triggers rollback

The key full-stack insight is that optimistic UI and idempotency work together - the frontend can show instant feedback and retry on failure, while the backend ensures exactly-once semantics through the idempotency key. The shared types package eliminates an entire class of integration bugs by ensuring both sides speak the same language."
