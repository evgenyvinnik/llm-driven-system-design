# YouTube Top K Videos - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design a real-time trending videos system that tracks view counts and computes Top K rankings with live updates. As a full-stack solution, I'll focus on three integration points: the view recording flow from frontend click to Redis counter with idempotency guarantees, the SSE-based real-time update pipeline that keeps clients in sync, and the shared type system that ensures consistency between TypeScript frontend and backend. I'll show how both layers work together to deliver a responsive, reliable trending experience."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **View Recording**: Track views with < 50ms latency
- **Trending Computation**: Top K videos per category, configurable time windows
- **Real-time Updates**: Push trending changes to all clients via SSE
- **Category Filtering**: Multiple categories with instant switching

### Non-Functional Requirements
- **Throughput**: 10,000+ views/second at peak
- **Latency**: < 50ms view recording, < 100ms trending queries
- **Consistency**: Eventual consistency (5-second refresh)
- **Reliability**: Graceful degradation when services fail

### Full-Stack Considerations
- Type-safe API contracts between frontend and backend
- Optimistic updates for view recording
- Reconnection handling for SSE streams
- Shared validation logic

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
│              React + TypeScript + Zustand                        │
│                                                                  │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│   │  VideoCard   │    │ CategoryTabs │    │  SSEClient   │     │
│   │  + Simulate  │    │  + Filter    │    │  + Reconnect │     │
│   └──────┬───────┘    └──────────────┘    └──────┬───────┘     │
│          │                                        │              │
└──────────┼────────────────────────────────────────┼──────────────┘
           │ POST /api/videos/:id/view              │ SSE /api/sse
           ▼                                        ▼
┌──────────────────────────────────────────────────────────────────┐
│                         API Layer                                 │
│                    Express + TypeScript                           │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│   │ ViewHandler  │    │ Trending     │    │ SSEHandler   │      │
│   │ + Idempotency│    │ Service      │    │ + Broadcast  │      │
│   └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│          │                   │                   │               │
└──────────┼───────────────────┼───────────────────┼───────────────┘
           │                   │                   │
           ▼                   ▼                   │
     ┌───────────┐      ┌───────────┐              │
     │   Redis   │◄─────│PostgreSQL │              │
     │ Counters  │      │ Metadata  │◄─────────────┘
     └───────────┘      └───────────┘
```

## Deep Dive: Shared Types Package (5 minutes)

### Type Definitions

```typescript
// packages/shared/src/types.ts

// === API Types ===

export interface Video {
  id: string;
  title: string;
  description?: string;
  thumbnailUrl: string;
  channelName: string;
  category: Category;
  durationSeconds: number;
  totalViews: number;
  createdAt: string;
}

export type Category =
  | 'all'
  | 'music'
  | 'gaming'
  | 'sports'
  | 'news'
  | 'education';

export const CATEGORIES: Category[] = [
  'all',
  'music',
  'gaming',
  'sports',
  'news',
  'education'
];

// === Trending Types ===

export interface TrendingVideo {
  videoId: string;
  title: string;
  viewCount: number;
  rank: number;
  thumbnailUrl?: string;
  channelName?: string;
}

export interface CategoryTrending {
  category: Category;
  videos: TrendingVideo[];
  computedAt: string;
}

export type TrendingData = Record<Category, CategoryTrending>;

// === Request/Response Types ===

export interface RecordViewRequest {
  sessionId?: string;
  idempotencyKey?: string;
}

export interface RecordViewResponse {
  success: boolean;
  duplicate: boolean;
  videoId: string;
  newViewCount?: number;
}

export interface TrendingQueryParams {
  category?: Category;
  limit?: number;
  window?: 'hour' | 'day' | 'week';
}

// === SSE Event Types ===

export interface SSEEvent<T = unknown> {
  type: 'trending' | 'heartbeat' | 'error';
  data: T;
  timestamp: string;
}

export interface TrendingUpdateEvent {
  type: 'trending';
  data: TrendingData;
  timestamp: string;
}

// === Error Types ===

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class TrendingError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'TrendingError';
  }
}
```

### Shared Validation with Zod

```typescript
// packages/shared/src/validation.ts
import { z } from 'zod';
import { CATEGORIES } from './types';

// === Request Schemas ===

export const recordViewSchema = z.object({
  sessionId: z.string().uuid().optional(),
  idempotencyKey: z.string().max(255).optional()
});

export const trendingQuerySchema = z.object({
  category: z.enum(CATEGORIES as [string, ...string[]]).optional().default('all'),
  limit: z.coerce.number().min(1).max(100).optional().default(10),
  window: z.enum(['hour', 'day', 'week']).optional().default('hour')
});

export const videoIdSchema = z.string().uuid();

// === Response Schemas ===

export const trendingVideoSchema = z.object({
  videoId: z.string().uuid(),
  title: z.string(),
  viewCount: z.number().int().nonnegative(),
  rank: z.number().int().positive(),
  thumbnailUrl: z.string().url().optional(),
  channelName: z.string().optional()
});

export const categoryTrendingSchema = z.object({
  category: z.enum(CATEGORIES as [string, ...string[]]),
  videos: z.array(trendingVideoSchema),
  computedAt: z.string().datetime()
});

export const trendingDataSchema = z.record(categoryTrendingSchema);

// === Validation Helpers ===

export function validateRecordView(data: unknown) {
  return recordViewSchema.parse(data);
}

export function validateTrendingQuery(params: unknown) {
  return trendingQuerySchema.parse(params);
}

export function validateVideoId(id: unknown) {
  return videoIdSchema.parse(id);
}

// Type inference from schemas
export type RecordViewInput = z.infer<typeof recordViewSchema>;
export type TrendingQueryInput = z.infer<typeof trendingQuerySchema>;
```

## Deep Dive: End-to-End View Recording Flow (10 minutes)

### Frontend: API Client with Optimistic Updates

```typescript
// frontend/src/services/api.ts
import type {
  RecordViewRequest,
  RecordViewResponse,
  TrendingData,
  Category,
  ApiError
} from '@youtube-topk/shared';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!response.ok) {
      const error: ApiError = await response.json().catch(() => ({
        code: 'UNKNOWN_ERROR',
        message: response.statusText
      }));
      throw new Error(error.message);
    }

    return response.json();
  }

  // Record a view with idempotency support
  async recordView(
    videoId: string,
    options: RecordViewRequest = {}
  ): Promise<RecordViewResponse> {
    // Generate idempotency key if not provided
    const idempotencyKey =
      options.idempotencyKey ||
      `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return this.request<RecordViewResponse>(`/videos/${videoId}/view`, {
      method: 'POST',
      body: JSON.stringify({
        ...options,
        idempotencyKey
      })
    });
  }

  // Record bulk views for testing
  async recordBulkViews(
    videoId: string,
    count: number
  ): Promise<{ success: boolean; recorded: number }> {
    return this.request(`/videos/${videoId}/bulk-view`, {
      method: 'POST',
      body: JSON.stringify({ count })
    });
  }

  // Fetch current trending (fallback when SSE disconnects)
  async getTrending(
    category: Category = 'all'
  ): Promise<TrendingData> {
    return this.request(`/trending?category=${category}`);
  }
}

export const api = new ApiClient();
```

### Frontend: View Recording with Optimistic UI

```tsx
// frontend/src/components/trending/VideoCard.tsx
import { useState, useCallback } from 'react';
import { useTrendingStore } from '../../stores/trendingStore';
import { api } from '../../services/api';
import type { TrendingVideo } from '@youtube-topk/shared';

interface VideoCardProps {
  video: TrendingVideo;
}

export function VideoCard({ video }: VideoCardProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [localViewCount, setLocalViewCount] = useState(video.viewCount);
  const incrementOptimistic = useTrendingStore((s) => s.incrementViewCount);

  const handleRecordView = useCallback(async () => {
    if (isRecording) return;

    setIsRecording(true);

    // Optimistic update
    const previousCount = localViewCount;
    setLocalViewCount((c) => c + 1);
    incrementOptimistic(video.videoId);

    try {
      const result = await api.recordView(video.videoId);

      if (result.duplicate) {
        // Rollback if duplicate
        setLocalViewCount(previousCount);
        console.log('Duplicate view detected, not counted');
      }
    } catch (err) {
      // Rollback on error
      setLocalViewCount(previousCount);
      console.error('Failed to record view:', err);
    } finally {
      setIsRecording(false);
    }
  }, [video.videoId, localViewCount, isRecording, incrementOptimistic]);

  return (
    <article className="video-card">
      {/* ... thumbnail and content ... */}
      <button
        onClick={handleRecordView}
        disabled={isRecording}
        className="play-button"
      >
        {isRecording ? 'Recording...' : 'Play'}
      </button>
      <span className="view-count">
        {localViewCount.toLocaleString()} views
      </span>
    </article>
  );
}
```

### Backend: View Handler with Validation

```typescript
// backend/src/routes/views.ts
import { Router } from 'express';
import { z } from 'zod';
import { validateRecordView, validateVideoId } from '@youtube-topk/shared';
import { viewCounter } from '../services/viewCounter';
import { idempotencyService } from '../services/idempotency';
import { pool } from '../shared/db';

const router = Router();

router.post('/videos/:id/view', async (req, res, next) => {
  try {
    // Validate video ID
    const videoId = validateVideoId(req.params.id);

    // Validate request body
    const { sessionId, idempotencyKey } = validateRecordView(req.body);

    // Check idempotency (prevent duplicate processing)
    if (idempotencyKey) {
      const existing = await idempotencyService.check(idempotencyKey);
      if (existing) {
        return res.json({
          success: true,
          duplicate: true,
          videoId,
          newViewCount: existing.viewCount
        });
      }
    }

    // Verify video exists
    const video = await pool.query(
      'SELECT id, category FROM videos WHERE id = $1',
      [videoId]
    );

    if (video.rows.length === 0) {
      return res.status(404).json({
        code: 'VIDEO_NOT_FOUND',
        message: 'Video not found'
      });
    }

    const category = video.rows[0].category;

    // Record the view
    const result = await viewCounter.recordView(videoId, category, sessionId);

    // Store idempotency result
    if (idempotencyKey) {
      await idempotencyService.store(idempotencyKey, {
        videoId,
        viewCount: result.newViewCount,
        processedAt: new Date()
      });
    }

    res.json({
      success: true,
      duplicate: result.duplicate,
      videoId,
      newViewCount: result.newViewCount
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.errors
      });
    }
    next(err);
  }
});

export { router as viewsRouter };
```

### Backend: Idempotency Service

```typescript
// backend/src/services/idempotency.ts
import { redis } from '../shared/cache';

interface IdempotencyResult {
  videoId: string;
  viewCount: number;
  processedAt: Date;
}

class IdempotencyService {
  private ttlSeconds = 3600; // 1 hour

  async check(key: string): Promise<IdempotencyResult | null> {
    const data = await redis.get(`idem:${key}`);
    if (!data) return null;

    return JSON.parse(data);
  }

  async store(key: string, result: IdempotencyResult): Promise<void> {
    await redis.set(
      `idem:${key}`,
      JSON.stringify(result),
      'EX',
      this.ttlSeconds
    );
  }

  async delete(key: string): Promise<void> {
    await redis.del(`idem:${key}`);
  }
}

export const idempotencyService = new IdempotencyService();
```

## Deep Dive: SSE Real-Time Updates Pipeline (10 minutes)

### Backend: SSE Handler with Client Management

```typescript
// backend/src/routes/sse.ts
import { Router, Request, Response } from 'express';
import { trendingService } from '../services/trendingService';
import type { SSEEvent, TrendingData } from '@youtube-topk/shared';

const router = Router();

interface SSEClient {
  id: string;
  res: Response;
  category?: string;
  connectedAt: Date;
}

const clients = new Map<string, SSEClient>();

// Metrics
let totalConnections = 0;
let totalMessages = 0;

router.get('/sse/trending', (req: Request, res: Response) => {
  const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const category = req.query.category as string | undefined;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  // Register client
  clients.set(clientId, {
    id: clientId,
    res,
    category,
    connectedAt: new Date()
  });
  totalConnections++;

  console.log(`SSE client connected: ${clientId} (total: ${clients.size})`);

  // Send initial data
  const initialData = trendingService.getCachedTrending();
  sendEvent(res, {
    type: 'trending',
    data: initialData,
    timestamp: new Date().toISOString()
  });

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    sendEvent(res, {
      type: 'heartbeat',
      data: { clientId },
      timestamp: new Date().toISOString()
    });
  }, 30000);

  // Handle disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    console.log(`SSE client disconnected: ${clientId} (total: ${clients.size})`);
  });
});

// Broadcast to all connected clients
export function broadcastTrending(data: TrendingData): void {
  const event: SSEEvent<TrendingData> = {
    type: 'trending',
    data,
    timestamp: new Date().toISOString()
  };

  for (const client of clients.values()) {
    try {
      sendEvent(client.res, event);
      totalMessages++;
    } catch (err) {
      // Client likely disconnected
      clients.delete(client.id);
    }
  }
}

function sendEvent(res: Response, event: SSEEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n`);
  res.write(`id: ${event.timestamp}\n\n`);
}

// Stats endpoint for monitoring
router.get('/sse/stats', (req, res) => {
  res.json({
    connectedClients: clients.size,
    totalConnections,
    totalMessages,
    clients: Array.from(clients.values()).map((c) => ({
      id: c.id,
      connectedAt: c.connectedAt,
      category: c.category
    }))
  });
});

export { router as sseRouter };
```

### Frontend: Robust SSE Hook with Reconnection

```typescript
// frontend/src/hooks/useSSE.ts
import { useEffect, useRef, useCallback, useState } from 'react';
import { useTrendingStore } from '../stores/trendingStore';
import type { SSEEvent, TrendingData } from '@youtube-topk/shared';

interface UseSSEOptions {
  url: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export function useSSE({ url, onConnect, onDisconnect, onError }: UseSSEOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const [isConnected, setIsConnected] = useState(false);
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const setTrending = useTrendingStore((s) => s.setTrending);
  const setConnectionStatus = useTrendingStore((s) => s.setConnectionStatus);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    // Create new connection with last event ID for resumption
    const urlWithLastId = lastEventId
      ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}`
      : url;

    const eventSource = new EventSource(urlWithLastId);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      console.log('SSE connected');
      setIsConnected(true);
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;
      onConnect?.();
    };

    // Handle trending events
    eventSource.addEventListener('trending', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as TrendingData;
        setTrending(data);
        setLastEventId(event.lastEventId);
      } catch (err) {
        console.error('Failed to parse trending event:', err);
      }
    });

    // Handle heartbeat events
    eventSource.addEventListener('heartbeat', (event: MessageEvent) => {
      setLastEventId(event.lastEventId);
    });

    // Handle errors
    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      setIsConnected(false);
      setConnectionStatus('disconnected');
      eventSource.close();
      onError?.(error);
      onDisconnect?.();

      // Reconnect with exponential backoff
      const maxAttempts = 10;
      if (reconnectAttemptsRef.current < maxAttempts) {
        const delay = Math.min(
          1000 * Math.pow(2, reconnectAttemptsRef.current),
          30000
        );
        reconnectAttemptsRef.current++;

        console.log(
          `Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`
        );

        reconnectTimeoutRef.current = setTimeout(connect, delay);
      }
    };
  }, [url, lastEventId, setTrending, setConnectionStatus, onConnect, onDisconnect, onError]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    setIsConnected(false);
    setConnectionStatus('disconnected');
  }, [setConnectionStatus]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return {
    isConnected,
    reconnect,
    disconnect,
    reconnectAttempts: reconnectAttemptsRef.current
  };
}
```

### Backend: TrendingService with Broadcast

```typescript
// backend/src/services/trendingService.ts
import { viewCounter } from './viewCounter';
import { pool } from '../shared/db';
import { broadcastTrending } from '../routes/sse';
import type { TrendingData, CategoryTrending, Category, CATEGORIES } from '@youtube-topk/shared';

class TrendingService {
  private cache: TrendingData | null = null;
  private refreshIntervalMs = 5000; // 5 seconds
  private categories: Category[] = ['all', 'music', 'gaming', 'sports', 'news', 'education'];
  private intervalId: NodeJS.Timeout | null = null;

  async start(): Promise<void> {
    // Initial computation
    await this.computeAndBroadcast();

    // Periodic refresh
    this.intervalId = setInterval(
      () => this.computeAndBroadcast(),
      this.refreshIntervalMs
    );

    console.log('TrendingService started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getCachedTrending(): TrendingData {
    return this.cache || ({} as TrendingData);
  }

  private async computeAndBroadcast(): Promise<void> {
    try {
      const trending: TrendingData = {} as TrendingData;

      // Compute trending for each category in parallel
      const computations = this.categories.map(async (category) => {
        const topK = await viewCounter.getTopK(category, 10, 3600000);

        if (topK.length > 0) {
          // Enrich with video metadata
          const videoIds = topK.map((v) => v.videoId);
          const metadata = await this.getVideoMetadata(videoIds);

          const videos = topK.map((item, index) => ({
            videoId: item.videoId,
            title: metadata.get(item.videoId)?.title || 'Unknown',
            viewCount: item.viewCount,
            rank: index + 1,
            thumbnailUrl: metadata.get(item.videoId)?.thumbnailUrl,
            channelName: metadata.get(item.videoId)?.channelName
          }));

          trending[category] = {
            category,
            videos,
            computedAt: new Date().toISOString()
          };
        }
      });

      await Promise.all(computations);

      // Update cache
      this.cache = trending;

      // Broadcast to all connected clients
      broadcastTrending(trending);
    } catch (err) {
      console.error('Error computing trending:', err);
    }
  }

  private async getVideoMetadata(
    videoIds: string[]
  ): Promise<Map<string, { title: string; thumbnailUrl: string; channelName: string }>> {
    if (videoIds.length === 0) return new Map();

    const result = await pool.query(
      `SELECT id, title, thumbnail_url, channel_name
       FROM videos WHERE id = ANY($1)`,
      [videoIds]
    );

    const map = new Map();
    for (const row of result.rows) {
      map.set(row.id, {
        title: row.title,
        thumbnailUrl: row.thumbnail_url,
        channelName: row.channel_name
      });
    }
    return map;
  }
}

export const trendingService = new TrendingService();
```

## Deep Dive: Error Handling Across Layers (5 minutes)

### Backend: Error Middleware

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { TrendingError } from '@youtube-topk/shared';

interface ErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  stack?: string;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  console.error('Error:', err);

  let response: ErrorResponse;
  let statusCode = 500;

  if (err instanceof ZodError) {
    statusCode = 400;
    response = {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message
      }))
    };
  } else if (err instanceof TrendingError) {
    statusCode = err.statusCode;
    response = {
      code: err.code,
      message: err.message
    };
  } else {
    response = {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : err.message
    };
  }

  // Include stack trace in development
  if (process.env.NODE_ENV !== 'production') {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
```

### Frontend: Error Boundary with Recovery

```tsx
// frontend/src/components/common/ErrorBoundary.tsx
import { Component, ErrorInfo, ReactNode } from 'react';
import { api } from '../../services/api';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.setState({ errorInfo });

    // Report to error tracking service
    // errorTracker.report(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[400px] p-8">
          <div className="text-6xl mb-4">😵</div>
          <h2 className="text-xl font-semibold text-gray-800 mb-2">
            Something went wrong
          </h2>
          <p className="text-gray-600 mb-4 text-center max-w-md">
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Try Again
          </button>

          {process.env.NODE_ENV !== 'production' && this.state.errorInfo && (
            <details className="mt-4 text-sm text-gray-500">
              <summary>Error Details</summary>
              <pre className="mt-2 p-2 bg-gray-100 rounded overflow-auto">
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
```

### Frontend: API Error Handling Hook

```tsx
// frontend/src/hooks/useApiError.ts
import { useState, useCallback } from 'react';
import type { ApiError } from '@youtube-topk/shared';

interface UseApiErrorReturn {
  error: ApiError | null;
  setError: (error: ApiError | null) => void;
  handleError: (err: unknown) => void;
  clearError: () => void;
}

export function useApiError(): UseApiErrorReturn {
  const [error, setError] = useState<ApiError | null>(null);

  const handleError = useCallback((err: unknown) => {
    if (err instanceof Error) {
      // Try to parse as API error
      try {
        const apiError = JSON.parse(err.message) as ApiError;
        setError(apiError);
      } catch {
        setError({
          code: 'UNKNOWN_ERROR',
          message: err.message
        });
      }
    } else {
      setError({
        code: 'UNKNOWN_ERROR',
        message: 'An unexpected error occurred'
      });
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { error, setError, handleError, clearError };
}
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Type sharing | Monorepo package | Build complexity | OpenAPI codegen |
| Real-time | SSE | Simple, unidirectional | WebSocket for bidirectional |
| Validation | Zod (shared) | Bundle size | Separate validation |
| Error format | Structured JSON | Verbose | Simple message strings |
| Optimistic updates | Client-side | Rollback complexity | Wait for server |

### Full-Stack Considerations

```
┌─────────────────────────────────────────────────────────────┐
│                    Type Safety Spectrum                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Loose         Zod Schemas        OpenAPI        GraphQL    │
│  ◄─────────────────────────────────────────────────────────►│
│                                                              │
│  - Fastest dev      (CHOSEN)      - API docs      - Schema  │
│  - More bugs        - Balance     - Codegen       - Tooling │
│  - No codegen       - Manual sync - More setup    - Complex │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Monitoring and Observability (2 minutes)

### Full-Stack Metrics

```typescript
// Backend: Prometheus metrics
const viewsRecorded = new Counter({
  name: 'youtube_topk_views_total',
  labelNames: ['category', 'duplicate']
});

const sseClients = new Gauge({
  name: 'youtube_topk_sse_clients'
});

const apiLatency = new Histogram({
  name: 'youtube_topk_api_latency_seconds',
  labelNames: ['endpoint', 'method', 'status']
});

// Frontend: Web Vitals
import { onCLS, onFID, onLCP } from 'web-vitals';

function sendMetric(metric) {
  navigator.sendBeacon('/api/metrics', JSON.stringify({
    name: metric.name,
    value: metric.value,
    id: metric.id
  }));
}

onCLS(sendMetric);
onFID(sendMetric);
onLCP(sendMetric);
```

### Request Tracing

```typescript
// Shared trace ID across frontend and backend
const traceId = crypto.randomUUID();

// Frontend: Add to request headers
fetch('/api/videos/123/view', {
  headers: { 'X-Trace-ID': traceId }
});

// Backend: Log with trace ID
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || crypto.randomUUID();
  res.setHeader('X-Trace-ID', req.traceId);
  next();
});
```

## Closing Summary (1 minute)

"The YouTube Top K system demonstrates full-stack integration through three key patterns:

1. **Shared type system** - A monorepo package with TypeScript types and Zod schemas ensures frontend and backend stay in sync. Validation logic runs on both sides, catching errors early.

2. **End-to-end view flow** - When a user clicks play, the frontend makes an optimistic update while sending an idempotent request to the backend. The backend validates, deduplicates, and records the view in Redis, with the result propagating back via SSE.

3. **Robust real-time pipeline** - SSE provides simple server-to-client push with automatic reconnection. The backend's TrendingService computes Top K every 5 seconds and broadcasts to all connected clients.

The main trade-off is development velocity vs. type safety. The shared package adds build complexity but catches integration bugs at compile time. For future improvements, I'd add GraphQL for more flexible queries, implement request deduplication at the edge, and add distributed tracing for debugging production issues."
