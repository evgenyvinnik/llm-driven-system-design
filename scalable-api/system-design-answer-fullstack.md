# Scalable API - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design a scalable API platform with an admin dashboard, implementing rate limiting, caching, and real-time monitoring across both frontend and backend."

This is a **full-stack problem** requiring expertise in:
- End-to-end request flow through multiple layers
- API design with proper error handling and headers
- Real-time data synchronization between server and UI
- Session management and authentication
- Graceful degradation across the stack

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- API key management (create, revoke, view usage)
- Tiered rate limiting with usage tracking
- Real-time metrics dashboard
- Request logging and analytics
- Health monitoring for all services

### Non-Functional Requirements
- **Latency**: P99 < 100ms for cached API responses
- **Throughput**: 100K+ requests per minute
- **Availability**: 99.9% uptime
- **Dashboard Refresh**: Metrics update every 5 seconds

### Full-Stack Clarifications
- "Authentication flow?" - API keys for public API, sessions for admin dashboard
- "How does rate limit state reach the UI?" - Headers on API responses, polling for dashboard
- "Error handling?" - Consistent error format, appropriate HTTP status codes
- "Caching coordination?" - Backend cache with frontend stale-while-revalidate

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ADMIN DASHBOARD                                │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Metrics Overview  │  Server Health  │  API Keys  │  Request Logs  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                   │                                      │
│                          Polling (5s) / REST                             │
└───────────────────────────────────┼─────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│                            API GATEWAY                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Auth/Keys  │  │ Rate Limit  │  │   Routing   │  │   Logging   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│                          LOAD BALANCER                                   │
│                    (Least Connections + Health Checks)                   │
└───────────────────────────────────┬─────────────────────────────────────┘
                     ┌──────────────┼──────────────┐
                     │              │              │
              ┌──────▼──────┐┌──────▼──────┐┌──────▼──────┐
              │  API-1      ││  API-2      ││  API-3      │
              │  :3001      ││  :3002      ││  :3003      │
              └──────┬──────┘└──────┬──────┘└──────┬──────┘
                     │              │              │
              ┌──────┴──────────────┴──────────────┘
              │
    ┌─────────▼─────────┐  ┌─────────────────┐  ┌─────────────────┐
    │   L1 + L2 Cache   │  │   PostgreSQL    │  │     Redis       │
    │   (Two-Level)     │  │   (Primary)     │  │  (Rate Limits)  │
    └───────────────────┘  └─────────────────┘  └─────────────────┘
```

### Request Flow Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Dashboard | Metrics visualization, key management | React + Zustand |
| Gateway | Authentication, rate limiting | Express middleware |
| Load Balancer | Traffic distribution, health checks | NGINX / Node.js |
| API Servers | Business logic, caching | Express + Two-level cache |
| Data Stores | Persistence, rate limit state | PostgreSQL + Redis |

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: End-to-End API Request Flow (8 minutes)

**Sequence**: Complete request from client to response with all middleware.

```
Client                Gateway              LB              API Server           Redis          PostgreSQL
  │                      │                  │                    │                │                 │
  │  GET /api/v1/users   │                  │                    │                │                 │
  │  X-API-Key: sk_...   │                  │                    │                │                 │
  │─────────────────────▶│                  │                    │                │                 │
  │                      │                  │                    │                │                 │
  │                      │ Validate API Key │                    │                │                 │
  │                      │──────────────────────────────────────────────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │◀─────────────────────────────────────────────key data─│                 │
  │                      │                  │                    │                │                 │
  │                      │ Check Rate Limit │                    │                │                 │
  │                      │─────────────────────────────────────▶│                │                 │
  │                      │                  │                    │                │                 │
  │                      │◀────────────────────────────allowed──│                │                 │
  │                      │                  │                    │                │                 │
  │                      │ Forward Request  │                    │                │                 │
  │                      │─────────────────▶│                    │                │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │ Select Server      │                │                 │
  │                      │                  │───────────────────▶│                │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Check L1 Cache │                 │
  │                      │                  │                    │ (miss)         │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Check L2 Cache │                 │
  │                      │                  │                    │───────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │◀──────(miss)───│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Query Database │                 │
  │                      │                  │                    │───────────────────────────────▶│
  │                      │                  │                    │                │                 │
  │                      │                  │                    │◀────────────────────────data────│
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Set L1 + L2    │                 │
  │                      │                  │                    │───────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │◀──────────────────│                │                 │
  │                      │                  │                    │                │                 │
  │                      │◀─────────────────│                    │                │                 │
  │                      │                  │                    │                │                 │
  │◀─────────────────────│                  │                    │                │                 │
  │  200 OK              │                  │                    │                │                 │
  │  X-RateLimit-Remaining: 950            │                    │                │                 │
  │  X-Cache: MISS       │                  │                    │                │                 │
```

**Gateway Middleware Chain**:

```javascript
// backend/gateway/src/index.js
const app = express();

// Middleware order matters!
app.use(requestIdMiddleware);      // 1. Assign request ID
app.use(loggingMiddleware);        // 2. Log request start
app.use(apiKeyAuthMiddleware);     // 3. Validate API key
app.use(rateLimitMiddleware);      // 4. Check rate limits
app.use(proxyMiddleware);          // 5. Forward to load balancer

// Error handler (must be last)
app.use(errorHandler);

// API Key Auth Middleware
async function apiKeyAuthMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing API key',
      code: 'AUTH_MISSING_KEY'
    });
  }

  // Check cache first, then database
  const keyData = await cache.getOrFetch(
    `apikey:${hashKey(apiKey)}`,
    () => db.validateApiKey(apiKey),
    3600 // 1 hour TTL
  );

  if (!keyData || !keyData.isActive) {
    return res.status(401).json({
      error: 'Invalid API key',
      code: 'AUTH_INVALID_KEY'
    });
  }

  req.apiKey = keyData;
  next();
}

// Rate Limit Middleware with Headers
async function rateLimitMiddleware(req, res, next) {
  const result = await rateLimiter.checkLimit(
    req.apiKey.id,
    req.apiKey.tier
  );

  // Always set rate limit headers
  res.set('X-RateLimit-Limit', result.limit);
  res.set('X-RateLimit-Remaining', result.remaining);
  res.set('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

  if (!result.allowed) {
    res.set('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
    });
  }

  next();
}
```

---

### Deep Dive 2: API Contract and Error Handling (6 minutes)

**Consistent API Response Format**:

```typescript
// Shared types between frontend and backend
interface APIResponse<T> {
  data?: T;
  error?: APIError;
  meta?: {
    requestId: string;
    timestamp: string;
    pagination?: {
      page: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  };
}

interface APIError {
  message: string;
  code: string;
  details?: Record<string, string[]>;
}

// Example responses
// Success
{
  "data": { "users": [...] },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2024-01-15T10:30:00Z",
    "pagination": { "page": 1, "limit": 20, "total": 150, "hasMore": true }
  }
}

// Error
{
  "error": {
    "message": "Rate limit exceeded",
    "code": "RATE_LIMIT_EXCEEDED"
  },
  "meta": {
    "requestId": "req_xyz789",
    "timestamp": "2024-01-15T10:30:00Z"
  }
}
```

**Frontend API Client with Error Handling**:

```typescript
// frontend/src/services/api.ts
class APIClient {
  private baseUrl = '/api/v1';

  async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<APIResponse<T>> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      credentials: 'include' // Include session cookie for admin API
    });

    // Extract rate limit info from headers
    const rateLimitInfo = {
      limit: parseInt(response.headers.get('X-RateLimit-Limit') || '0'),
      remaining: parseInt(response.headers.get('X-RateLimit-Remaining') || '0'),
      resetAt: parseInt(response.headers.get('X-RateLimit-Reset') || '0') * 1000
    };

    // Update rate limit store for UI display
    useRateLimitStore.getState().update(rateLimitInfo);

    const data: APIResponse<T> = await response.json();

    if (!response.ok) {
      throw new APIError(
        data.error?.message || 'Unknown error',
        data.error?.code || 'UNKNOWN_ERROR',
        response.status,
        data.meta?.requestId
      );
    }

    return data;
  }

  // Typed methods for common operations
  async getMetrics(): Promise<MetricsData> {
    const response = await this.request<MetricsData>('/admin/metrics');
    return response.data!;
  }

  async createAPIKey(params: CreateKeyParams): Promise<APIKeyResponse> {
    const response = await this.request<APIKeyResponse>('/admin/keys', {
      method: 'POST',
      body: JSON.stringify(params)
    });
    return response.data!;
  }

  async revokeAPIKey(keyId: string): Promise<void> {
    await this.request(`/admin/keys/${keyId}`, {
      method: 'DELETE'
    });
  }
}

// Custom error class for API errors
class APIError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public requestId?: string
  ) {
    super(message);
    this.name = 'APIError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }
}
```

**Frontend Error Boundary and Display**:

```tsx
// frontend/src/components/ErrorBoundary.tsx
function ErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundaryPrimitive
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ErrorFallback error={error} onRetry={resetErrorBoundary} />
      )}
    >
      {children}
    </ErrorBoundaryPrimitive>
  );
}

function ErrorFallback({
  error,
  onRetry
}: {
  error: Error;
  onRetry: () => void;
}) {
  if (error instanceof APIError) {
    return <APIErrorDisplay error={error} onRetry={onRetry} />;
  }

  return (
    <div className="p-6 bg-red-50 rounded-lg text-center">
      <h2 className="text-lg font-semibold text-red-800">
        Something went wrong
      </h2>
      <p className="text-red-600 mt-2">{error.message}</p>
      <button
        onClick={onRetry}
        className="mt-4 px-4 py-2 bg-red-600 text-white rounded"
      >
        Try Again
      </button>
    </div>
  );
}

function APIErrorDisplay({
  error,
  onRetry
}: {
  error: APIError;
  onRetry: () => void;
}) {
  if (error.isRateLimited) {
    return (
      <div className="p-6 bg-amber-50 rounded-lg text-center">
        <ClockIcon className="w-12 h-12 text-amber-500 mx-auto" />
        <h2 className="text-lg font-semibold text-amber-800 mt-4">
          Rate Limit Exceeded
        </h2>
        <p className="text-amber-600 mt-2">
          Please wait before making more requests.
        </p>
        <RateLimitCountdown onComplete={onRetry} />
      </div>
    );
  }

  if (error.isUnauthorized) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="p-6 bg-red-50 rounded-lg">
      <h2 className="text-lg font-semibold text-red-800">
        {error.message}
      </h2>
      <p className="text-sm text-red-600 mt-2">
        Error Code: {error.code}
        {error.requestId && ` | Request ID: ${error.requestId}`}
      </p>
      <button onClick={onRetry} className="mt-4 btn-primary">
        Retry
      </button>
    </div>
  );
}
```

---

### Deep Dive 3: Admin Session Management (6 minutes)

**Challenge**: Secure admin access with session management, separate from API key authentication.

**Backend Session Setup**:

```javascript
// backend/gateway/src/middleware/session.js
import session from 'express-session';
import RedisStore from 'connect-redis';

const sessionMiddleware = session({
  store: new RedisStore({
    client: redisClient,
    prefix: 'session:'
  }),
  secret: process.env.SESSION_SECRET,
  name: 'admin_session',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
});

// Admin authentication endpoint
app.post('/api/v1/admin/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await db.findAdminByEmail(email);
  if (!user || !await bcrypt.compare(password, user.passwordHash)) {
    return res.status(401).json({
      error: { message: 'Invalid credentials', code: 'AUTH_INVALID' }
    });
  }

  // Create session
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.createdAt = Date.now();

  res.json({
    data: {
      user: { id: user.id, email: user.email, name: user.name }
    }
  });
});

// Admin route protection
function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: { message: 'Not authenticated', code: 'AUTH_REQUIRED' }
    });
  }

  if (req.session.role !== 'admin') {
    return res.status(403).json({
      error: { message: 'Admin access required', code: 'FORBIDDEN' }
    });
  }

  next();
}

// Apply to admin routes
app.use('/api/v1/admin/*', sessionMiddleware, requireAdmin);
```

**Frontend Auth Store and Protected Routes**:

```typescript
// frontend/src/stores/authStore.ts
interface AuthState {
  user: AdminUser | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.post('/admin/login', { email, password });
      set({ user: response.data.user, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof APIError ? error.message : 'Login failed',
        isLoading: false
      });
      throw error;
    }
  },

  logout: async () => {
    await api.post('/admin/logout');
    set({ user: null });
  },

  checkSession: async () => {
    try {
      const response = await api.get('/admin/me');
      set({ user: response.data.user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  }
}));

// Protected route component
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, checkSession } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    checkSession();
  }, []);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// Route configuration
const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    protectedRoute.addChildren([
      dashboardRoute,
      apiKeysRoute,
      logsRoute,
      settingsRoute
    ])
  ])
});
```

---

### Deep Dive 4: Real-Time Metrics Synchronization (5 minutes)

**Challenge**: Keep dashboard metrics current while minimizing server load.

**Backend Metrics Aggregation**:

```javascript
// backend/api-server/src/routes/admin.js
app.get('/api/v1/admin/metrics/current', requireAdmin, async (req, res) => {
  // Aggregate from multiple sources
  const [
    requestMetrics,
    cacheMetrics,
    rateLimitMetrics,
    serverHealth
  ] = await Promise.all([
    getRequestMetrics(),
    getCacheMetrics(),
    getRateLimitMetrics(),
    getServerHealth()
  ]);

  res.json({
    data: {
      requests: {
        perSecond: requestMetrics.rps,
        total24h: requestMetrics.total24h,
        errorRate: requestMetrics.errorRate
      },
      latency: {
        p50: requestMetrics.p50,
        p95: requestMetrics.p95,
        p99: requestMetrics.p99
      },
      cache: {
        hitRate: cacheMetrics.hitRate,
        l1Hits: cacheMetrics.l1Hits,
        l2Hits: cacheMetrics.l2Hits,
        misses: cacheMetrics.misses
      },
      rateLimit: {
        blocked24h: rateLimitMetrics.blocked,
        topBlocked: rateLimitMetrics.topBlockedKeys
      },
      servers: serverHealth
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    }
  });
});

async function getRequestMetrics() {
  // Use Redis for real-time counters
  const pipeline = redis.pipeline();

  pipeline.get('metrics:requests:current_minute');
  pipeline.get('metrics:requests:24h');
  pipeline.get('metrics:errors:current_minute');
  pipeline.lrange('metrics:latency:samples', -100, -1);

  const results = await pipeline.exec();

  const samples = results[3][1].map(Number);
  samples.sort((a, b) => a - b);

  return {
    rps: parseInt(results[0][1] || '0') / 60,
    total24h: parseInt(results[1][1] || '0'),
    errorRate: parseInt(results[2][1] || '0') / parseInt(results[0][1] || '1'),
    p50: samples[Math.floor(samples.length * 0.5)] || 0,
    p95: samples[Math.floor(samples.length * 0.95)] || 0,
    p99: samples[Math.floor(samples.length * 0.99)] || 0
  };
}
```

**Frontend Polling with Stale State Handling**:

```typescript
// frontend/src/hooks/useMetricsPolling.ts
function useMetricsPolling(intervalMs = 5000) {
  const { fetchMetrics, current, error } = useMetricsStore();
  const [isStale, setIsStale] = useState(false);
  const lastFetchRef = useRef<number>(0);

  useEffect(() => {
    let mounted = true;
    let timeoutId: NodeJS.Timeout;

    const poll = async () => {
      if (!mounted) return;

      try {
        await fetchMetrics();
        lastFetchRef.current = Date.now();
        setIsStale(false);
      } catch (err) {
        // Mark data as stale after 3 failed fetches
        if (Date.now() - lastFetchRef.current > intervalMs * 3) {
          setIsStale(true);
        }
      }

      if (mounted) {
        timeoutId = setTimeout(poll, intervalMs);
      }
    };

    poll();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [intervalMs]);

  return { current, error, isStale };
}

// Usage in Dashboard component
function Dashboard() {
  const { current, error, isStale } = useMetricsPolling(5000);

  return (
    <div>
      {isStale && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-amber-700">
          Data may be outdated. Last update: {formatRelativeTime(lastUpdate)}
        </div>
      )}

      {error && !isStale && (
        <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-red-700">
          Failed to fetch metrics: {error}
        </div>
      )}

      <MetricsOverview metrics={current} isStale={isStale} />
    </div>
  );
}
```

---

## 5. Rate Limit Display Integration (3 minutes)

**Displaying Rate Limits in UI**:

```typescript
// frontend/src/stores/rateLimitStore.ts
interface RateLimitState {
  limit: number;
  remaining: number;
  resetAt: number;
  update: (info: RateLimitInfo) => void;
}

export const useRateLimitStore = create<RateLimitState>((set) => ({
  limit: 0,
  remaining: 0,
  resetAt: 0,
  update: (info) => set(info)
}));

// Rate limit indicator component
function RateLimitIndicator() {
  const { limit, remaining, resetAt } = useRateLimitStore();
  const percentage = limit > 0 ? (remaining / limit) * 100 : 100;

  const getColor = () => {
    if (percentage > 50) return 'bg-green-500';
    if (percentage > 20) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full ${getColor()} transition-all`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-sm text-gray-600">
        {remaining}/{limit} requests
      </span>
      {remaining < limit * 0.2 && (
        <span className="text-xs text-amber-600">
          Resets {formatRelativeTime(resetAt)}
        </span>
      )}
    </div>
  );
}
```

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Polling over WebSocket | 5s delay vs complexity | Dashboard tolerates slight delay |
| Session auth for admin | Cookie management | Simpler than JWT for admin UI |
| Consistent error format | Response size overhead | Better DX, easier debugging |
| Rate limit in headers | Every response overhead | Enables proactive UI warnings |
| L1 + L2 cache | Memory duplication | 90% latency reduction for hot data |
| Redis rate limit state | External dependency | Required for distributed correctness |

---

## 7. Future Enhancements

1. **WebSocket for Alerts**: Push critical alerts immediately to dashboard
2. **Request Tracing**: Propagate request IDs through all services
3. **Optimistic Updates**: Update UI before server confirmation
4. **Offline Support**: Cache dashboard data for network interruptions
5. **Role-Based Access**: Granular admin permissions (read-only, full access)
6. **API Versioning UI**: Show deprecation warnings for old API versions
