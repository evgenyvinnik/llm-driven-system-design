# Rate Limiter - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a distributed rate limiting service with both a robust backend and an interactive dashboard. As a fullstack engineer, I'll focus on the end-to-end rate limit check flow, the API contract between frontend and backend, session-based configuration, and how the dashboard integrates with the rate limiting service. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Request Counting** - Track requests per client/API key across distributed servers
2. **Multiple Algorithms** - Support fixed window, sliding window, token bucket, leaky bucket
3. **Dashboard** - Configure rules, visualize metrics, test rate limits
4. **Response Headers** - Return X-RateLimit-* headers to clients
5. **Batch Testing** - Send multiple requests to observe rate limiting behavior

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **Real-time Dashboard** - Metrics update within 5 seconds
- **Consistency** - Limits respected within 1-5% tolerance
- **Usability** - Intuitive UI for algorithm selection and testing

### Fullstack Considerations

- API contract design between frontend and backend
- Error handling and loading states
- State synchronization between UI and server
- Response header propagation to dashboard

---

## 2. High-Level Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                    Frontend Dashboard (React)                     |
|  +----------------+  +----------------+  +---------------------+  |
|  | Algorithm      |  |    Metrics     |  |  Request Tester     |  |
|  | Configuration  |  |    Charts      |  |  (Test + Headers)   |  |
|  +-------+--------+  +-------+--------+  +---------+-----------+  |
|          |                   |                     |              |
|          +-------------------+---------------------+              |
|                              |                                    |
|                   +----------v-----------+                        |
|                   |    Zustand Store     |                        |
|                   +----------+-----------+                        |
+---------------------------|-----------------------------------+---+
                            |
                            v REST API
+------------------------------------------------------------------+
|                    Backend API (Express)                          |
|  +----------------+  +----------------+  +---------------------+  |
|  | Rate Limit     |  |    Metrics     |  |   Check Endpoint    |  |
|  | Middleware     |  |    Endpoint    |  |   POST /check       |  |
|  +-------+--------+  +-------+--------+  +---------+-----------+  |
|          |                   |                     |              |
|          +-------------------+---------------------+              |
|                              |                                    |
|                   +----------v-----------+                        |
|                   |  Algorithm Factory   |                        |
|                   +----------+-----------+                        |
+---------------------------|-----------------------------------+---+
                            |
              +-------------+-------------+
              |                           |
    +---------v---------+     +-----------v-----------+
    |   Redis Cluster   |     |     PostgreSQL        |
    |  (Rate Counters)  |     |   (Rules, Metrics)    |
    +-------------------+     +-----------------------+
```

---

## 3. Deep Dive: API Contract Design (8 minutes)

### Endpoint Definitions

```typescript
// POST /api/ratelimit/check - Check and consume rate limit
interface CheckRequest {
  identifier: string;
  algorithm: 'fixed' | 'sliding' | 'token' | 'leaky';
  limit?: number;
  windowSeconds?: number;
  burstCapacity?: number;
  refillRate?: number;
  leakRate?: number;
}

interface CheckResponse {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;      // Unix timestamp
  algorithm: string;
  latencyMs: number;
}

// GET /api/ratelimit/state/:identifier - Get state without consuming
interface StateResponse {
  identifier: string;
  algorithm: string;
  currentCount: number;
  limit: number;
  remaining: number;
  resetAt: number;
  tokens?: number;      // For token bucket
  water?: number;       // For leaky bucket
}

// DELETE /api/ratelimit/reset/:identifier - Reset rate limit
interface ResetResponse {
  success: boolean;
  identifier: string;
}

// POST /api/ratelimit/batch-check - Check multiple identifiers
interface BatchCheckRequest {
  checks: CheckRequest[];
}

interface BatchCheckResponse {
  results: CheckResponse[];
  totalLatencyMs: number;
}

// GET /api/metrics - Get aggregated metrics
interface MetricsResponse {
  points: MetricPoint[];
  summary: {
    totalChecks: number;
    allowedPercent: number;
    deniedPercent: number;
    avgLatencyMs: number;
    p99LatencyMs: number;
  };
}

interface MetricPoint {
  timestamp: number;
  allowed: number;
  denied: number;
  p50Latency: number;
  p99Latency: number;
}
```

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
Retry-After: 45  (only when status 429)
```

---

## 4. Deep Dive: End-to-End Rate Check Flow (10 minutes)

### Complete Request Flow

```
Frontend                   Backend                    Redis
   |                          |                         |
   | 1. POST /check           |                         |
   | { identifier, algorithm, |                         |
   |   limit, windowSeconds } |                         |
   |------------------------->|                         |
   |                          |                         |
   |                          | 2. Check algorithm      |
   |                          | 3. Execute Lua script   |
   |                          |------------------------>|
   |                          |                         |
   |                          | 4. Atomic check+update  |
   |                          |<------------------------|
   |                          | { allowed, remaining }  |
   |                          |                         |
   |                          | 5. Record metrics       |
   |                          |------------------------>|
   |                          |                         |
   | 6. Response + headers    |                         |
   |<-------------------------|                         |
   | { allowed, remaining,    |                         |
   |   resetAt, latencyMs }   |                         |
   |                          |                         |
   | 7. Update UI state       |                         |
   v                          v                         v
```

### Backend: Check Endpoint Implementation

```typescript
// routes/ratelimit.ts
router.post('/check', async (req: Request, res: Response) => {
  const start = performance.now();

  const {
    identifier,
    algorithm,
    limit = 10,
    windowSeconds = 60,
    burstCapacity = 10,
    refillRate = 1,
    leakRate = 1
  } = req.body;

  // Validate input
  if (!identifier || !algorithm) {
    return res.status(400).json({
      error: 'identifier and algorithm are required'
    });
  }

  let result: RateLimitResult;

  try {
    // Select and execute algorithm
    switch (algorithm) {
      case 'fixed':
        result = await fixedWindowCheck(identifier, limit, windowSeconds);
        break;
      case 'sliding':
        result = await slidingWindowCheck(identifier, limit, windowSeconds);
        break;
      case 'token':
        result = await tokenBucketCheck(identifier, burstCapacity, refillRate);
        break;
      case 'leaky':
        result = await leakyBucketCheck(identifier, burstCapacity, leakRate);
        break;
      default:
        return res.status(400).json({ error: 'Invalid algorithm' });
    }
  } catch (error) {
    // Circuit breaker fallback
    logger.warn('Rate limit check failed', { identifier, error });
    result = { allowed: true, remaining: -1, resetAt: Date.now() + 60000 };
  }

  const latencyMs = performance.now() - start;

  // Record metrics asynchronously
  recordMetrics(algorithm, result.allowed, latencyMs);

  // Set response headers
  res.set({
    'X-RateLimit-Limit': limit || burstCapacity,
    'X-RateLimit-Remaining': Math.max(0, result.remaining),
    'X-RateLimit-Reset': Math.ceil(result.resetAt / 1000),
    'X-RateLimit-Algorithm': algorithm
  });

  if (!result.allowed) {
    res.set('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
  }

  const status = result.allowed ? 200 : 429;

  res.status(status).json({
    allowed: result.allowed,
    remaining: result.remaining,
    limit: limit || burstCapacity,
    resetAt: result.resetAt,
    algorithm,
    latencyMs
  });
});
```

### Frontend: API Service Layer

```typescript
// services/rateLimitApi.ts
const BASE_URL = '/api/ratelimit';

export async function checkRateLimit(
  params: CheckRequest
): Promise<CheckResponse> {
  const start = performance.now();

  const response = await fetch(`${BASE_URL}/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await response.json();

  // Capture actual latency (includes network)
  const clientLatencyMs = performance.now() - start;

  return {
    ...data,
    clientLatencyMs,
    // Extract headers
    headers: {
      limit: response.headers.get('X-RateLimit-Limit'),
      remaining: response.headers.get('X-RateLimit-Remaining'),
      reset: response.headers.get('X-RateLimit-Reset'),
      algorithm: response.headers.get('X-RateLimit-Algorithm'),
      retryAfter: response.headers.get('Retry-After')
    }
  };
}

export async function getState(identifier: string): Promise<StateResponse> {
  const response = await fetch(`${BASE_URL}/state/${encodeURIComponent(identifier)}`);
  return response.json();
}

export async function resetLimit(identifier: string): Promise<ResetResponse> {
  const response = await fetch(`${BASE_URL}/reset/${encodeURIComponent(identifier)}`, {
    method: 'DELETE'
  });
  return response.json();
}

export async function batchCheck(checks: CheckRequest[]): Promise<BatchCheckResponse> {
  const response = await fetch(`${BASE_URL}/batch-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checks })
  });
  return response.json();
}

export async function fetchMetrics(): Promise<MetricsResponse> {
  const response = await fetch('/api/metrics');
  return response.json();
}
```

### Frontend: Store Integration

```typescript
// store/rateLimiterStore.ts
export const useRateLimiterStore = create<RateLimiterState>((set, get) => ({
  // ... state definition

  runTest: async () => {
    const { selectedAlgorithm, config } = get();

    try {
      const result = await checkRateLimit({
        identifier: config.identifier,
        algorithm: selectedAlgorithm,
        limit: config.limit,
        windowSeconds: config.windowSeconds,
        burstCapacity: config.burstCapacity,
        refillRate: config.refillRate,
        leakRate: config.leakRate
      });

      const testResult: TestResult = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        allowed: result.allowed,
        remaining: result.remaining,
        limit: result.limit,
        resetAt: result.resetAt,
        latencyMs: result.latencyMs,
        headers: result.headers
      };

      set((state) => ({
        testResults: [testResult, ...state.testResults].slice(0, 100)
      }));

    } catch (error) {
      set((state) => ({
        testResults: [{
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          allowed: false,
          error: error.message,
          remaining: 0,
          limit: 0,
          resetAt: 0,
          latencyMs: 0
        }, ...state.testResults].slice(0, 100)
      }));
    }
  },

  fetchMetrics: async () => {
    set({ metricsLoading: true });
    try {
      const response = await fetchMetrics();
      set({
        metrics: response.points,
        metricsSummary: response.summary,
        metricsLoading: false
      });
    } catch (error) {
      set({ metricsLoading: false, metricsError: error.message });
    }
  }
}));
```

---

## 5. Deep Dive: Error Handling (6 minutes)

### Backend: Centralized Error Handling

```typescript
// middleware/errorHandler.ts
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log error
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  // Determine status code
  let status = 500;
  let code = 'INTERNAL_ERROR';

  if (err instanceof ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
  } else if (err instanceof NotFoundError) {
    status = 404;
    code = 'NOT_FOUND';
  } else if (err instanceof RateLimitError) {
    status = 429;
    code = 'RATE_LIMITED';
  }

  res.status(status).json({
    error: code,
    message: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
}
```

### Frontend: Error Boundary and Toast

```tsx
// components/ErrorBoundary.tsx
export function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [error, setError] = useState<Error | null>(null);

  if (error) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-red-600 mb-2">
          Something went wrong
        </h2>
        <p className="text-gray-600 mb-4">{error.message}</p>
        <button
          onClick={() => setError(null)}
          className="px-4 py-2 bg-blue-500 text-white rounded"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <ErrorBoundaryReact
      fallbackRender={({ error }) => {
        setError(error);
        return null;
      }}
    >
      {children}
    </ErrorBoundaryReact>
  );
}

// hooks/useToast.ts
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const showError = useCallback((error: Error | string) => {
    const message = typeof error === 'string' ? error : error.message;
    showToast(message, 'error');
  }, [showToast]);

  return { toasts, showToast, showError };
}
```

---

## 6. Deep Dive: Metrics Synchronization (5 minutes)

### Backend: Metrics Collection

```typescript
// services/metricsService.ts
interface MetricsBucket {
  timestamp: number;
  allowed: number;
  denied: number;
  latencies: number[];
}

class MetricsService {
  private buckets = new Map<number, MetricsBucket>();
  private readonly BUCKET_SIZE_MS = 60000; // 1 minute

  record(allowed: boolean, latencyMs: number): void {
    const bucketKey = Math.floor(Date.now() / this.BUCKET_SIZE_MS);

    if (!this.buckets.has(bucketKey)) {
      this.buckets.set(bucketKey, {
        timestamp: bucketKey * this.BUCKET_SIZE_MS,
        allowed: 0,
        denied: 0,
        latencies: []
      });

      // Clean old buckets
      this.cleanup();
    }

    const bucket = this.buckets.get(bucketKey)!;
    if (allowed) {
      bucket.allowed++;
    } else {
      bucket.denied++;
    }
    bucket.latencies.push(latencyMs);
  }

  getMetrics(): MetricsResponse {
    const points: MetricPoint[] = [];

    for (const bucket of this.buckets.values()) {
      const sortedLatencies = [...bucket.latencies].sort((a, b) => a - b);

      points.push({
        timestamp: bucket.timestamp,
        allowed: bucket.allowed,
        denied: bucket.denied,
        p50Latency: this.percentile(sortedLatencies, 50),
        p99Latency: this.percentile(sortedLatencies, 99)
      });
    }

    points.sort((a, b) => a.timestamp - b.timestamp);

    const totalAllowed = points.reduce((sum, p) => sum + p.allowed, 0);
    const totalDenied = points.reduce((sum, p) => sum + p.denied, 0);
    const total = totalAllowed + totalDenied;

    return {
      points,
      summary: {
        totalChecks: total,
        allowedPercent: total > 0 ? (totalAllowed / total) * 100 : 100,
        deniedPercent: total > 0 ? (totalDenied / total) * 100 : 0,
        avgLatencyMs: this.calculateAvgLatency(points),
        p99LatencyMs: Math.max(...points.map(p => p.p99Latency), 0)
      }
    };
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const index = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, index)];
  }

  private cleanup(): void {
    const cutoff = Date.now() - (60 * 60 * 1000); // 1 hour
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.timestamp < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

export const metricsService = new MetricsService();
```

### Frontend: Polling with Auto-Refresh

```typescript
// hooks/useMetricsPolling.ts
export function useMetricsPolling(intervalMs = 5000) {
  const { fetchMetrics } = useRateLimiterStore();
  const [isPolling, setIsPolling] = useState(true);

  useEffect(() => {
    if (!isPolling) return;

    // Initial fetch
    fetchMetrics();

    const interval = setInterval(fetchMetrics, intervalMs);

    return () => clearInterval(interval);
  }, [fetchMetrics, intervalMs, isPolling]);

  return { isPolling, setIsPolling };
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| API style | REST | Stateless, cacheable | GraphQL (flexible queries) |
| Metrics delivery | Polling (5s) | Simple, reliable | WebSocket (real-time) |
| Error handling | Centralized | Consistent format | Per-route (flexible) |
| State sync | Optimistic UI | Fast feedback | Wait for confirmation |
| Header passing | Response headers | Standard approach | Body only (simpler) |

---

## 8. Testing Strategy

### Backend Integration Tests

```typescript
// tests/ratelimit.test.ts
describe('Rate Limit API', () => {
  it('should allow requests under limit', async () => {
    const response = await request(app)
      .post('/api/ratelimit/check')
      .send({
        identifier: 'test-user',
        algorithm: 'sliding',
        limit: 10,
        windowSeconds: 60
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.remaining).toBe(9);
    expect(response.headers['x-ratelimit-limit']).toBe('10');
  });

  it('should deny requests over limit', async () => {
    // Exhaust limit
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/ratelimit/check')
        .send({ identifier: 'test-user-2', algorithm: 'fixed', limit: 10 });
    }

    const response = await request(app)
      .post('/api/ratelimit/check')
      .send({ identifier: 'test-user-2', algorithm: 'fixed', limit: 10 });

    expect(response.status).toBe(429);
    expect(response.body.allowed).toBe(false);
    expect(response.headers['retry-after']).toBeDefined();
  });
});
```

### Frontend Component Tests

```typescript
// tests/RequestTester.test.tsx
describe('RequestTester', () => {
  it('should display test results', async () => {
    render(<RequestTester />);

    // Mock API response
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 9,
      limit: 10,
      resetAt: Date.now() + 60000,
      latencyMs: 2.5
    });

    await userEvent.click(screen.getByText('Send Request'));

    await waitFor(() => {
      expect(screen.getByText('Allowed')).toBeInTheDocument();
      expect(screen.getByText('X-RateLimit-Remaining: 9')).toBeInTheDocument();
    });
  });
});
```

---

## 9. Future Enhancements

1. **WebSocket Metrics** - Real-time streaming instead of polling
2. **Rule Configuration UI** - Visual editor for rate limit rules
3. **Comparison Mode** - Test same request with multiple algorithms
4. **Export/Import** - Save and share configurations
5. **API Documentation** - Swagger/OpenAPI integration

---

## Summary

"To summarize, I've designed a fullstack rate limiting service with:

1. **Clean API contract** with typed request/response interfaces and standard rate limit headers
2. **End-to-end flow** from dashboard configuration through Redis-based limiting to UI feedback
3. **Comprehensive error handling** with centralized backend handler and frontend error boundaries
4. **Metrics synchronization** using polling with automatic refresh for near-real-time dashboard updates
5. **Algorithm selection UI** with visual animations and immediate test feedback
6. **Testing strategy** covering both backend integration and frontend components

The key insight is that a rate limiter is only useful if developers can understand and configure it correctly. The interactive dashboard with visual algorithm demos and live testing makes the abstract concepts of token buckets and sliding windows concrete and intuitive, while the clean API contract ensures reliable integration with client applications."
