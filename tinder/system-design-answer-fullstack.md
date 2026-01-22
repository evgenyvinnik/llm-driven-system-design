# Tinder - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **User Profiles**: Registration, photos, preferences management
- **Geospatial Discovery**: Find nearby users matching preferences
- **Swipe System**: Like/Pass with match detection
- **Real-time Matching**: Instant notification on mutual likes
- **Messaging**: Chat between matched users
- **Account Management**: Unmatch, report, block

### Non-Functional Requirements
- **End-to-End Latency**: Swipe to match notification < 100ms
- **Consistency**: No duplicate matches, no lost swipes
- **Privacy**: Location never exposed directly
- **Offline Support**: Queue swipes when disconnected

### Full-Stack Considerations
- Shared types between frontend and backend
- Optimistic UI with backend reconciliation
- Real-time state synchronization via WebSocket
- Coordinated error handling across stack

---

## 2. System Overview (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │   Swipe     │  │   Match     │  │   Message   │  │   Profile   │  │
│  │    Deck     │  │   Grid      │  │    List     │  │   Editor    │  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
│         └────────────────┼────────────────┼────────────────┘         │
│                          │                │                          │
│  ┌───────────────────────┴────────────────┴───────────────────────┐  │
│  │                    Zustand State Stores                         │  │
│  │  [discoveryStore] [matchStore] [messageStore] [profileStore]   │  │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                               │                                       │
│  ┌────────────────────────────┴───────────────────────────────────┐  │
│  │              API Client + WebSocket Manager                     │  │
│  └─────────────────────────────┬──────────────────────────────────┘  │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              REST API                   WebSocket
                    │                         │
┌───────────────────┴─────────────────────────┴─────────────────────────┐
│                         Backend (Express)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Discovery  │  │   Swipe     │  │   Match     │  │  Messaging  │   │
│  │   Service   │  │  Service    │  │  Service    │  │   Gateway   │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
│         │                │                │                │          │
│  ┌──────┴────────────────┴────────────────┴────────────────┴───────┐  │
│  │                     Shared Modules                               │  │
│  │  [db.ts] [cache.ts] [elasticsearch.ts] [pubsub.ts] [types.ts]   │  │
│  └─────────────────────────────┬───────────────────────────────────┘  │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   PostgreSQL    │    │      Redis      │    │  Elasticsearch  │
│   + PostGIS     │    │  (Cache/Pub)    │    │   (Geo Search)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

---

## 3. Shared Type Definitions (5 minutes)

### Shared Types Package

```typescript
// shared/types.ts - Used by both frontend and backend

// ============ User Types ============
export interface User {
  id: string;
  email: string;
  name: string;
  birthDate: string;  // ISO date
  gender: Gender;
  bio: string | null;
  photos: Photo[];
  preferences: DiscoveryPreferences;
  isVerified: boolean;
  lastActive: string;  // ISO timestamp
  createdAt: string;
}

export type Gender = 'man' | 'woman' | 'non_binary';

export interface Photo {
  id: string;
  url: string;
  position: number;
  isMain: boolean;
}

export interface DiscoveryPreferences {
  showMe: Gender[];
  ageMin: number;
  ageMax: number;
  distanceKm: number;
}

// ============ Profile Card (Discovery) ============
export interface ProfileCard {
  id: string;
  name: string;
  age: number;
  bio: string | null;
  photos: Photo[];
  distanceText: string;  // Fuzzy: "5 miles away"
  commonInterests: string[];
}

// ============ Swipe Types ============
export type SwipeDirection = 'like' | 'pass' | 'super_like';

export interface SwipeRequest {
  targetUserId: string;
  direction: SwipeDirection;
  idempotencyKey: string;
}

export interface SwipeResponse {
  success: boolean;
  match: MatchResult | null;
  remainingSwipes: number;
  nextRefreshAt: string | null;
}

export interface MatchResult {
  matchId: string;
  matchedUser: ProfileCard;
  matchedAt: string;
}

// ============ Match Types ============
export interface Match {
  id: string;
  user: ProfileCard;
  matchedAt: string;
  lastMessage: MessagePreview | null;
  unread: boolean;
}

export interface MessagePreview {
  content: string;
  sentAt: string;
  isOwn: boolean;
}

// ============ Message Types ============
export interface Message {
  id: string;
  matchId: string;
  senderId: string;
  content: string;
  readAt: string | null;
  createdAt: string;
}

export interface Conversation {
  matchId: string;
  matchedUser: ProfileCard;
  messages: Message[];
  isTyping: boolean;
}

// ============ WebSocket Events ============
export type WebSocketEvent =
  | { type: 'match'; match: MatchResult }
  | { type: 'new_message'; message: Message }
  | { type: 'typing'; matchId: string; isTyping: boolean }
  | { type: 'read_receipt'; matchId: string; messageId: string }
  | { type: 'unmatch'; matchId: string };

export interface WebSocketMessage {
  type: string;
  payload: unknown;
}

// ============ API Response Wrappers ============
export interface ApiResponse<T> {
  data: T;
  meta?: {
    cursor?: string;
    hasMore?: boolean;
    total?: number;
  };
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

// ============ Location Types ============
export interface GeoLocation {
  latitude: number;
  longitude: number;
}

export interface LocationUpdate {
  location: GeoLocation;
  accuracy?: number;
}
```

### Validation Schemas (Shared)

```typescript
// shared/validation.ts
import { z } from 'zod';

export const swipeRequestSchema = z.object({
  targetUserId: z.string().uuid(),
  direction: z.enum(['like', 'pass', 'super_like']),
  idempotencyKey: z.string().uuid()
});

export const messageSchema = z.object({
  matchId: z.string().uuid(),
  content: z.string().min(1).max(1000)
});

export const profileUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).nullable().optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(['man', 'woman', 'non_binary']).optional(),
  preferences: z.object({
    showMe: z.array(z.enum(['man', 'woman', 'non_binary'])).min(1),
    ageMin: z.number().min(18).max(100),
    ageMax: z.number().min(18).max(100),
    distanceKm: z.number().min(1).max(500)
  }).optional()
});

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180)
});
```

---

## 4. End-to-End Swipe Flow (10 minutes)

### Frontend: Optimistic Swipe with Rollback

```typescript
// stores/discoveryStore.ts
interface DiscoveryState {
  deck: ProfileCard[];
  deckIndex: number;
  pendingSwipes: Map<string, SwipeRequest>;
  failedSwipes: SwipeRequest[];

  swipe: (userId: string, direction: SwipeDirection) => Promise<SwipeResponse>;
  retrySwiped: (idempotencyKey: string) => Promise<void>;
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => ({
  deck: [],
  deckIndex: 0,
  pendingSwipes: new Map(),
  failedSwipes: [],

  swipe: async (targetUserId, direction) => {
    const { deck, deckIndex, pendingSwipes } = get();
    const currentCard = deck[deckIndex];

    if (!currentCard || currentCard.id !== targetUserId) {
      throw new Error('Card mismatch');
    }

    const idempotencyKey = crypto.randomUUID();
    const request: SwipeRequest = { targetUserId, direction, idempotencyKey };

    // Optimistic update: advance to next card immediately
    set({
      deckIndex: deckIndex + 1,
      pendingSwipes: new Map(pendingSwipes).set(idempotencyKey, request)
    });

    try {
      const response = await api.post<SwipeResponse>('/swipes', request);

      // Remove from pending
      set(state => {
        const newPending = new Map(state.pendingSwipes);
        newPending.delete(idempotencyKey);
        return { pendingSwipes: newPending };
      });

      // Handle match
      if (response.data.match) {
        useMatchStore.getState().handleNewMatch(response.data.match);
      }

      return response.data;
    } catch (error) {
      // On failure, add to failed queue (don't rollback UI for better UX)
      set(state => {
        const newPending = new Map(state.pendingSwipes);
        newPending.delete(idempotencyKey);
        return {
          pendingSwipes: newPending,
          failedSwipes: [...state.failedSwipes, request]
        };
      });

      throw error;
    }
  },

  retryFailedSwipes: async () => {
    const { failedSwipes } = get();
    if (failedSwipes.length === 0) return;

    set({ failedSwipes: [] });

    for (const request of failedSwipes) {
      try {
        await api.post('/swipes', request);
      } catch (error) {
        // Re-add to failed queue
        set(state => ({
          failedSwipes: [...state.failedSwipes, request]
        }));
      }
    }
  }
}));

// Retry failed swipes when coming back online
window.addEventListener('online', () => {
  useDiscoveryStore.getState().retryFailedSwipes();
});
```

### Backend: Swipe Processing with Match Detection

```typescript
// routes/swipes.ts
import { Router } from 'express';
import { swipeRequestSchema } from '../shared/validation.js';
import { SwipeService } from '../services/swipe.js';
import { RateLimiter } from '../shared/rateLimit.js';

const router = Router();
const swipeService = new SwipeService();
const rateLimiter = new RateLimiter();

router.post('/', async (req, res) => {
  const userId = req.session.userId!;

  // Validate request
  const parseResult = swipeRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: parseResult.error.flatten().fieldErrors
    });
  }

  const { targetUserId, direction, idempotencyKey } = parseResult.data;

  // Check rate limit
  const rateCheck = await rateLimiter.checkLimit(userId, 'swipes');
  if (!rateCheck.allowed) {
    return res.status(429).json({
      code: 'RATE_LIMITED',
      message: 'Swipe limit reached',
      remainingSwipes: 0,
      nextRefreshAt: new Date(rateCheck.resetAt).toISOString()
    });
  }

  try {
    const result = await swipeService.processSwipe(
      userId,
      targetUserId,
      direction,
      idempotencyKey
    );

    res.json(result);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      // Return cached result for duplicate request
      return res.json(error.cachedResult);
    }
    throw error;
  }
});

export default router;

// services/swipe.ts
export class SwipeService {
  async processSwipe(
    swiperId: string,
    swipedId: string,
    direction: SwipeDirection,
    idempotencyKey: string
  ): Promise<SwipeResponse> {
    // Check idempotency cache
    const cached = await this.getIdempotencyResult(idempotencyKey);
    if (cached) {
      return cached;
    }

    // Verify target user exists and is swipeable
    const targetUser = await this.validateSwipeTarget(swiperId, swipedId);

    // Execute swipe in Redis (fast path)
    const pipeline = this.redis.pipeline();

    pipeline.sadd(`swipes:${swiperId}:seen`, swipedId);
    pipeline.expire(`swipes:${swiperId}:seen`, 86400);

    if (direction === 'like' || direction === 'super_like') {
      pipeline.sadd(`swipes:${swiperId}:liked`, swipedId);
      pipeline.expire(`swipes:${swiperId}:liked`, 86400);

      // Check for mutual like
      pipeline.sismember(`swipes:${swipedId}:liked`, swiperId);

      // Track who liked them (for premium feature)
      pipeline.zadd(`likes:received:${swipedId}`, Date.now(), swiperId);
      pipeline.expire(`likes:received:${swipedId}`, 7 * 86400);
    } else {
      pipeline.sadd(`swipes:${swiperId}:passed`, swipedId);
      pipeline.expire(`swipes:${swiperId}:passed`, 86400);
    }

    const results = await pipeline.exec();

    // Persist to PostgreSQL asynchronously
    this.persistSwipe(swiperId, swipedId, direction, idempotencyKey);

    // Check for match
    let match: MatchResult | null = null;
    if (direction !== 'pass') {
      const isMutualLike = results[4]?.[1] === 1;
      if (isMutualLike) {
        match = await this.createMatch(swiperId, swipedId);
      }
    }

    const response: SwipeResponse = {
      success: true,
      match,
      remainingSwipes: await this.getRemainingSwipes(swiperId),
      nextRefreshAt: null
    };

    // Cache idempotency result
    await this.cacheIdempotencyResult(idempotencyKey, response);

    return response;
  }

  private async createMatch(user1Id: string, user2Id: string): Promise<MatchResult> {
    // Ensure consistent ordering for unique constraint
    const [smaller, larger] = user1Id < user2Id
      ? [user1Id, user2Id]
      : [user2Id, user1Id];

    const result = await this.pool.query(
      `INSERT INTO matches (user1_id, user2_id, matched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user1_id, user2_id) DO UPDATE SET matched_at = matches.matched_at
       RETURNING id, matched_at`,
      [smaller, larger]
    );

    const match = result.rows[0];
    const matchedUser = await this.getProfileCard(user2Id, user1Id);

    const matchResult: MatchResult = {
      matchId: match.id,
      matchedUser,
      matchedAt: match.matched_at.toISOString()
    };

    // Notify both users via WebSocket
    await Promise.all([
      this.notifyUser(user1Id, { type: 'match', match: matchResult }),
      this.notifyUser(user2Id, {
        type: 'match',
        match: {
          ...matchResult,
          matchedUser: await this.getProfileCard(user1Id, user2Id)
        }
      })
    ]);

    return matchResult;
  }

  private async notifyUser(userId: string, event: WebSocketEvent): Promise<void> {
    await this.redis.publish(`user:${userId}:events`, JSON.stringify(event));
  }
}
```

### End-to-End Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           SWIPE FLOW                                          │
└──────────────────────────────────────────────────────────────────────────────┘

User A swipes right on User B:

Frontend (User A)                    Backend                         Frontend (User B)
      │                                 │                                   │
      │  1. Optimistic update           │                                   │
      │     - Advance deck index        │                                   │
      │     - Add to pendingSwipes      │                                   │
      │     - Show next card            │                                   │
      │                                 │                                   │
      │  2. POST /swipes ──────────────▶│                                   │
      │     {targetUserId, direction,   │                                   │
      │      idempotencyKey}            │                                   │
      │                                 │                                   │
      │                                 │  3. Check idempotency cache       │
      │                                 │     (Redis GET)                   │
      │                                 │                                   │
      │                                 │  4. Check rate limit              │
      │                                 │     (Redis INCR + TTL)            │
      │                                 │                                   │
      │                                 │  5. Execute swipe (Redis pipeline)│
      │                                 │     - SADD seen set               │
      │                                 │     - SADD liked set              │
      │                                 │     - SISMEMBER check mutual      │
      │                                 │                                   │
      │                                 │  6. If mutual like detected:      │
      │                                 │     - INSERT INTO matches         │
      │                                 │     - PUBLISH to both users       │
      │                                 │                                   │
      │  7. Response ◀──────────────────│                                   │
      │     {success, match, remaining} │                                   │
      │                                 │                                   │
      │  8. If match:                   │  9. Redis Pub/Sub ───────────────▶│
      │     - Show MatchModal           │     {type: 'match', ...}          │
      │     - Add to matchStore         │                                   │
      │                                 │                                   │
      │                                 │                                   │  10. WebSocket receives
      │                                 │                                   │      - Show MatchModal
      │                                 │                                   │      - Add to matchStore
      │                                 │                                   │
      ▼                                 ▼                                   ▼
```

---

## 5. Real-Time Messaging Integration (8 minutes)

### WebSocket Manager (Frontend)

```typescript
// services/websocket.ts
import { WebSocketEvent } from '../shared/types';

type EventHandler = (event: WebSocketEvent) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private messageQueue: string[] = [];

  connect(token: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(`${WS_URL}/events?token=${token}`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.flushMessageQueue();
    };

    this.ws.onmessage = (event) => {
      const data: WebSocketEvent = JSON.parse(event.data);
      this.dispatch(data);
    };

    this.ws.onclose = (event) => {
      if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        setTimeout(() => this.connect(token), delay);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  send(message: object): void {
    const serialized = JSON.stringify(message);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serialized);
    } else {
      this.messageQueue.push(serialized);
    }
  }

  private dispatch(event: WebSocketEvent): void {
    const handlers = this.handlers.get(event.type);
    handlers?.forEach(handler => handler(event));

    // Also dispatch to 'all' listeners
    this.handlers.get('all')?.forEach(handler => handler(event));
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.messageQueue.shift()!);
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

export const wsManager = new WebSocketManager();
```

### Message Store with WebSocket Integration

```typescript
// stores/messageStore.ts
import { wsManager } from '../services/websocket';
import type { Message, Conversation, WebSocketEvent } from '../shared/types';

interface MessageState {
  conversations: Map<string, Conversation>;
  activeMatchId: string | null;

  loadConversation: (matchId: string) => Promise<void>;
  sendMessage: (matchId: string, content: string) => Promise<void>;
  markAsRead: (matchId: string) => Promise<void>;
  setTyping: (matchId: string, isTyping: boolean) => void;
}

export const useMessageStore = create<MessageState>((set, get) => {
  // Subscribe to WebSocket events
  wsManager.on('new_message', (event) => {
    if (event.type !== 'new_message') return;

    const { message } = event as { type: 'new_message'; message: Message };

    set(state => {
      const conv = state.conversations.get(message.matchId);
      if (!conv) return state;

      const newConversations = new Map(state.conversations);
      newConversations.set(message.matchId, {
        ...conv,
        messages: [...conv.messages, message]
      });

      return { conversations: newConversations };
    });

    // Auto-mark as read if conversation is active
    const { activeMatchId } = get();
    if (activeMatchId === message.matchId) {
      get().markAsRead(message.matchId);
    }
  });

  wsManager.on('typing', (event) => {
    if (event.type !== 'typing') return;

    const { matchId, isTyping } = event as { type: 'typing'; matchId: string; isTyping: boolean };

    set(state => {
      const conv = state.conversations.get(matchId);
      if (!conv) return state;

      const newConversations = new Map(state.conversations);
      newConversations.set(matchId, { ...conv, isTyping });

      return { conversations: newConversations };
    });
  });

  return {
    conversations: new Map(),
    activeMatchId: null,

    loadConversation: async (matchId) => {
      set({ activeMatchId: matchId });

      const response = await api.get<{ messages: Message[]; matchedUser: ProfileCard }>(
        `/matches/${matchId}/messages`
      );

      set(state => {
        const newConversations = new Map(state.conversations);
        newConversations.set(matchId, {
          matchId,
          matchedUser: response.data.matchedUser,
          messages: response.data.messages,
          isTyping: false
        });

        return { conversations: newConversations };
      });
    },

    sendMessage: async (matchId, content) => {
      const tempId = `temp-${Date.now()}`;
      const userId = useAuthStore.getState().user!.id;

      // Optimistic update
      const optimisticMessage: Message = {
        id: tempId,
        matchId,
        senderId: userId,
        content,
        readAt: null,
        createdAt: new Date().toISOString()
      };

      set(state => {
        const conv = state.conversations.get(matchId);
        if (!conv) return state;

        const newConversations = new Map(state.conversations);
        newConversations.set(matchId, {
          ...conv,
          messages: [...conv.messages, optimisticMessage]
        });

        return { conversations: newConversations };
      });

      try {
        const response = await api.post<{ message: Message }>(
          `/matches/${matchId}/messages`,
          { content }
        );

        // Replace optimistic message with real one
        set(state => {
          const conv = state.conversations.get(matchId);
          if (!conv) return state;

          const newConversations = new Map(state.conversations);
          newConversations.set(matchId, {
            ...conv,
            messages: conv.messages.map(m =>
              m.id === tempId ? response.data.message : m
            )
          });

          return { conversations: newConversations };
        });
      } catch (error) {
        // Mark message as failed
        set(state => {
          const conv = state.conversations.get(matchId);
          if (!conv) return state;

          const newConversations = new Map(state.conversations);
          newConversations.set(matchId, {
            ...conv,
            messages: conv.messages.map(m =>
              m.id === tempId ? { ...m, failed: true } : m
            )
          });

          return { conversations: newConversations };
        });

        throw error;
      }
    },

    markAsRead: async (matchId) => {
      await api.post(`/matches/${matchId}/read`);
    },

    setTyping: (matchId, isTyping) => {
      wsManager.send({ type: 'typing', matchId, isTyping });
    }
  };
});
```

### Backend: WebSocket Gateway

```typescript
// services/websocketGateway.ts
import WebSocket from 'ws';
import { Redis } from 'ioredis';
import { verifySession } from '../shared/auth.js';

export class WebSocketGateway {
  private wss: WebSocket.Server;
  private connections: Map<string, WebSocket> = new Map();
  private subscriber: Redis;

  constructor(server: http.Server, redis: Redis) {
    this.wss = new WebSocket.Server({ server, path: '/events' });
    this.subscriber = redis.duplicate();

    this.setupPubSub();
    this.setupConnectionHandler();
  }

  private async setupPubSub(): Promise<void> {
    await this.subscriber.psubscribe('user:*:events');

    this.subscriber.on('pmessage', (pattern, channel, message) => {
      const userId = channel.split(':')[1];
      this.deliverToUser(userId, message);
    });
  }

  private setupConnectionHandler(): void {
    this.wss.on('connection', async (ws, req) => {
      // Extract token from query
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }

      // Verify session
      const session = await verifySession(token);
      if (!session) {
        ws.close(4001, 'Invalid session');
        return;
      }

      const userId = session.userId;
      this.connections.set(userId, ws);

      // Update presence
      await this.redis.hset(`user:${userId}:presence`, {
        status: 'online',
        serverId: this.serverId,
        connectedAt: Date.now()
      });

      ws.on('message', (data) => this.handleMessage(userId, data));
      ws.on('close', () => this.handleDisconnect(userId));
      ws.on('error', (error) => console.error(`WS error for ${userId}:`, error));
    });
  }

  private async handleMessage(userId: string, data: WebSocket.Data): Promise<void> {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'typing':
          await this.handleTyping(userId, message);
          break;
        case 'ping':
          this.connections.get(userId)?.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      console.error('Error handling WS message:', error);
    }
  }

  private async handleTyping(
    userId: string,
    message: { matchId: string; isTyping: boolean }
  ): Promise<void> {
    // Get the other user in the match
    const match = await this.getMatch(message.matchId, userId);
    if (!match) return;

    const otherId = match.user1_id === userId ? match.user2_id : match.user1_id;

    // Publish typing indicator
    await this.redis.publish(`user:${otherId}:events`, JSON.stringify({
      type: 'typing',
      matchId: message.matchId,
      isTyping: message.isTyping
    }));
  }

  private deliverToUser(userId: string, message: string): void {
    const ws = this.connections.get(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }

  private async handleDisconnect(userId: string): Promise<void> {
    this.connections.delete(userId);

    // Update presence
    await this.redis.hset(`user:${userId}:presence`, {
      status: 'offline',
      disconnectedAt: Date.now()
    });
  }
}
```

---

## 6. Discovery Deck Generation (7 minutes)

### Frontend: Discovery with Location

```typescript
// routes/index.tsx (Discovery page)
export function DiscoveryPage() {
  const { deck, deckIndex, isLoading, loadDeck, swipe } = useDiscoveryStore();
  const { showMatchModal, handleNewMatch, dismissMatchModal } = useMatchStore();
  const [locationError, setLocationError] = useState<string | null>(null);

  // Get location and load deck
  useEffect(() => {
    const initDiscovery = async () => {
      try {
        const location = await requestLocation();
        await loadDeck(location);
      } catch (error) {
        if (error instanceof GeolocationPositionError) {
          setLocationError('Location access is required to discover people nearby');
        }
      }
    };

    initDiscovery();
  }, [loadDeck]);

  // Prefetch more cards when running low
  useEffect(() => {
    if (deck.length - deckIndex < 5 && !isLoading) {
      getCurrentLocation().then(loadDeck);
    }
  }, [deckIndex, deck.length, isLoading, loadDeck]);

  if (locationError) {
    return <LocationPermissionPrompt onRetry={() => setLocationError(null)} />;
  }

  if (isLoading && deck.length === 0) {
    return <DiscoveryLoadingSkeleton />;
  }

  return (
    <div className="h-full flex flex-col">
      <SwipeDeck
        cards={deck.slice(deckIndex, deckIndex + 2)}
        onSwipe={swipe}
      />

      {showMatchModal && (
        <MatchModal
          matchData={showMatchModal}
          onDismiss={dismissMatchModal}
          onSendMessage={(matchId) => navigate(`/messages/${matchId}`)}
        />
      )}
    </div>
  );
}

// Location helper
async function requestLocation(): Promise<GeoLocation> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      reject,
      { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 }
    );
  });
}
```

### Backend: Multi-Source Candidate Generation

```typescript
// services/discovery.ts
import { ProfileCard, DiscoveryPreferences, GeoLocation } from '../shared/types.js';

export class DiscoveryService {
  async getDeck(
    userId: string,
    location: GeoLocation,
    limit: number = 10
  ): Promise<ProfileCard[]> {
    // Get user preferences
    const user = await this.getUser(userId);
    const preferences = user.preferences;

    // Get seen users from Redis
    const seenUserIds = await this.redis.smembers(`swipes:${userId}:seen`);

    // Try Elasticsearch first
    try {
      return await this.searchElasticsearch(userId, location, preferences, seenUserIds, limit);
    } catch (error) {
      console.error('Elasticsearch failed, falling back to PostgreSQL:', error);
      return await this.searchPostGIS(userId, location, preferences, seenUserIds, limit);
    }
  }

  private async searchElasticsearch(
    userId: string,
    location: GeoLocation,
    prefs: DiscoveryPreferences,
    excludeIds: string[],
    limit: number
  ): Promise<ProfileCard[]> {
    const query = {
      bool: {
        must: [
          { terms: { gender: prefs.showMe } },
          { range: { age: { gte: prefs.ageMin, lte: prefs.ageMax } } },
          { term: { is_active: true } },
          { range: { last_active: { gte: 'now-7d' } } }
        ],
        must_not: [
          { term: { user_id: userId } },
          { terms: { user_id: excludeIds } }
        ],
        filter: {
          geo_distance: {
            distance: `${prefs.distanceKm}km`,
            location: { lat: location.latitude, lon: location.longitude }
          }
        }
      }
    };

    const results = await this.elasticsearch.search({
      index: 'users',
      body: {
        query,
        sort: [
          {
            _geo_distance: {
              location: { lat: location.latitude, lon: location.longitude },
              order: 'asc',
              unit: 'km'
            }
          },
          { profile_score: 'desc' },
          { last_active: 'desc' }
        ],
        size: limit * 3  // Fetch extra for shuffling
      }
    });

    const cards = this.mapToProfileCards(results.hits.hits, location);

    // Shuffle and return limit
    return this.shuffleArray(cards).slice(0, limit);
  }

  private async searchPostGIS(
    userId: string,
    location: GeoLocation,
    prefs: DiscoveryPreferences,
    excludeIds: string[],
    limit: number
  ): Promise<ProfileCard[]> {
    const query = `
      WITH user_loc AS (
        SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS point
      )
      SELECT
        u.id,
        u.name,
        EXTRACT(YEAR FROM AGE(u.birth_date))::int AS age,
        u.bio,
        ST_Distance(u.location, ul.point) / 1000 AS distance_km,
        array_agg(json_build_object('id', p.id, 'url', p.url, 'position', p.position)) AS photos
      FROM users u
      CROSS JOIN user_loc ul
      LEFT JOIN photos p ON p.user_id = u.id
      WHERE u.id != $3
        AND u.is_active = true
        AND u.gender = ANY($4)
        AND EXTRACT(YEAR FROM AGE(u.birth_date)) BETWEEN $5 AND $6
        AND ST_DWithin(u.location, ul.point, $7 * 1000)
        AND u.id != ALL($8)
      GROUP BY u.id, ul.point
      ORDER BY ST_Distance(u.location, ul.point)
      LIMIT $9
    `;

    const result = await this.pool.query(query, [
      location.longitude,
      location.latitude,
      userId,
      prefs.showMe,
      prefs.ageMin,
      prefs.ageMax,
      prefs.distanceKm,
      excludeIds,
      limit * 3
    ]);

    return this.shuffleArray(
      result.rows.map(row => this.mapRowToProfileCard(row))
    ).slice(0, limit);
  }

  private mapToProfileCards(hits: any[], location: GeoLocation): ProfileCard[] {
    return hits.map(hit => ({
      id: hit._source.user_id,
      name: hit._source.name,
      age: hit._source.age,
      bio: hit._source.bio,
      photos: hit._source.photos,
      distanceText: this.formatDistance(hit.sort[0]),
      commonInterests: hit._source.interests || []
    }));
  }

  private formatDistance(km: number): string {
    // Fuzzy distance for privacy
    if (km < 1) return 'Less than 1 mile away';
    if (km < 5) return 'About 2 miles away';
    if (km < 10) return 'About 5 miles away';
    if (km < 25) return 'About 15 miles away';
    if (km < 50) return 'About 30 miles away';
    return 'More than 50 miles away';
  }

  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
}
```

---

## 7. Error Handling Across the Stack (4 minutes)

### API Error Types

```typescript
// shared/errors.ts
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
    public details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ValidationError extends ApiError {
  constructor(details: Record<string, string[]>) {
    super('VALIDATION_ERROR', 'Validation failed', 400, details);
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

export class RateLimitError extends ApiError {
  constructor(public resetAt: Date) {
    super('RATE_LIMITED', 'Rate limit exceeded', 429);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
  }
}
```

### Backend Error Handler

```typescript
// middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../shared/errors.js';

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error('Error:', {
    message: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method
  });

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      details: error.details
    });
    return;
  }

  // Generic error
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred'
  });
}
```

### Frontend Error Handling

```typescript
// services/api.ts
import axios, { AxiosError } from 'axios';
import { ApiError } from '../shared/types';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiError>) => {
    if (error.response) {
      const { code, message } = error.response.data;

      switch (code) {
        case 'UNAUTHORIZED':
          // Redirect to login
          window.location.href = '/login';
          break;

        case 'RATE_LIMITED':
          // Show rate limit toast
          toast.error('Too many requests. Please wait a moment.');
          break;

        case 'VALIDATION_ERROR':
          // Return error for form handling
          break;

        default:
          toast.error(message || 'Something went wrong');
      }
    } else if (error.request) {
      // Network error
      if (!navigator.onLine) {
        toast.error('You appear to be offline');
      } else {
        toast.error('Unable to connect to server');
      }
    }

    return Promise.reject(error);
  }
);

export { api };
```

---

## 8. Summary

This full-stack architecture delivers Tinder's core experience with tight integration:

### Key Integration Points

1. **Shared Types**: TypeScript types used across frontend and backend ensure type safety
2. **Optimistic Updates**: Frontend updates UI immediately, syncs with backend asynchronously
3. **WebSocket Events**: Real-time match and message notifications via Redis Pub/Sub
4. **Idempotency**: Duplicate swipe requests handled gracefully with cached responses
5. **Error Handling**: Consistent error codes and handling across the stack

### Data Flow Patterns

| Action | Frontend | Backend | Real-time |
|--------|----------|---------|-----------|
| Swipe | Optimistic advance | Redis sets + PostgreSQL | Match event via WebSocket |
| Match | Show modal on response/event | Create match, notify both | Pub/Sub to both users |
| Message | Optimistic add | Store in PostgreSQL | Pub/Sub to recipient |
| Typing | Debounced send | Forward via Pub/Sub | Direct to other user |

### Consistency Strategy

- **Redis**: Hot data (swipes, sessions, typing) with 24h TTL
- **PostgreSQL**: Source of truth for users, matches, messages
- **Elasticsearch**: Read-optimized geo index, eventually consistent
- **Frontend**: Optimistic updates with rollback on failure

The architecture prioritizes instant feedback through optimistic updates while maintaining data consistency through idempotency and proper error handling.
