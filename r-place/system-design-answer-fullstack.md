# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. As a fullstack engineer, I'll focus on the end-to-end pixel placement flow, the real-time WebSocket protocol, session management, and how frontend and backend coordinate to deliver a smooth collaborative experience. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A grid where any authenticated user can place colored pixels
2. **Rate Limiting** - Users can only place one pixel every 5 seconds
3. **Real-time Updates** - All users see pixel placements from others instantly
4. **Color Palette** - 16-color selection
5. **Canvas History** - Store all pixel placement events
6. **Session Management** - Support both registered users and anonymous guests

### Non-Functional Requirements

- **Latency** - Pixel updates visible within 100ms
- **Scale** - Support 100K concurrent users
- **Consistency** - Eventual consistency with last-write-wins
- **Availability** - 99.9% uptime during events

### Fullstack Considerations

- WebSocket protocol design for bidirectional communication
- Optimistic UI with server-side validation
- Session handling across frontend and backend
- Error handling and graceful degradation

---

## 2. High-Level Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                         Frontend (React)                          |
|  +------------------+  +------------------+  +------------------+  |
|  |   Canvas View    |  |  WebSocket Mgr   |  |   Auth Store     |  |
|  |   (HTML5 Canvas) |  |  (Reconnection)  |  |   (Zustand)      |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
+-----------|---------------------|---------------------|------------+
            |                     |                     |
            v                     v                     v
+------------------------------------------------------------------+
|                      API Gateway (nginx)                          |
|                      Port 3000                                    |
+------------------------------------------------------------------+
            |                     |                     |
            v                     v                     v
+------------------------------------------------------------------+
|                    Backend (Express + WS)                         |
|  +------------------+  +------------------+  +------------------+  |
|  |  REST Routes     |  |  WebSocket       |  |  Session         |  |
|  |  /api/v1/*       |  |  Handler         |  |  Middleware      |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
+-----------|---------------------|---------------------|------------+
            |                     |                     |
            v                     v                     v
+------------------------------------------------------------------+
|                    Infrastructure Layer                           |
|  +-----------+  +-----------+  +-----------+  +-----------+       |
|  |   Redis   |  | PostgreSQL|  |  RabbitMQ |  |   Redis   |       |
|  |  Canvas   |  |  History  |  |   Jobs    |  |  Sessions |       |
|  +-----------+  +-----------+  +-----------+  +-----------+       |
+------------------------------------------------------------------+
```

---

## 3. Deep Dive: End-to-End Pixel Placement Flow (10 minutes)

### Complete Flow Diagram

```
 Frontend                    Backend                     Redis
    |                           |                          |
    |  1. Click canvas (x,y)    |                          |
    |-------------------------->|                          |
    |  WebSocket: { type:       |                          |
    |    "place", x, y, color } |                          |
    |                           |                          |
    |                           |  2. Check rate limit     |
    |                           |------------------------->|
    |                           |  GET ratelimit:user:{id} |
    |                           |                          |
    |                           |  3. Rate limit OK        |
    |                           |<-------------------------|
    |                           |  SET ratelimit:user:{id} |
    |                           |  EX 5 NX                 |
    |                           |                          |
    |                           |  4. Update canvas        |
    |                           |------------------------->|
    |                           |  SETRANGE canvas:main    |
    |                           |  offset colorByte        |
    |                           |                          |
    |                           |  5. Publish update       |
    |                           |------------------------->|
    |                           |  PUBLISH canvas:updates  |
    |                           |  {x, y, color, userId}   |
    |                           |                          |
    |  6. Receive update        |                          |
    |<--------------------------|                          |
    |  { type: "pixels",        |                          |
    |    events: [...] }        |                          |
    |                           |                          |
    |  7. Update local canvas   |                          |
    v                           v                          v
```

### Frontend: Pixel Placement Handler

```typescript
// Frontend: Click handler with optimistic update
async function handleCanvasClick(e: MouseEvent): Promise<void> {
  const { x, y } = getCanvasCoordinates(e);
  const { selectedColor, cooldownEnd, canvasData } = useCanvasStore.getState();

  // 1. Check cooldown locally (optimistic)
  if (cooldownEnd && Date.now() < cooldownEnd) {
    showToast(`Wait ${Math.ceil((cooldownEnd - Date.now()) / 1000)}s`);
    return;
  }

  // 2. Store previous color for rollback
  const previousColor = canvasData![y * CANVAS_WIDTH + x];

  // 3. Optimistic update - show immediately
  useCanvasStore.getState().updatePixel(x, y, selectedColor);

  // 4. Start cooldown locally (optimistic)
  useCanvasStore.getState().setCooldown(Date.now() + COOLDOWN_MS);

  try {
    // 5. Send to server
    const result = await wsManager.placePixel(x, y, selectedColor);

    // 6. Update cooldown with server time
    useCanvasStore.getState().setCooldown(result.nextPlacement);

  } catch (error) {
    // 7. Rollback on failure
    useCanvasStore.getState().updatePixel(x, y, previousColor);
    useCanvasStore.getState().setCooldown(null);

    if (error.code === 'RATE_LIMITED') {
      useCanvasStore.getState().setCooldown(
        Date.now() + error.remainingSeconds * 1000
      );
      showToast(`Rate limited: ${error.remainingSeconds}s remaining`);
    } else {
      showToast('Failed to place pixel');
    }
  }
}
```

### Backend: WebSocket Message Handler

```typescript
// Backend: WebSocket placement handler
async function handlePlaceMessage(
  ws: WebSocket,
  session: Session,
  message: PlaceMessage
): Promise<void> {
  const { x, y, color, requestId } = message;

  // 1. Validate input
  if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) {
    ws.send(JSON.stringify({
      type: 'error',
      code: 'INVALID_COORDS',
      message: 'Coordinates out of bounds',
      requestId
    }));
    return;
  }

  if (color < 0 || color >= 16) {
    ws.send(JSON.stringify({
      type: 'error',
      code: 'INVALID_COLOR',
      message: 'Invalid color index',
      requestId
    }));
    return;
  }

  // 2. Check rate limit
  const cooldownKey = `ratelimit:user:${session.userId}`;
  const canPlace = await redis.set(cooldownKey, '1', {
    NX: true,
    EX: COOLDOWN_SECONDS
  });

  if (!canPlace) {
    const ttl = await redis.ttl(cooldownKey);
    ws.send(JSON.stringify({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Please wait before placing another pixel',
      remainingSeconds: ttl,
      requestId
    }));
    return;
  }

  // 3. Update canvas
  const offset = y * CANVAS_WIDTH + x;
  await redis.setRange('canvas:main', offset, Buffer.from([color]));

  // 4. Create event for broadcast
  const event: PixelEvent = {
    x,
    y,
    color,
    userId: session.userId,
    timestamp: Date.now()
  };

  // 5. Publish to all servers
  await redis.publish('canvas:updates', JSON.stringify(event));

  // 6. Queue for persistence (async)
  await rabbitMQ.publish('pixel_events', event);

  // 7. Send success response
  ws.send(JSON.stringify({
    type: 'success',
    requestId,
    nextPlacement: Date.now() + COOLDOWN_SECONDS * 1000
  }));

  logger.info('Pixel placed', { x, y, color, userId: session.userId });
}
```

---

## 4. Deep Dive: WebSocket Protocol Design (8 minutes)

### Message Types

```typescript
// Client -> Server messages
type ClientMessage =
  | { type: 'place'; x: number; y: number; color: number; requestId?: string }
  | { type: 'ping' };

// Server -> Client messages
type ServerMessage =
  | { type: 'welcome'; userId: string; cooldown: number; canvasInfo: CanvasInfo }
  | { type: 'canvas'; data: string; width: number; height: number }  // base64
  | { type: 'pixels'; events: PixelEvent[] }
  | { type: 'success'; requestId?: string; nextPlacement: number }
  | { type: 'error'; code: string; message: string; requestId?: string; remainingSeconds?: number }
  | { type: 'pong' };

interface PixelEvent {
  x: number;
  y: number;
  color: number;
  userId?: string;
  timestamp?: number;
}

interface CanvasInfo {
  width: number;
  height: number;
  cooldownSeconds: number;
  colorCount: number;
}
```

### Backend: WebSocket Connection Handler

```typescript
// Backend: Connection lifecycle
class WebSocketHandler {
  private connections = new Map<WebSocket, Session>();
  private redisSubscriber: Redis;

  async initialize(): Promise<void> {
    // Subscribe to Redis pub/sub
    this.redisSubscriber = new Redis();
    await this.redisSubscriber.subscribe('canvas:updates');

    this.redisSubscriber.on('message', (channel, message) => {
      if (channel === 'canvas:updates') {
        this.broadcastPixelUpdate(JSON.parse(message));
      }
    });
  }

  async handleConnection(ws: WebSocket, req: Request): Promise<void> {
    // 1. Extract session from cookie or create guest
    const session = await this.getOrCreateSession(req);
    this.connections.set(ws, session);

    // 2. Send welcome message
    const cooldownKey = `ratelimit:user:${session.userId}`;
    const cooldownTTL = await redis.ttl(cooldownKey);

    ws.send(JSON.stringify({
      type: 'welcome',
      userId: session.userId,
      cooldown: Math.max(0, cooldownTTL),
      canvasInfo: {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        cooldownSeconds: COOLDOWN_SECONDS,
        colorCount: 16
      }
    }));

    // 3. Send current canvas state
    const canvasData = await redis.getBuffer('canvas:main');
    ws.send(JSON.stringify({
      type: 'canvas',
      data: canvasData.toString('base64'),
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT
    }));

    // 4. Handle messages
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        await this.handleMessage(ws, session, msg);
      } catch (error) {
        logger.error('Message handling error', { error });
      }
    });

    // 5. Handle disconnect
    ws.on('close', () => {
      this.connections.delete(ws);
      logger.info('Client disconnected', { userId: session.userId });
    });

    logger.info('Client connected', { userId: session.userId });
  }

  private broadcastPixelUpdate(event: PixelEvent): void {
    // Batch updates for efficiency
    this.pendingUpdates.push(event);
  }
}
```

### Frontend: WebSocket Manager

```typescript
// Frontend: WebSocket connection manager
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private pendingRequests = new Map<string, {
    resolve: (result: any) => void;
    reject: (error: any) => void;
  }>();

  connect(): void {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      useCanvasStore.getState().setConnectionState(true);
    };

    this.ws.onmessage = (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      useCanvasStore.getState().setConnectionState(false);
      this.scheduleReconnect();
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        useCanvasStore.setState({
          userId: msg.userId,
          cooldownEnd: msg.cooldown > 0
            ? Date.now() + msg.cooldown * 1000
            : null
        });
        break;

      case 'canvas':
        const data = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
        useCanvasStore.getState().setCanvasData(data);
        break;

      case 'pixels':
        useCanvasStore.getState().updatePixelsBatch(msg.events);
        break;

      case 'success':
        if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
          this.pendingRequests.get(msg.requestId)!.resolve(msg);
          this.pendingRequests.delete(msg.requestId);
        }
        break;

      case 'error':
        if (msg.requestId && this.pendingRequests.has(msg.requestId)) {
          this.pendingRequests.get(msg.requestId)!.reject(msg);
          this.pendingRequests.delete(msg.requestId);
        }
        break;
    }
  }

  placePixel(x: number, y: number, color: number): Promise<SuccessMessage> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject({ code: 'NOT_CONNECTED', message: 'WebSocket not connected' });
        return;
      }

      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, { resolve, reject });

      this.ws.send(JSON.stringify({ type: 'place', x, y, color, requestId }));

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject({ code: 'TIMEOUT', message: 'Request timed out' });
        }
      }, 5000);
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay + jitter);
  }
}
```

---

## 5. Deep Dive: Session Management (6 minutes)

### Backend: Session Middleware

```typescript
// Backend: Session handling
interface Session {
  userId: string;
  username: string;
  isGuest: boolean;
  isAdmin: boolean;
  createdAt: Date;
}

async function sessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sessionId = req.cookies?.sessionId;

  if (sessionId) {
    // Try to load existing session
    const sessionData = await redis.get(`session:${sessionId}`);

    if (sessionData) {
      req.session = JSON.parse(sessionData);
      // Refresh TTL
      await redis.expire(`session:${sessionId}`, 24 * 60 * 60);
      return next();
    }
  }

  // No session or expired - create guest
  const newSessionId = crypto.randomUUID();
  const session: Session = {
    userId: crypto.randomUUID(),
    username: `Guest_${Math.random().toString(36).substring(2, 8)}`,
    isGuest: true,
    isAdmin: false,
    createdAt: new Date()
  };

  await redis.setex(
    `session:${newSessionId}`,
    24 * 60 * 60,
    JSON.stringify(session)
  );

  res.cookie('sessionId', newSessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  });

  req.session = session;
  next();
}
```

### Backend: Auth Routes

```typescript
// Backend: Authentication endpoints
router.post('/api/v1/auth/register', async (req, res) => {
  const { username, password } = req.body;

  // Validate input
  if (!username || username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Invalid username' });
  }

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Check if username exists
  const existing = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [username]
  );

  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  // Create user
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
    [username, passwordHash]
  );

  // Update session
  const session: Session = {
    userId: result.rows[0].id,
    username,
    isGuest: false,
    isAdmin: false,
    createdAt: new Date()
  };

  await redis.setex(
    `session:${req.cookies.sessionId}`,
    24 * 60 * 60,
    JSON.stringify(session)
  );

  res.json({ success: true, username });
});

router.post('/api/v1/auth/login', async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    'SELECT id, username, password_hash, is_admin FROM users WHERE username = $1 AND is_banned = false',
    [username]
  );

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Update session
  const session: Session = {
    userId: user.id,
    username: user.username,
    isGuest: false,
    isAdmin: user.is_admin,
    createdAt: new Date()
  };

  await redis.setex(
    `session:${req.cookies.sessionId}`,
    24 * 60 * 60,
    JSON.stringify(session)
  );

  res.json({ success: true, username: user.username, isAdmin: user.is_admin });
});

router.get('/api/v1/auth/me', async (req, res) => {
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    isGuest: req.session.isGuest,
    isAdmin: req.session.isAdmin
  });
});
```

### Frontend: Auth Store

```typescript
// Frontend: Auth state
interface AuthState {
  userId: string | null;
  username: string | null;
  isGuest: boolean;
  isAdmin: boolean;
  isLoading: boolean;

  fetchSession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  username: null,
  isGuest: true,
  isAdmin: false,
  isLoading: true,

  fetchSession: async () => {
    try {
      const res = await fetch('/api/v1/auth/me');
      const data = await res.json();
      set({
        userId: data.userId,
        username: data.username,
        isGuest: data.isGuest,
        isAdmin: data.isAdmin,
        isLoading: false
      });
    } catch {
      set({ isLoading: false });
    }
  },

  login: async (username, password) => {
    const res = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }

    const data = await res.json();
    set({
      username: data.username,
      isGuest: false,
      isAdmin: data.isAdmin
    });
  },

  register: async (username, password) => {
    const res = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error);
    }

    const data = await res.json();
    set({ username: data.username, isGuest: false });
  },

  logout: async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    set({ userId: null, username: null, isGuest: true, isAdmin: false });
    window.location.reload();
  }
}));
```

---

## 6. Deep Dive: Error Handling (5 minutes)

### Error Flow

```
Frontend                     Backend                      User Feedback
   |                            |                              |
   |  1. Place pixel            |                              |
   |--------------------------->|                              |
   |                            |                              |
   |  2. Rate limited           |                              |
   |<---------------------------|                              |
   |  { type: "error",          |                              |
   |    code: "RATE_LIMITED",   |                              |
   |    remainingSeconds: 3 }   |                              |
   |                            |                              |
   |  3. Rollback optimistic    |                              |
   |     update                 |                              |
   |                            |                              |
   |  4. Update cooldown        |                              |
   |     timer                  |                              |
   |                            |                              |
   |  5. Show toast             |---------------------------->  |
   |                            |  "Wait 3 seconds"            |
   v                            v                              v
```

### Backend: Centralized Error Handler

```typescript
// Backend: Error types
class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 400,
    public metadata?: Record<string, any>
  ) {
    super(message);
  }
}

// Error handler middleware
function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      ...err.metadata
    });
    return;
  }

  logger.error('Unhandled error', { error: err });
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred'
  });
}
```

### Frontend: Error Boundary and Toast

```tsx
// Frontend: Global error handling
function App() {
  return (
    <ErrorBoundary fallback={<ErrorFallback />}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ErrorBoundary>
  );
}

// Toast notifications
function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: 'info' | 'error' = 'info') => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  }, []);

  return { toasts, showToast };
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Protocol | WebSocket | Bidirectional, complex | SSE + REST (simpler) |
| Updates | Optimistic | Can show incorrect state | Wait for confirmation |
| Session | Redis + cookie | Distributed, stateless servers | JWT (no server state) |
| Auth | Session-based | Simple, familiar | OAuth (more features) |
| Validation | Both ends | Redundant code | Server-only (slower UX) |

---

## 8. API Contract Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/auth/register` | POST | Create account |
| `/api/v1/auth/login` | POST | Login |
| `/api/v1/auth/logout` | POST | End session |
| `/api/v1/auth/me` | GET | Get current user |
| `/api/v1/canvas` | GET | Get full canvas (binary) |
| `/api/v1/canvas/info` | GET | Get canvas metadata |
| `/api/v1/history/pixel` | GET | Pixel placement history |
| `/ws` | WebSocket | Real-time updates |

---

## 9. Future Enhancements

1. **Request Deduplication** - Idempotency keys for exactly-once semantics
2. **Offline Support** - Queue placements when disconnected
3. **Collaborative Features** - Show active user cursors
4. **OAuth Integration** - Login with Reddit/Google
5. **Progressive Loading** - Load canvas tiles on demand

---

## Summary

"To summarize, I've designed r/place as a fullstack application with:

1. **End-to-end pixel flow** using WebSocket for real-time communication with optimistic updates and server-side validation
2. **Bidirectional protocol** with typed messages for placement, confirmation, errors, and broadcast updates
3. **Session management** using Redis-backed sessions with cookie authentication, supporting both guests and registered users
4. **Comprehensive error handling** with rollback on failure, appropriate user feedback, and graceful degradation
5. **Frontend state** in Zustand with optimistic updates and automatic reconnection
6. **Backend services** with rate limiting, event persistence, and pub/sub broadcasting

The key insight is that the frontend and backend work together as a unified system - optimistic updates provide instant feedback while server validation ensures correctness. The WebSocket protocol enables true real-time collaboration while the session system provides flexible authentication for both casual and engaged users."
