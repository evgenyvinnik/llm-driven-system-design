# Web Crawler - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design a distributed web crawler system end-to-end. This requires deep full-stack thinking because:

1. **Backend complexity** with URL frontier, distributed workers, and politeness enforcement
2. **Real-time frontend** displaying live crawl statistics and management controls
3. **Data flow** from URL discovery through processing to dashboard visualization
4. **Shared contracts** ensuring type safety across the entire system

The unique challenge is connecting a high-throughput backend crawling system with a reactive monitoring dashboard. Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our distributed crawler with monitoring dashboard:

1. **URL Discovery**: Extract links from pages and queue for crawling
2. **Distributed Crawling**: Workers fetch pages while respecting politeness
3. **Deduplication**: Avoid re-crawling duplicate URLs or content
4. **Admin Dashboard**: Real-time stats, domain management, seed URL control
5. **Worker Monitoring**: Health status and throughput visualization

I'll focus on the end-to-end data flow, API contracts, and real-time communication."

### Non-Functional Requirements

"Key constraints:

- **Scale**: 10,000 pages/second across all workers
- **Latency**: Dashboard updates within 2 seconds of events
- **Reliability**: Workers resume gracefully after failures
- **Usability**: Operators can manage crawl from the dashboard

The system needs both backend efficiency and frontend responsiveness."

---

## High-Level Design (8 minutes)

### End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard (React)                          │
│   Real-time stats │ URL frontier │ Domain mgmt │ Worker monitoring      │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
                    │ REST API                  │ WebSocket
                    ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          API Server (Express)                            │
│   Routes: /api/urls, /api/domains, /api/workers, /api/stats             │
│   WebSocket: /ws/stats (real-time updates)                              │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
        ┌───────────┴───────────┐               │
        ▼                       ▼               ▼
┌───────────────┐      ┌───────────────┐  ┌──────────────┐
│  Coordinator  │      │    Workers    │  │ Stats Agg    │
│               │◄────►│   (1...N)     │  │              │
│ - Assignment  │      │               │  │ - Metrics    │
│ - Scheduling  │      │ - Fetch pages │  │ - Broadcast  │
│ - Health      │      │ - Extract     │  │              │
└───────────────┘      └───────────────┘  └──────────────┘
        │                       │                 │
        └───────────────────────┴─────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  PostgreSQL   │      │     Redis     │      │ Object Store  │
│               │      │               │      │               │
│ - URL frontier│      │ - Bloom filter│      │ - Page content│
│ - Crawl state │      │ - Rate limits │      │ - robots.txt  │
│ - Domain meta │      │ - Pub/Sub     │      │               │
└───────────────┘      └───────────────┘      └───────────────┘
```

### Key Integration Points

**1. URL Submission Flow**: Dashboard -> API -> Frontier DB -> Worker -> API -> Dashboard update
**2. Stats Streaming**: Worker metrics -> Redis Pub/Sub -> Stats Aggregator -> WebSocket -> Dashboard
**3. Domain Control**: Dashboard -> API -> Redis (rate limits) + PostgreSQL (config)

---

## Deep Dive: Shared Type Definitions (6 minutes)

### API Contract Types

```typescript
// shared/types.ts - Used by both frontend and backend

// URL Frontier types
export interface FrontierURL {
  id: number;
  url: string;
  urlHash: string;
  domain: string;
  priority: Priority;
  depth: number;
  status: URLStatus;
  discoveredAt: string;
  scheduledAt: string | null;
  workerId: string | null;
}

export type Priority = 'high' | 'medium' | 'low';
export type URLStatus = 'pending' | 'processing' | 'completed' | 'failed';

// Domain types
export interface Domain {
  id: number;
  domain: string;
  robotsTxt: string | null;
  robotsFetchedAt: string | null;
  crawlDelayMs: number;
  lastCrawlAt: string | null;
  totalPages: number;
  avgResponseMs: number;
  isBlocked: boolean;
}

// Worker types
export interface Worker {
  id: string;
  status: WorkerStatus;
  urlsProcessed: number;
  currentDomain: string | null;
  uptimeSeconds: number;
  lastHeartbeat: string;
}

export type WorkerStatus = 'active' | 'idle' | 'error';

// Real-time stats
export interface CrawlStats {
  urlsPerSecond: number;
  queueDepth: number;
  activeWorkers: number;
  failedToday: number;
  totalCrawled: number;
  byPriority: {
    high: number;
    medium: number;
    low: number;
  };
}

// API response wrappers
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasNext: boolean;
  };
}

export interface APIError {
  error: string;
  code: string;
  details?: Record<string, string>;
}

// Request types
export interface AddSeedURLsRequest {
  urls: string[];
  priority?: Priority;
}

export interface UpdateDomainRequest {
  crawlDelayMs?: number;
  isBlocked?: boolean;
}

export interface URLFilters {
  search?: string;
  status?: URLStatus;
  priority?: Priority;
  domain?: string;
}
```

### Zod Schemas for Validation

```typescript
// shared/validation.ts
import { z } from 'zod';

export const prioritySchema = z.enum(['high', 'medium', 'low']);
export const urlStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed']);

export const addSeedURLsSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(1000),
  priority: prioritySchema.optional().default('medium')
});

export const updateDomainSchema = z.object({
  crawlDelayMs: z.number().min(500).max(60000).optional(),
  isBlocked: z.boolean().optional()
});

export const urlFiltersSchema = z.object({
  search: z.string().optional(),
  status: urlStatusSchema.optional(),
  priority: prioritySchema.optional(),
  domain: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(10).max(100).default(50)
});

// Type inference from schemas
export type AddSeedURLsInput = z.infer<typeof addSeedURLsSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type URLFiltersInput = z.infer<typeof urlFiltersSchema>;
```

---

## Deep Dive: End-to-End URL Submission Flow (10 minutes)

### Backend: Seed URL API

```typescript
// backend/src/api/routes/urls.ts
import { Router } from 'express';
import { createHash } from 'crypto';
import { addSeedURLsSchema } from '../../../shared/validation';
import { pool } from '../../shared/db';
import { urlDeduplicator } from '../../shared/dedup';

const router = Router();

router.post('/seed', async (req, res) => {
  // Validate request
  const parseResult = addSeedURLsSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: parseResult.error.flatten().fieldErrors
    });
  }

  const { urls, priority } = parseResult.data;

  // Filter out duplicates
  const newUrls: Array<{ url: string; hash: string; domain: string }> = [];

  for (const url of urls) {
    const normalized = normalizeURL(url);
    const hash = createHash('sha256').update(normalized).digest('hex');

    // Check Bloom filter first (fast)
    const seen = await urlDeduplicator.isURLSeen(normalized);
    if (!seen) {
      const domain = new URL(normalized).hostname;
      newUrls.push({ url: normalized, hash, domain });
    }
  }

  if (newUrls.length === 0) {
    return res.json({
      added: 0,
      duplicates: urls.length,
      message: 'All URLs already in frontier'
    });
  }

  // Batch insert to frontier
  const priorityValue = priority === 'high' ? 0 : priority === 'medium' ? 1 : 2;

  const insertQuery = `
    INSERT INTO url_frontier (url, url_hash, domain, priority, depth, status)
    VALUES ${newUrls.map((_, i) => `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4}, 0, 'pending')`).join(', ')}
    ON CONFLICT (url_hash) DO NOTHING
    RETURNING id
  `;

  const params = newUrls.flatMap((u) => [u.url, u.hash, u.domain, priorityValue]);

  const result = await pool.query(insertQuery, params);

  // Mark URLs as seen in Bloom filter
  for (const u of newUrls) {
    await urlDeduplicator.markURLSeen(u.url);
  }

  // Broadcast update to dashboard
  statsEmitter.emit('frontier-update', {
    added: result.rowCount,
    priority
  });

  return res.json({
    added: result.rowCount,
    duplicates: urls.length - result.rowCount,
    message: `Added ${result.rowCount} new URLs to frontier`
  });
});

function normalizeURL(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  let path = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
}

export default router;
```

### Frontend: Seed URL Modal

```tsx
// frontend/src/components/frontier/SeedURLModal.tsx
import { useState } from 'react';
import { useFrontierStore } from '../../stores/frontierStore';
import type { Priority } from '../../../shared/types';

interface SeedURLModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SeedURLModal({ isOpen, onClose }: SeedURLModalProps) {
  const [urlInput, setUrlInput] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<{ added: number; duplicates: number } | null>(null);

  const { addSeedURLs } = useFrontierStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setResult(null);

    // Parse URLs (one per line)
    const urls = urlInput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && isValidURL(line));

    if (urls.length === 0) {
      setIsSubmitting(false);
      return;
    }

    try {
      const response = await addSeedURLs({ urls, priority });
      setResult({ added: response.added, duplicates: response.duplicates });

      if (response.added > 0) {
        // Clear input after successful add
        setTimeout(() => {
          setUrlInput('');
          setResult(null);
          onClose();
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to add seed URLs:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Add Seed URLs</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-4 space-y-4">
            {/* URL input */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                URLs (one per line)
              </label>
              <textarea
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                rows={10}
                className="w-full border rounded-lg p-3 font-mono text-sm focus:ring-2 focus:ring-blue-500"
                placeholder="https://example.com&#10;https://example.com/page&#10;https://other-site.com"
              />
              <p className="text-sm text-gray-500 mt-1">
                {urlInput.split('\n').filter((l) => l.trim()).length} URLs entered
              </p>
            </div>

            {/* Priority selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Priority
              </label>
              <div className="flex gap-4">
                {(['high', 'medium', 'low'] as Priority[]).map((p) => (
                  <label key={p} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="priority"
                      value={p}
                      checked={priority === p}
                      onChange={() => setPriority(p)}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    <span className="capitalize">{p}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Result message */}
            {result && (
              <div className={`p-3 rounded-lg ${
                result.added > 0 ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
              }`}>
                Added {result.added} URLs
                {result.duplicates > 0 && ` (${result.duplicates} duplicates skipped)`}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border rounded-lg hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Adding...' : 'Add URLs'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function isValidURL(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}
```

### API Client with Type Safety

```typescript
// frontend/src/services/api.ts
import type {
  FrontierURL,
  Domain,
  Worker,
  CrawlStats,
  PaginatedResponse,
  AddSeedURLsRequest,
  UpdateDomainRequest,
  URLFilters
} from '../../shared/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    credentials: 'include',
    ...options
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'API request failed');
  }

  return response.json();
}

export const api = {
  // URL Frontier
  getURLs: (filters: URLFilters) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) params.set(key, String(value));
    });
    return request<PaginatedResponse<FrontierURL>>(`/urls?${params}`);
  },

  addSeedURLs: (data: AddSeedURLsRequest) =>
    request<{ added: number; duplicates: number; message: string }>('/urls/seed', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  deleteURL: (id: number) =>
    request<void>(`/urls/${id}`, { method: 'DELETE' }),

  // Domains
  getDomains: (page = 1, pageSize = 50) =>
    request<PaginatedResponse<Domain>>(`/domains?page=${page}&pageSize=${pageSize}`),

  getDomain: (domain: string) =>
    request<Domain>(`/domains/${encodeURIComponent(domain)}`),

  updateDomain: (domain: string, data: UpdateDomainRequest) =>
    request<Domain>(`/domains/${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    }),

  // Workers
  getWorkers: () =>
    request<Worker[]>('/workers'),

  // Stats
  getStats: () =>
    request<CrawlStats>('/stats')
};
```

---

## Deep Dive: Real-Time Stats with WebSocket (8 minutes)

### Backend: WebSocket Server

```typescript
// backend/src/api/websocket.ts
import { WebSocketServer, WebSocket } from 'ws';
import { Redis } from 'ioredis';
import type { Server } from 'http';
import type { CrawlStats } from '../../shared/types';

const redis = new Redis(process.env.REDIS_URL);
const subscriber = new Redis(process.env.REDIS_URL);

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws/stats' });

  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`WebSocket client connected. Total: ${clients.size}`);

    // Send initial stats immediately
    sendCurrentStats(ws);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`WebSocket client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });

  // Subscribe to Redis for stats updates
  subscriber.subscribe('crawler:stats');
  subscriber.on('message', (channel, message) => {
    if (channel === 'crawler:stats') {
      broadcast(clients, message);
    }
  });

  // Periodic stats broadcast (fallback for clients missing pub/sub)
  setInterval(() => {
    broadcastCurrentStats(clients);
  }, 2000);

  return wss;
}

async function sendCurrentStats(ws: WebSocket) {
  const stats = await aggregateStats();
  ws.send(JSON.stringify(stats));
}

async function broadcastCurrentStats(clients: Set<WebSocket>) {
  if (clients.size === 0) return;

  const stats = await aggregateStats();
  const message = JSON.stringify(stats);
  broadcast(clients, message);
}

function broadcast(clients: Set<WebSocket>, message: string) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

async function aggregateStats(): Promise<CrawlStats> {
  const pipeline = redis.pipeline();

  pipeline.get('stats:urls_per_second');
  pipeline.get('stats:queue_depth');
  pipeline.scard('workers:active');
  pipeline.get('stats:failed_today');
  pipeline.get('stats:total_crawled');
  pipeline.get('stats:priority:high');
  pipeline.get('stats:priority:medium');
  pipeline.get('stats:priority:low');

  const results = await pipeline.exec();

  return {
    urlsPerSecond: parseFloat(results?.[0]?.[1] as string) || 0,
    queueDepth: parseInt(results?.[1]?.[1] as string) || 0,
    activeWorkers: (results?.[2]?.[1] as number) || 0,
    failedToday: parseInt(results?.[3]?.[1] as string) || 0,
    totalCrawled: parseInt(results?.[4]?.[1] as string) || 0,
    byPriority: {
      high: parseInt(results?.[5]?.[1] as string) || 0,
      medium: parseInt(results?.[6]?.[1] as string) || 0,
      low: parseInt(results?.[7]?.[1] as string) || 0
    }
  };
}
```

### Backend: Worker Stats Publishing

```typescript
// backend/src/worker/stats.ts
import { Redis } from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const publisher = new Redis(process.env.REDIS_URL);

export class WorkerStats {
  private workerId: string;
  private urlsProcessed = 0;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  start() {
    // Register worker
    redis.sadd('workers:active', this.workerId);
    redis.hset(`worker:${this.workerId}`, {
      status: 'active',
      startedAt: Date.now().toString(),
      urlsProcessed: '0'
    });

    // Heartbeat every 5 seconds
    this.intervalId = setInterval(() => this.heartbeat(), 5000);
  }

  async recordCrawl(domain: string, success: boolean, responseTimeMs: number) {
    this.urlsProcessed++;

    const pipeline = redis.pipeline();

    // Update worker stats
    pipeline.hset(`worker:${this.workerId}`, {
      urlsProcessed: this.urlsProcessed.toString(),
      currentDomain: domain,
      lastHeartbeat: Date.now().toString()
    });

    // Update global counters
    pipeline.incr('stats:total_crawled');
    if (!success) {
      pipeline.incr('stats:failed_today');
    }

    // Update throughput sliding window
    const now = Math.floor(Date.now() / 1000);
    pipeline.zadd('stats:throughput', now.toString(), `${now}:${this.urlsProcessed}`);
    pipeline.zremrangebyscore('stats:throughput', '-inf', (now - 60).toString());

    await pipeline.exec();

    // Publish update for real-time dashboard
    publisher.publish('crawler:stats', JSON.stringify({ type: 'crawl', domain, success }));
  }

  private async heartbeat() {
    // Calculate URLs per second from sliding window
    const now = Math.floor(Date.now() / 1000);
    const minuteAgo = now - 60;

    const counts = await redis.zrangebyscore('stats:throughput', minuteAgo, now);
    const urlsPerSecond = counts.length / 60;

    await redis.set('stats:urls_per_second', urlsPerSecond.toFixed(2));

    // Update queue depth
    const queueDepth = await redis.get('queue:pending_count');
    await redis.set('stats:queue_depth', queueDepth || '0');

    // Extend worker TTL
    await redis.expire(`worker:${this.workerId}`, 30);
  }

  async stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    await redis.srem('workers:active', this.workerId);
    await redis.del(`worker:${this.workerId}`);
  }
}
```

### Frontend: WebSocket Hook

```typescript
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { useStatsStore } from '../stores/statsStore';

export function useStatsWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();
  const { updateStats, setConnected } = useStatsStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3000/ws/stats';
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
      // Clear any pending reconnect
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };

    ws.onmessage = (event) => {
      try {
        const stats = JSON.parse(event.data);
        updateStats(stats);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
      // Reconnect after 3 seconds
      reconnectTimeoutRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      ws.close();
    };

    wsRef.current = ws;
  }, [updateStats, setConnected]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    wsRef.current?.close();
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return { connect, disconnect };
}
```

---

## Deep Dive: Domain Management Flow (6 minutes)

### Sequence Diagram

```
Dashboard                API Server               Redis              PostgreSQL
    │                        │                      │                     │
    │  PATCH /domains/foo    │                      │                     │
    │  {crawlDelayMs: 2000}  │                      │                     │
    │───────────────────────►│                      │                     │
    │                        │                      │                     │
    │                        │  SET crawldelay:foo  │                     │
    │                        │───────────────────►  │                     │
    │                        │                      │                     │
    │                        │                      │                     │
    │                        │  UPDATE domains      │                     │
    │                        │──────────────────────────────────────────► │
    │                        │                      │                     │
    │                        │  PUBLISH domain:update                     │
    │                        │───────────────────►  │                     │
    │                        │                      │                     │
    │  200 OK {domain}       │                      │                     │
    │◄───────────────────────│                      │                     │
    │                        │                      │                     │
    │  WebSocket: domain     │                      │                     │
    │  update notification   │◄──────────────────── │                     │
    │◄───────────────────────│                      │                     │
```

### Backend: Domain Update Endpoint

```typescript
// backend/src/api/routes/domains.ts
import { Router } from 'express';
import { updateDomainSchema } from '../../../shared/validation';
import { pool } from '../../shared/db';
import { redis, publisher } from '../../shared/cache';

const router = Router();

router.patch('/:domain', async (req, res) => {
  const { domain } = req.params;

  // Validate input
  const parseResult = updateDomainSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: parseResult.error.flatten().fieldErrors
    });
  }

  const { crawlDelayMs, isBlocked } = parseResult.data;

  // Check domain exists
  const existing = await pool.query(
    'SELECT * FROM domains WHERE domain = $1',
    [domain]
  );

  if (existing.rows.length === 0) {
    return res.status(404).json({
      error: 'Domain not found',
      code: 'NOT_FOUND'
    });
  }

  // Build update query dynamically
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (crawlDelayMs !== undefined) {
    updates.push(`crawl_delay = $${paramIndex++}`);
    values.push(crawlDelayMs);

    // Also update Redis for immediate effect on workers
    await redis.set(`crawldelay:${domain}`, crawlDelayMs.toString());
  }

  if (isBlocked !== undefined) {
    updates.push(`is_blocked = $${paramIndex++}`);
    values.push(isBlocked);

    // If blocking, also update Redis
    if (isBlocked) {
      await redis.sadd('blocked_domains', domain);
    } else {
      await redis.srem('blocked_domains', domain);
    }
  }

  values.push(domain);

  const result = await pool.query(`
    UPDATE domains
    SET ${updates.join(', ')}
    WHERE domain = $${paramIndex}
    RETURNING *
  `, values);

  const updatedDomain = result.rows[0];

  // Publish update for real-time notifications
  await publisher.publish('domain:update', JSON.stringify({
    domain,
    changes: parseResult.data
  }));

  // Map to API response format
  res.json({
    id: updatedDomain.id,
    domain: updatedDomain.domain,
    robotsTxt: updatedDomain.robots_txt,
    robotsFetchedAt: updatedDomain.robots_fetched_at,
    crawlDelayMs: updatedDomain.crawl_delay,
    lastCrawlAt: updatedDomain.last_crawl_at,
    totalPages: updatedDomain.total_pages,
    avgResponseMs: updatedDomain.avg_response_ms,
    isBlocked: updatedDomain.is_blocked
  });
});

export default router;
```

---

## Error Handling Across the Stack (4 minutes)

### Backend: Consistent Error Responses

```typescript
// backend/src/api/middleware/errorHandler.ts
import { ErrorRequestHandler } from 'express';

interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: Record<string, string>;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  console.error('Error:', err);

  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  res.status(statusCode).json({
    error: message,
    code,
    details: err.details,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// Custom error classes
export class ValidationError extends Error {
  statusCode = 400;
  code = 'VALIDATION_ERROR';
  constructor(message: string, public details?: Record<string, string>) {
    super(message);
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
  code = 'NOT_FOUND';
  constructor(resource: string) {
    super(`${resource} not found`);
  }
}

export class RateLimitError extends Error {
  statusCode = 429;
  code = 'RATE_LIMITED';
  constructor(public retryAfter: number) {
    super('Too many requests');
  }
}
```

### Frontend: Error Boundary and Toast Notifications

```tsx
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
    console.error('Error boundary caught:', error, info);
    // Could send to error tracking service
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="min-h-screen flex items-center justify-center bg-gray-100">
          <div className="bg-white p-8 rounded-lg shadow-lg max-w-md text-center">
            <h1 className="text-2xl font-bold text-red-600 mb-4">Something went wrong</h1>
            <p className="text-gray-600 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Toast notifications for API errors
import { create } from 'zustand';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning';
  message: string;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Math.random().toString(36).slice(2);
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    // Auto-remove after 5 seconds
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  },
  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  }
}));
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-time Protocol | WebSocket | SSE | Bidirectional future extensibility |
| Type Sharing | Shared folder | OpenAPI codegen | Simpler, no build step |
| Validation | Zod | io-ts | Better DX, TypeScript integration |
| State Updates | Zustand + WebSocket | React Query | More control over streaming data |
| Error Handling | Custom classes | HTTP Problem Details | Simpler implementation |

---

## Future Enhancements

With more time, I would add:

1. **OpenAPI spec generation** from Zod schemas for client codegen
2. **Optimistic updates** for domain management actions
3. **Request retries** with exponential backoff in API client
4. **GraphQL subscriptions** as alternative to WebSocket
5. **End-to-end testing** with Playwright for critical flows

---

## Summary

"I've designed a distributed web crawler with full-stack integration:

1. **Shared TypeScript types** ensuring API contract consistency
2. **End-to-end URL flow** from dashboard submission through worker processing
3. **Real-time WebSocket** streaming crawler stats to dashboard
4. **Domain management** with immediate Redis updates for workers
5. **Consistent error handling** with typed errors and toast notifications

The architecture prioritizes type safety and real-time visibility while maintaining clean separation between frontend and backend responsibilities."
