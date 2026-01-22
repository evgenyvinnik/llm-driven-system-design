# Facebook Live Comments - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

## Introduction

"Today I'll design a real-time commenting system for live video streams, similar to Facebook Live or YouTube Live. As a full-stack engineer, I'll focus on the integration points between frontend and backend - the WebSocket protocol design, shared type definitions, end-to-end latency optimization, and how frontend state management works with backend batching. This involves interesting problems around real-time synchronization and graceful degradation."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm the end-to-end experience:

1. **Real-Time Comments**: Users post comments that appear for all viewers within 2-3 seconds
2. **Batched Delivery**: Comments batched for efficiency, reactions aggregated
3. **Connection Resilience**: Comments queued offline, delivered on reconnect
4. **Rate Limiting**: Frontend prevents spam, backend enforces limits
5. **Graceful Degradation**: Experience adapts based on stream popularity

Should I focus on the comments feature or also cover video playback integration?"

### Non-Functional Requirements

"For a full-stack live comments system:

- **E2E Latency**: Comment posted to displayed: p95 < 500ms
- **Offline Support**: Queue up to 10 pending comments
- **Type Safety**: Shared TypeScript types between frontend and backend
- **Testability**: Integration tests for WebSocket message flows"

---

## Step 2: System Architecture Overview

```
+-------------------------------------------------------------------------+
|                              Full-Stack View                             |
+-------------------------------------------------------------------------+
|                                                                          |
|  FRONTEND                           |  BACKEND                           |
|  +-------------------------------+  |  +-------------------------------+ |
|  |  React App                    |  |  |  API Gateway                  | |
|  |  +--------------------------+ |  |  |  +--------------------------+ | |
|  |  |  useLiveStream Hook      | |  |  |  |  WebSocket Server        | | |
|  |  |  - WebSocket connection  |<----->|  |  - Connection pool       | | |
|  |  |  - State synchronization | |  |  |  |  - Message routing       | | |
|  |  +--------------------------+ |  |  |  +--------------------------+ | |
|  |  |  Zustand Store           | |  |  |  |  CommentService          | | |
|  |  |  - comments[]            | |  |  |  |  - Rate limiting         | | |
|  |  |  - pendingComments[]     | |  |  |  |  - Batching             | | |
|  |  |  - connection status     | |  |  |  |  - Persistence          | | |
|  |  +--------------------------+ |  |  |  +--------------------------+ | |
|  +-------------------------------+  |  +-------------------------------+ |
|                                     |                                    |
|  Shared: @acme/live-comments-types  |                                    |
|                                                                          |
+-------------------------------------------------------------------------+
```

---

## Step 3: Shared Type Definitions

### WebSocket Message Protocol

```typescript
// packages/shared-types/src/websocket.ts

// Client -> Server messages
export interface JoinStreamMessage {
  type: 'join_stream';
  payload: {
    streamId: string;
    userId: string;
    lastSeenCommentId?: string; // For resuming from disconnect
  };
}

export interface LeaveStreamMessage {
  type: 'leave_stream';
  payload: Record<string, never>;
}

export interface PostCommentMessage {
  type: 'post_comment';
  payload: {
    streamId: string;
    content: string;
    idempotencyKey: string; // Client-generated for deduplication
    parentId?: string;
  };
}

export interface ReactMessage {
  type: 'react';
  payload: {
    streamId: string;
    reactionType: ReactionType;
    commentId?: string; // If reacting to specific comment
  };
}

export type ClientMessage =
  | JoinStreamMessage
  | LeaveStreamMessage
  | PostCommentMessage
  | ReactMessage;

// Server -> Client messages
export interface CommentsBatchMessage {
  type: 'comments_batch';
  payload: {
    streamId: string;
    comments: Comment[];
    isBackfill: boolean; // True if historical, false if real-time
  };
}

export interface ReactionsBatchMessage {
  type: 'reactions_batch';
  payload: {
    streamId: string;
    counts: Record<ReactionType, number>;
    timestamp: number;
  };
}

export interface ViewerCountMessage {
  type: 'viewer_count';
  payload: {
    streamId: string;
    count: number;
  };
}

export interface ErrorMessage {
  type: 'error';
  payload: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface AckMessage {
  type: 'ack';
  payload: {
    idempotencyKey: string;
    commentId: string;
    status: 'accepted' | 'rate_limited' | 'rejected';
  };
}

export type ServerMessage =
  | CommentsBatchMessage
  | ReactionsBatchMessage
  | ViewerCountMessage
  | ErrorMessage
  | AckMessage;

// Shared types
export interface Comment {
  id: string;
  streamId: string;
  userId: string;
  username: string;
  avatarUrl: string;
  content: string;
  parentId?: string;
  isHighlighted: boolean;
  isPinned: boolean;
  createdAt: number;
}

export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

export enum ErrorCode {
  RATE_LIMITED = 'RATE_LIMITED',
  BANNED = 'BANNED',
  CONTENT_VIOLATION = 'CONTENT_VIOLATION',
  STREAM_ENDED = 'STREAM_ENDED',
  UNAUTHORIZED = 'UNAUTHORIZED',
}
```

---

## Step 4: Backend WebSocket Server

### WebSocket Gateway Implementation

```typescript
// backend/src/gateway/websocketGateway.ts

import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';
import {
  ClientMessage,
  ServerMessage,
  Comment,
  ErrorCode,
} from '@acme/live-comments-types';

interface ConnectionContext {
  ws: WebSocket;
  userId: string;
  streamId: string | null;
  joinedAt: number;
}

export class WebSocketGateway {
  private wss: WebSocketServer;
  private connections: Map<WebSocket, ConnectionContext> = new Map();
  private streamConnections: Map<string, Set<WebSocket>> = new Map();
  private redis: Redis;
  private subscriber: Redis;
  private batchers: Map<string, CommentBatcher> = new Map();

  constructor(server: Server, redis: Redis) {
    this.wss = new WebSocketServer({ server });
    this.redis = redis;
    this.subscriber = redis.duplicate();

    this.setupWebSocketServer();
    this.setupRedisSubscriber();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws, req) => {
      const userId = this.extractUserId(req);

      const context: ConnectionContext = {
        ws,
        userId,
        streamId: null,
        joinedAt: Date.now(),
      };

      this.connections.set(ws, context);

      ws.on('message', (data) => this.handleMessage(ws, data));
      ws.on('close', () => this.handleDisconnect(ws));
      ws.on('error', (err) => this.handleError(ws, err));

      // Start heartbeat
      this.startHeartbeat(ws);
    });
  }

  private async handleMessage(ws: WebSocket, data: Buffer): Promise<void> {
    const context = this.connections.get(ws);
    if (!context) return;

    try {
      const message: ClientMessage = JSON.parse(data.toString());

      switch (message.type) {
        case 'join_stream':
          await this.handleJoinStream(ws, context, message.payload);
          break;

        case 'leave_stream':
          await this.handleLeaveStream(ws, context);
          break;

        case 'post_comment':
          await this.handlePostComment(ws, context, message.payload);
          break;

        case 'react':
          await this.handleReact(ws, context, message.payload);
          break;
      }
    } catch (error) {
      this.sendError(ws, ErrorCode.UNAUTHORIZED, 'Invalid message format');
    }
  }

  private async handleJoinStream(
    ws: WebSocket,
    context: ConnectionContext,
    payload: JoinStreamMessage['payload']
  ): Promise<void> {
    const { streamId, lastSeenCommentId } = payload;

    // Leave previous stream if any
    if (context.streamId) {
      await this.handleLeaveStream(ws, context);
    }

    // Check if user is banned
    const isBanned = await this.checkBan(context.userId, streamId);
    if (isBanned) {
      this.sendError(ws, ErrorCode.BANNED, 'You are banned from this stream');
      return;
    }

    // Add to stream connections
    context.streamId = streamId;
    if (!this.streamConnections.has(streamId)) {
      this.streamConnections.set(streamId, new Set());
      await this.subscribeToStream(streamId);
    }
    this.streamConnections.get(streamId)!.add(ws);

    // Initialize batcher for stream if needed
    if (!this.batchers.has(streamId)) {
      const batcher = new CommentBatcher(streamId, this.redis);
      this.batchers.set(streamId, batcher);
      batcher.start();
    }

    // Update viewer count
    await this.updateViewerCount(streamId, 1);

    // Send backfill of recent comments
    await this.sendBackfill(ws, streamId, lastSeenCommentId);
  }

  private async handlePostComment(
    ws: WebSocket,
    context: ConnectionContext,
    payload: PostCommentMessage['payload']
  ): Promise<void> {
    const { streamId, content, idempotencyKey } = payload;

    if (context.streamId !== streamId) {
      this.sendError(ws, ErrorCode.UNAUTHORIZED, 'Not joined to this stream');
      return;
    }

    // Check idempotency
    const existing = await this.redis.get(`idem:${idempotencyKey}`);
    if (existing) {
      this.sendAck(ws, idempotencyKey, existing, 'accepted');
      return;
    }

    // Rate limiting
    const allowed = await this.rateLimiter.allow(context.userId, streamId);
    if (!allowed) {
      this.sendAck(ws, idempotencyKey, '', 'rate_limited');
      return;
    }

    // Content validation
    if (this.contentFilter.containsViolation(content)) {
      this.sendAck(ws, idempotencyKey, '', 'rejected');
      return;
    }

    // Create comment
    const comment: Comment = {
      id: this.idGenerator.generate(),
      streamId,
      userId: context.userId,
      username: await this.getUserName(context.userId),
      avatarUrl: await this.getAvatarUrl(context.userId),
      content,
      isHighlighted: false,
      isPinned: false,
      createdAt: Date.now(),
    };

    // Store idempotency key
    await this.redis.setex(`idem:${idempotencyKey}`, 300, comment.id);

    // Add to batcher
    const batcher = this.batchers.get(streamId);
    batcher?.addComment(comment);

    // Persist asynchronously
    this.persistComment(comment);

    // Send acknowledgment
    this.sendAck(ws, idempotencyKey, comment.id, 'accepted');
  }

  private async sendBackfill(
    ws: WebSocket,
    streamId: string,
    lastSeenCommentId?: string
  ): Promise<void> {
    // Fetch recent comments
    let comments: Comment[];

    if (lastSeenCommentId) {
      // Resume from where user left off
      comments = await this.commentService.getCommentsSince(
        streamId,
        lastSeenCommentId,
        50
      );
    } else {
      // Fresh join - get last 50
      comments = await this.commentService.getRecentComments(streamId, 50);
    }

    const message: CommentsBatchMessage = {
      type: 'comments_batch',
      payload: {
        streamId,
        comments,
        isBackfill: true,
      },
    };

    ws.send(JSON.stringify(message));
  }

  private setupRedisSubscriber(): void {
    this.subscriber.on('message', (channel, data) => {
      // channel format: stream:{streamId}:comments or stream:{streamId}:reactions
      const [, streamId, type] = channel.split(':');

      const connections = this.streamConnections.get(streamId);
      if (!connections) return;

      // Broadcast to all connections for this stream
      const message = JSON.parse(data);
      const payload = JSON.stringify(message);

      connections.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      });
    });
  }

  private async subscribeToStream(streamId: string): Promise<void> {
    await this.subscriber.subscribe(
      `stream:${streamId}:comments`,
      `stream:${streamId}:reactions`
    );
  }

  private sendAck(
    ws: WebSocket,
    idempotencyKey: string,
    commentId: string,
    status: 'accepted' | 'rate_limited' | 'rejected'
  ): void {
    const message: AckMessage = {
      type: 'ack',
      payload: { idempotencyKey, commentId, status },
    };
    ws.send(JSON.stringify(message));
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    const errorMessage: ErrorMessage = {
      type: 'error',
      payload: { code, message, retryable: code === ErrorCode.RATE_LIMITED },
    };
    ws.send(JSON.stringify(errorMessage));
  }
}
```

---

## Step 5: Frontend WebSocket Integration

### useLiveStream Hook

```typescript
// frontend/src/hooks/useLiveStream.ts

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useLiveStreamStore } from '../stores/liveStreamStore';
import {
  ClientMessage,
  ServerMessage,
  Comment,
  ErrorCode,
} from '@acme/live-comments-types';
import { v4 as uuidv4 } from 'uuid';

interface UseLiveStreamOptions {
  streamId: string;
  userId: string;
}

interface PendingComment {
  idempotencyKey: string;
  content: string;
  addedAt: number;
  retryCount: number;
}

export function useLiveStream({ streamId, userId }: UseLiveStreamOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const pendingCommentsRef = useRef<Map<string, PendingComment>>(new Map());
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const {
    addCommentBatch,
    addReactionBurst,
    setViewerCount,
    setConnectionStatus,
    updateCommentStatus,
    connection,
  } = useLiveStreamStore();

  // Connect to WebSocket
  const connect = useCallback(() => {
    setConnectionStatus('connecting');

    const ws = new WebSocket(`wss://api.example.com/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus('connected');

      // Join stream
      const joinMessage: ClientMessage = {
        type: 'join_stream',
        payload: {
          streamId,
          userId,
          lastSeenCommentId: useLiveStreamStore.getState().lastSeenCommentId,
        },
      };
      ws.send(JSON.stringify(joinMessage));

      // Retry pending comments
      retryPendingComments();
    };

    ws.onmessage = (event) => {
      const message: ServerMessage = JSON.parse(event.data);
      handleServerMessage(message);
    };

    ws.onclose = (event) => {
      if (event.code !== 1000) {
        setConnectionStatus('reconnecting');
        scheduleReconnect();
      } else {
        setConnectionStatus('disconnected');
      }
    };

    ws.onerror = () => {
      setConnectionStatus('reconnecting');
    };
  }, [streamId, userId, setConnectionStatus]);

  // Handle server messages
  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case 'comments_batch':
          addCommentBatch(message.payload.comments);
          if (!message.payload.isBackfill && message.payload.comments.length > 0) {
            // Track last seen for resume
            const lastComment =
              message.payload.comments[message.payload.comments.length - 1];
            useLiveStreamStore.setState({ lastSeenCommentId: lastComment.id });
          }
          break;

        case 'reactions_batch':
          addReactionBurst({
            type: Object.keys(message.payload.counts)[0] as any,
            count: Object.values(message.payload.counts).reduce((a, b) => a + b, 0),
            timestamp: message.payload.timestamp,
          });
          break;

        case 'viewer_count':
          setViewerCount(message.payload.count);
          break;

        case 'ack':
          handleAck(message.payload);
          break;

        case 'error':
          handleError(message.payload);
          break;
      }
    },
    [addCommentBatch, addReactionBurst, setViewerCount]
  );

  // Handle comment acknowledgment
  const handleAck = useCallback(
    (payload: { idempotencyKey: string; commentId: string; status: string }) => {
      const pending = pendingCommentsRef.current.get(payload.idempotencyKey);
      if (!pending) return;

      pendingCommentsRef.current.delete(payload.idempotencyKey);

      switch (payload.status) {
        case 'accepted':
          updateCommentStatus(payload.idempotencyKey, 'sent', payload.commentId);
          break;
        case 'rate_limited':
          updateCommentStatus(payload.idempotencyKey, 'rate_limited');
          // Retry after cooldown
          setTimeout(() => {
            sendComment(pending.content);
          }, 6000);
          break;
        case 'rejected':
          updateCommentStatus(payload.idempotencyKey, 'rejected');
          break;
      }
    },
    [updateCommentStatus]
  );

  // Send comment
  const sendComment = useCallback(
    (content: string): string => {
      const idempotencyKey = uuidv4();

      const pending: PendingComment = {
        idempotencyKey,
        content,
        addedAt: Date.now(),
        retryCount: 0,
      };
      pendingCommentsRef.current.set(idempotencyKey, pending);

      // Add optimistic comment to UI
      useLiveStreamStore.getState().addOptimisticComment({
        id: `optimistic-${idempotencyKey}`,
        idempotencyKey,
        content,
        status: 'pending',
      });

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: ClientMessage = {
          type: 'post_comment',
          payload: {
            streamId,
            content,
            idempotencyKey,
          },
        };
        wsRef.current.send(JSON.stringify(message));
      }

      return idempotencyKey;
    },
    [streamId]
  );

  // Retry pending comments on reconnect
  const retryPendingComments = useCallback(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    pendingCommentsRef.current.forEach((pending, key) => {
      if (now - pending.addedAt > maxAge) {
        // Too old, mark as failed
        pendingCommentsRef.current.delete(key);
        updateCommentStatus(key, 'failed');
        return;
      }

      if (pending.retryCount >= 3) {
        pendingCommentsRef.current.delete(key);
        updateCommentStatus(key, 'failed');
        return;
      }

      pending.retryCount++;

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: ClientMessage = {
          type: 'post_comment',
          payload: {
            streamId,
            content: pending.content,
            idempotencyKey: key,
          },
        };
        wsRef.current.send(JSON.stringify(message));
      }
    });
  }, [streamId, updateCommentStatus]);

  // Send reaction
  const sendReaction = useCallback(
    (reactionType: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const message: ClientMessage = {
          type: 'react',
          payload: {
            streamId,
            reactionType: reactionType as any,
          },
        };
        wsRef.current.send(JSON.stringify(message));
      }
    },
    [streamId]
  );

  // Reconnect with exponential backoff
  const scheduleReconnect = useCallback(() => {
    const attempt = connection.reconnectAttempt;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);

    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connection.reconnectAttempt, connect]);

  // Lifecycle
  useEffect(() => {
    connect();

    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close(1000);
    };
  }, [connect]);

  return {
    sendComment,
    sendReaction,
    connectionStatus: connection.status,
  };
}
```

---

## Step 6: Optimistic Updates and Reconciliation

### Store with Optimistic Comments

```typescript
// frontend/src/stores/liveStreamStore.ts

interface OptimisticComment {
  id: string;
  idempotencyKey: string;
  content: string;
  status: 'pending' | 'sent' | 'rate_limited' | 'rejected' | 'failed';
  createdAt: number;
}

interface LiveStreamState {
  comments: Comment[];
  optimisticComments: OptimisticComment[];
  lastSeenCommentId: string | null;

  addCommentBatch: (comments: Comment[]) => void;
  addOptimisticComment: (comment: Omit<OptimisticComment, 'createdAt'>) => void;
  updateCommentStatus: (
    idempotencyKey: string,
    status: OptimisticComment['status'],
    realId?: string
  ) => void;
}

export const useLiveStreamStore = create<LiveStreamState>((set, get) => ({
  comments: [],
  optimisticComments: [],
  lastSeenCommentId: null,

  addCommentBatch: (newComments) =>
    set((state) => {
      // Merge real comments, remove matching optimistic ones
      const optimisticKeys = new Set(
        state.optimisticComments.map((c) => c.idempotencyKey)
      );

      // Check if any new comments match our optimistic ones
      const matchedKeys = new Set<string>();
      newComments.forEach((comment) => {
        // Backend could include idempotencyKey in metadata
        if (comment.metadata?.idempotencyKey) {
          matchedKeys.add(comment.metadata.idempotencyKey);
        }
      });

      return {
        comments: [...state.comments, ...newComments].slice(-500),
        optimisticComments: state.optimisticComments.filter(
          (c) => !matchedKeys.has(c.idempotencyKey)
        ),
      };
    }),

  addOptimisticComment: (comment) =>
    set((state) => ({
      optimisticComments: [
        ...state.optimisticComments,
        { ...comment, createdAt: Date.now() },
      ],
    })),

  updateCommentStatus: (idempotencyKey, status, realId) =>
    set((state) => {
      if (status === 'sent' && realId) {
        // Comment confirmed - remove from optimistic, it will appear in real comments
        return {
          optimisticComments: state.optimisticComments.filter(
            (c) => c.idempotencyKey !== idempotencyKey
          ),
        };
      }

      return {
        optimisticComments: state.optimisticComments.map((c) =>
          c.idempotencyKey === idempotencyKey ? { ...c, status } : c
        ),
      };
    }),
}));
```

### Comment List with Optimistic Items

```typescript
// frontend/src/components/CommentList.tsx

export function CommentList() {
  const comments = useLiveStreamStore((state) => state.comments);
  const optimisticComments = useLiveStreamStore(
    (state) => state.optimisticComments
  );
  const currentUserId = useCurrentUser().id;

  // Merge real and optimistic comments for display
  const displayComments = useMemo(() => {
    const realComments = comments.map((c) => ({
      ...c,
      isOptimistic: false,
      optimisticStatus: undefined as OptimisticComment['status'] | undefined,
    }));

    const pendingComments = optimisticComments
      .filter((c) => c.status !== 'sent') // Still pending
      .map((c) => ({
        id: c.id,
        content: c.content,
        userId: currentUserId,
        username: 'You',
        avatarUrl: '',
        isHighlighted: false,
        isPinned: false,
        createdAt: c.createdAt,
        isOptimistic: true,
        optimisticStatus: c.status,
      }));

    return [...realComments, ...pendingComments];
  }, [comments, optimisticComments, currentUserId]);

  return (
    <div className="comment-list">
      {displayComments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          isOptimistic={comment.isOptimistic}
          optimisticStatus={comment.optimisticStatus}
        />
      ))}
    </div>
  );
}
```

---

## Step 7: Comment Batching Service

### Backend Batcher with Stream-Level Batching

```typescript
// backend/src/services/commentBatcher.ts

export class CommentBatcher {
  private buffer: Comment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchInterval: number;

  constructor(
    private streamId: string,
    private redis: Redis,
    private degradationPolicy: DegradationPolicy
  ) {
    // Adjust batch interval based on stream popularity
    const viewerCount = this.getViewerCount();
    this.batchInterval = this.degradationPolicy.getBatchInterval(viewerCount);
  }

  addComment(comment: Comment): void {
    this.buffer.push(comment);
  }

  start(): void {
    this.timer = setInterval(async () => {
      await this.flush();
    }, this.batchInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Flush remaining
    this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    // Apply sampling for viral streams
    const viewerCount = await this.getViewerCount();
    const policy = this.degradationPolicy.getPolicy(viewerCount);

    let commentsToSend = batch;
    if (!policy.showAllComments) {
      commentsToSend = this.sampleComments(batch, policy.samplingRate);
    }

    // Publish to Redis Pub/Sub
    const message: CommentsBatchMessage = {
      type: 'comments_batch',
      payload: {
        streamId: this.streamId,
        comments: commentsToSend,
        isBackfill: false,
      },
    };

    await this.redis.publish(
      `stream:${this.streamId}:comments`,
      JSON.stringify(message)
    );

    // Also cache for new joiners
    await this.cacheComments(batch);
  }

  private sampleComments(comments: Comment[], rate: number): Comment[] {
    if (rate >= 1.0) return comments;

    // Priority scoring
    const scored = comments.map((comment) => {
      let score = Math.random(); // Base randomness
      if (comment.isHighlighted) score += 10;
      if (comment.content.includes('?')) score += 2;
      return { score, comment };
    });

    scored.sort((a, b) => b.score - a.score);
    const count = Math.ceil(comments.length * rate);
    return scored.slice(0, count).map((s) => s.comment);
  }

  private async cacheComments(comments: Comment[]): Promise<void> {
    const key = `recent:stream:${this.streamId}`;
    const pipeline = this.redis.pipeline();

    comments.forEach((comment) => {
      pipeline.lpush(key, JSON.stringify(comment));
    });

    pipeline.ltrim(key, 0, 999);
    pipeline.expire(key, 3600);

    await pipeline.exec();
  }

  private async getViewerCount(): Promise<number> {
    const count = await this.redis.hget(`stream:${this.streamId}`, 'viewer_count');
    return parseInt(count || '0', 10);
  }
}
```

---

## Step 8: Rate Limiting Integration

### Backend Rate Limiter

```typescript
// backend/src/services/rateLimiter.ts

export class RateLimiter {
  constructor(private redis: Redis) {}

  async allow(userId: string, streamId: string): Promise<RateLimitResult> {
    const now = Date.now();

    // Global limit: 30 per minute
    const globalKey = `ratelimit:global:${userId}`;
    const globalResult = await this.checkLimit(globalKey, 30, 60);
    if (!globalResult.allowed) {
      return {
        allowed: false,
        reason: 'global_limit',
        retryAfter: globalResult.retryAfter,
      };
    }

    // Per-stream limit: 5 per 30 seconds
    const streamKey = `ratelimit:stream:${streamId}:${userId}`;
    const streamResult = await this.checkLimit(streamKey, 5, 30);
    if (!streamResult.allowed) {
      return {
        allowed: false,
        reason: 'stream_limit',
        retryAfter: streamResult.retryAfter,
      };
    }

    return { allowed: true };
  }

  private async checkLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    const count = await this.redis.incr(key);

    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }

    if (count > limit) {
      const ttl = await this.redis.ttl(key);
      return { allowed: false, retryAfter: ttl };
    }

    return { allowed: true };
  }
}

interface RateLimitResult {
  allowed: boolean;
  reason?: 'global_limit' | 'stream_limit';
  retryAfter?: number;
}
```

### Frontend Rate Limit Handling

```typescript
// frontend/src/components/CommentInput.tsx

export function CommentInput({ streamId }: { streamId: string }) {
  const [content, setContent] = useState('');
  const [rateLimitInfo, setRateLimitInfo] = useState<{
    limited: boolean;
    retryAfter: number;
  } | null>(null);

  const { sendComment } = useLiveStream({ streamId, userId: currentUser.id });

  // Subscribe to rate limit status updates
  useEffect(() => {
    const unsubscribe = useLiveStreamStore.subscribe(
      (state) => state.optimisticComments,
      (optimisticComments) => {
        const rateLimited = optimisticComments.find(
          (c) => c.status === 'rate_limited'
        );
        if (rateLimited) {
          setRateLimitInfo({ limited: true, retryAfter: 6 });
        }
      }
    );
    return unsubscribe;
  }, []);

  // Countdown timer for rate limit
  useEffect(() => {
    if (!rateLimitInfo?.limited) return;

    const timer = setInterval(() => {
      setRateLimitInfo((prev) => {
        if (!prev || prev.retryAfter <= 1) {
          return null;
        }
        return { ...prev, retryAfter: prev.retryAfter - 1 };
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [rateLimitInfo?.limited]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim() || rateLimitInfo?.limited) return;

    sendComment(content.trim());
    setContent('');
  };

  return (
    <form onSubmit={handleSubmit}>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={rateLimitInfo?.limited}
        placeholder={
          rateLimitInfo?.limited
            ? `Wait ${rateLimitInfo.retryAfter}s...`
            : 'Add a comment...'
        }
      />
      <button type="submit" disabled={rateLimitInfo?.limited || !content.trim()}>
        Send
      </button>
    </form>
  );
}
```

---

## Step 9: Integration Testing

### WebSocket Message Flow Tests

```typescript
// backend/src/tests/websocket.integration.test.ts

import { WebSocket } from 'ws';
import { createTestServer } from './helpers/testServer';

describe('WebSocket Integration', () => {
  let server: TestServer;
  let ws: WebSocket;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
  });

  afterEach(() => {
    ws.close();
  });

  it('should receive comments after joining stream', async () => {
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Join stream
    ws.send(
      JSON.stringify({
        type: 'join_stream',
        payload: { streamId: 'test-stream-1', userId: 'user-1' },
      })
    );

    // Wait for backfill
    await waitFor(() => messages.some((m) => m.type === 'comments_batch'));

    const backfill = messages.find((m) => m.type === 'comments_batch');
    expect(backfill?.payload.isBackfill).toBe(true);
  });

  it('should receive comment acknowledgment', async () => {
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Join stream
    ws.send(
      JSON.stringify({
        type: 'join_stream',
        payload: { streamId: 'test-stream-1', userId: 'user-1' },
      })
    );

    await waitFor(() => messages.some((m) => m.type === 'comments_batch'));

    // Post comment
    const idempotencyKey = 'test-key-123';
    ws.send(
      JSON.stringify({
        type: 'post_comment',
        payload: {
          streamId: 'test-stream-1',
          content: 'Test comment',
          idempotencyKey,
        },
      })
    );

    // Wait for acknowledgment
    await waitFor(() => messages.some((m) => m.type === 'ack'));

    const ack = messages.find((m) => m.type === 'ack');
    expect(ack?.payload.idempotencyKey).toBe(idempotencyKey);
    expect(ack?.payload.status).toBe('accepted');
  });

  it('should handle idempotent resubmission', async () => {
    const messages: ServerMessage[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Join and post
    ws.send(
      JSON.stringify({
        type: 'join_stream',
        payload: { streamId: 'test-stream-1', userId: 'user-1' },
      })
    );
    await waitFor(() => messages.length > 0);

    const idempotencyKey = 'idempotent-test-123';
    const postMessage = {
      type: 'post_comment',
      payload: {
        streamId: 'test-stream-1',
        content: 'Idempotent test',
        idempotencyKey,
      },
    };

    // Send same message twice
    ws.send(JSON.stringify(postMessage));
    await waitFor(() => messages.filter((m) => m.type === 'ack').length === 1);

    ws.send(JSON.stringify(postMessage));
    await waitFor(() => messages.filter((m) => m.type === 'ack').length === 2);

    // Both acks should have same comment ID
    const acks = messages.filter((m) => m.type === 'ack');
    expect(acks[0].payload.commentId).toBe(acks[1].payload.commentId);
  });
});

function waitFor(condition: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeout) {
        reject(new Error('Timeout waiting for condition'));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}
```

---

## Step 10: End-to-End Latency Monitoring

### Latency Tracking

```typescript
// Shared utility for measuring E2E latency

// Backend: Add timestamp when comment enters system
class CommentService {
  async createComment(payload: PostCommentMessage['payload']): Promise<Comment> {
    const comment: Comment = {
      id: this.idGenerator.generate(),
      ...payload,
      createdAt: Date.now(),
      metadata: {
        receivedAt: Date.now(), // When backend received it
      },
    };

    return comment;
  }
}

// Frontend: Measure display latency
function CommentItem({ comment }: { comment: Comment }) {
  useEffect(() => {
    if (comment.metadata?.receivedAt) {
      const displayLatency = Date.now() - comment.metadata.receivedAt;

      // Report to analytics
      analytics.track('comment_display_latency', {
        latency: displayLatency,
        streamId: comment.streamId,
      });

      // Log if too slow
      if (displayLatency > 1000) {
        console.warn(`High comment latency: ${displayLatency}ms`);
      }
    }
  }, [comment.id]);

  return <div>{/* ... */}</div>;
}
```

---

## Step 11: Trade-offs and Alternatives

| Decision | Chosen | Alternative | Reasoning |
|----------|--------|-------------|-----------|
| Type Sharing | Shared npm package | Copy-paste types | Single source of truth, compile-time safety |
| Optimistic Updates | Client-side with reconciliation | Wait for server | Better UX, comments appear instantly |
| Idempotency | Client-generated UUID | Server sequence | Works offline, no server round-trip for key |
| Rate Limiting | Both client and server | Server only | Instant feedback on client, enforcement on server |
| Reconnection | Exponential backoff + resume | Simple reconnect | Avoids thundering herd, continues from last seen |
| Message Protocol | JSON over WebSocket | Protocol Buffers | Simpler debugging, acceptable overhead |

---

## Summary

"To summarize the full-stack architecture for Facebook Live Comments:

1. **Shared Types**: Single npm package with all WebSocket message types, ensuring type safety across the stack
2. **Optimistic Updates**: Comments appear instantly on client, reconciled when server confirms
3. **Idempotency**: Client-generated UUIDs prevent duplicates on retry
4. **Batching**: Backend batches comments every 100-500ms based on stream popularity
5. **Reconnection**: Resume from `lastSeenCommentId` to avoid missing comments
6. **Rate Limiting**: Client shows cooldown timer, server enforces limits
7. **Integration Tests**: Full message flow testing with real WebSocket connections

The key full-stack insights are:
- Shared types catch protocol mismatches at compile time
- Idempotency keys must be generated on client for offline support
- Optimistic UI requires careful reconciliation when real data arrives
- Rate limit feedback should be instant (client-side) with server enforcement
- Resume support prevents lost comments during brief disconnects

What aspects would you like me to elaborate on?"
