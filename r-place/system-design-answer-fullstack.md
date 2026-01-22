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
┌─────────────────────────────────────────────────────────────────┐
│                      FRONTEND (React)                            │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Canvas View  │  │ WebSocket    │  │ Auth Store   │          │
│  │ (HTML5)      │  │ Manager      │  │ (Zustand)    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API GATEWAY (nginx)                         │
│                        Port 3000                                 │
└─────────────────────────────────────────────────────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BACKEND (Express + WS)                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ REST Routes  │  │ WebSocket    │  │ Session      │          │
│  │ /api/v1/*    │  │ Handler      │  │ Middleware   │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE LAYER                          │
├───────────────┬───────────────┬───────────────┬─────────────────┤
│    Redis      │  PostgreSQL   │   RabbitMQ    │     Redis       │
│   (Canvas)    │   (History)   │   (Jobs)      │   (Sessions)    │
└───────────────┴───────────────┴───────────────┴─────────────────┘
```

---

## 3. Deep Dive: End-to-End Pixel Placement Flow (10 minutes)

### Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                   PIXEL PLACEMENT FLOW                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  FRONTEND                 BACKEND                    REDIS      │
│     │                        │                         │        │
│     │ 1. Click canvas (x,y)  │                         │        │
│     │───────────────────────▶│                         │        │
│     │    WebSocket: {        │                         │        │
│     │      type: "place",    │                         │        │
│     │      x, y, color       │                         │        │
│     │    }                   │                         │        │
│     │                        │                         │        │
│     │                        │ 2. Check rate limit     │        │
│     │                        │────────────────────────▶│        │
│     │                        │ GET ratelimit:user:{id} │        │
│     │                        │                         │        │
│     │                        │ 3. Rate limit OK        │        │
│     │                        │◀────────────────────────│        │
│     │                        │ SET ratelimit:user:{id} │        │
│     │                        │ EX 5 NX                 │        │
│     │                        │                         │        │
│     │                        │ 4. Update canvas        │        │
│     │                        │────────────────────────▶│        │
│     │                        │ SETRANGE canvas:main    │        │
│     │                        │ offset colorByte        │        │
│     │                        │                         │        │
│     │                        │ 5. Publish update       │        │
│     │                        │────────────────────────▶│        │
│     │                        │ PUBLISH canvas:updates  │        │
│     │                        │ {x, y, color, userId}   │        │
│     │                        │                         │        │
│     │ 6. Receive update      │                         │        │
│     │◀───────────────────────│                         │        │
│     │    { type: "pixels",   │                         │        │
│     │      events: [...] }   │                         │        │
│     │                        │                         │        │
│     │ 7. Update local canvas │                         │        │
│     ▼                        ▼                         ▼        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: Pixel Placement Handler

"We use optimistic updates to show the pixel immediately, then rollback if the server rejects it. This makes the UI feel instant while maintaining server authority."

```
┌─────────────────────────────────────────────────────────────────┐
│                FRONTEND CLICK HANDLER                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   handleCanvasClick(event):                                     │
│                                                                 │
│   1. GET COORDINATES                                            │
│      (x, y) = getCanvasCoordinates(event)                       │
│      { selectedColor, cooldownEnd, canvasData } = store         │
│                                                                 │
│   2. LOCAL COOLDOWN CHECK (optimistic)                          │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ IF cooldownEnd && now < cooldownEnd:                  │  │
│      │     showToast("Wait ${remaining}s")                   │  │
│      │     RETURN                                            │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   3. STORE PREVIOUS (for rollback)                              │
│      previousColor = canvasData[y * WIDTH + x]                  │
│                                                                 │
│   4. OPTIMISTIC UPDATE                                          │
│      store.updatePixel(x, y, selectedColor)                     │
│      store.setCooldown(now + COOLDOWN_MS)                       │
│                                                                 │
│   5. SEND TO SERVER                                             │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ TRY:                                                  │  │
│      │   result = wsManager.placePixel(x, y, selectedColor)  │  │
│      │   store.setCooldown(result.nextPlacement)             │  │
│      │                                                       │  │
│      │ CATCH error:                                          │  │
│      │   store.updatePixel(x, y, previousColor)  ◀─ ROLLBACK│  │
│      │   store.setCooldown(null)                             │  │
│      │                                                       │  │
│      │   IF error.code === 'RATE_LIMITED':                   │  │
│      │       store.setCooldown(now + error.remainingSeconds) │  │
│      │       showToast("Rate limited")                       │  │
│      │   ELSE:                                               │  │
│      │       showToast("Failed to place pixel")              │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Backend: WebSocket Message Handler

```
┌─────────────────────────────────────────────────────────────────┐
│              BACKEND PLACEMENT HANDLER                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   handlePlaceMessage(ws, session, message):                     │
│                                                                 │
│   1. VALIDATE INPUT                                             │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ IF x < 0 OR x >= WIDTH OR y < 0 OR y >= HEIGHT:       │  │
│      │     ws.send({ type: 'error', code: 'INVALID_COORDS'}) │  │
│      │     RETURN                                            │  │
│      │                                                       │  │
│      │ IF color < 0 OR color >= 16:                          │  │
│      │     ws.send({ type: 'error', code: 'INVALID_COLOR' }) │  │
│      │     RETURN                                            │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   2. CHECK RATE LIMIT (atomic Redis SET NX EX)                  │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ cooldownKey = `ratelimit:user:${session.userId}`      │  │
│      │ canPlace = redis.set(cooldownKey, '1', NX, EX: 5)     │  │
│      │                                                       │  │
│      │ IF NOT canPlace:                                      │  │
│      │     ttl = redis.ttl(cooldownKey)                      │  │
│      │     ws.send({                                         │  │
│      │       type: 'error',                                  │  │
│      │       code: 'RATE_LIMITED',                           │  │
│      │       remainingSeconds: ttl                           │  │
│      │     })                                                │  │
│      │     RETURN                                            │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   3. UPDATE CANVAS                                              │
│      offset = y * WIDTH + x                                     │
│      redis.setRange('canvas:main', offset, Buffer([color]))     │
│                                                                 │
│   4. CREATE AND BROADCAST EVENT                                 │
│      event = { x, y, color, userId, timestamp: now }            │
│      redis.publish('canvas:updates', JSON.stringify(event))     │
│                                                                 │
│   5. QUEUE FOR PERSISTENCE (async)                              │
│      rabbitMQ.publish('pixel_events', event)                    │
│                                                                 │
│   6. SEND SUCCESS                                               │
│      ws.send({                                                  │
│        type: 'success',                                         │
│        requestId,                                               │
│        nextPlacement: now + COOLDOWN_SECONDS * 1000             │
│      })                                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: WebSocket Protocol Design (8 minutes)

### Message Types

```
┌─────────────────────────────────────────────────────────────────┐
│                    WEBSOCKET PROTOCOL                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   CLIENT → SERVER:                                              │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ { type: 'place', x, y, color, requestId? }              │  │
│   │ { type: 'ping' }                                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   SERVER → CLIENT:                                              │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ welcome:  { userId, cooldown, canvasInfo }              │  │
│   │ canvas:   { data (base64), width, height }              │  │
│   │ pixels:   { events: PixelEvent[] }                      │  │
│   │ success:  { requestId?, nextPlacement }                 │  │
│   │ error:    { code, message, requestId?, remainingSeconds?}│  │
│   │ pong:     { }                                           │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   PixelEvent:                                                   │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ { x, y, color, userId?, timestamp? }                    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   CanvasInfo:                                                   │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ { width, height, cooldownSeconds, colorCount }          │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Backend: Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                CONNECTION HANDLER                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   INITIALIZATION (once at server start):                        │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ 1. Create Redis subscriber                               │  │
│   │ 2. Subscribe to 'canvas:updates' channel                 │  │
│   │ 3. On message: broadcastPixelUpdate(JSON.parse(msg))     │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   handleConnection(ws, req):                                    │
│                                                                 │
│   1. GET OR CREATE SESSION                                      │
│      session = getOrCreateSession(req)                          │
│      connections.set(ws, session)                               │
│                                                                 │
│   2. SEND WELCOME MESSAGE                                       │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ cooldownTTL = redis.ttl(`ratelimit:user:${userId}`)   │  │
│      │                                                       │  │
│      │ ws.send({                                             │  │
│      │   type: 'welcome',                                    │  │
│      │   userId: session.userId,                             │  │
│      │   cooldown: max(0, cooldownTTL),                      │  │
│      │   canvasInfo: { width, height, cooldownSeconds, 16 }  │  │
│      │ })                                                    │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   3. SEND CURRENT CANVAS STATE                                  │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ canvasData = redis.getBuffer('canvas:main')           │  │
│      │                                                       │  │
│      │ ws.send({                                             │  │
│      │   type: 'canvas',                                     │  │
│      │   data: canvasData.toString('base64'),                │  │
│      │   width, height                                       │  │
│      │ })                                                    │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   4. SET UP EVENT HANDLERS                                      │
│      ws.on('message', msg ──▶ handleMessage(ws, session, msg))  │
│      ws.on('close', () ──▶ connections.delete(ws))              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: WebSocket Manager

```
┌─────────────────────────────────────────────────────────────────┐
│                 WEBSOCKET MANAGER                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   STATE:                                                        │
│   ├── ws: WebSocket | null                                      │
│   ├── reconnectAttempts: number                                 │
│   └── pendingRequests: Map<requestId, { resolve, reject }>      │
│                                                                 │
│   connect():                                                    │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'│  │
│   │ ws = new WebSocket(`${protocol}//${location.host}/ws`)   │  │
│   │                                                          │  │
│   │ ws.onopen  = () ──▶ resetAttempts(), setConnected(true)  │  │
│   │ ws.onmessage = (e) ──▶ handleMessage(JSON.parse(e.data)) │  │
│   │ ws.onclose = () ──▶ setConnected(false), reconnect()     │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   handleMessage(msg):                                           │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ SWITCH msg.type:                                         │  │
│   │                                                          │  │
│   │   'welcome':                                             │  │
│   │       store.set({ userId, cooldownEnd })                 │  │
│   │                                                          │  │
│   │   'canvas':                                              │  │
│   │       data = Uint8Array.from(atob(msg.data), ...)        │  │
│   │       store.setCanvasData(data)                          │  │
│   │                                                          │  │
│   │   'pixels':                                              │  │
│   │       store.updatePixelsBatch(msg.events)                │  │
│   │                                                          │  │
│   │   'success' | 'error':                                   │  │
│   │       IF msg.requestId in pendingRequests:               │  │
│   │           resolve/reject and delete                      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   placePixel(x, y, color): Promise<SuccessMessage>              │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ IF NOT connected: reject({ code: 'NOT_CONNECTED' })      │  │
│   │                                                          │  │
│   │ requestId = crypto.randomUUID()                          │  │
│   │ pendingRequests.set(requestId, { resolve, reject })      │  │
│   │                                                          │  │
│   │ ws.send({ type: 'place', x, y, color, requestId })       │  │
│   │                                                          │  │
│   │ setTimeout(5000, () ──▶ reject if still pending)         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   scheduleReconnect():                                          │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ delay = min(1000 × 2^attempts, 30000)                    │  │
│   │ jitter = random() × 1000                                 │  │
│   │                                                          │  │
│   │ setTimeout(delay + jitter, () ──▶ attempts++, connect()) │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Session Management (6 minutes)

### Backend: Session Middleware

```
┌─────────────────────────────────────────────────────────────────┐
│                   SESSION MIDDLEWARE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   SESSION STRUCTURE:                                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ userId:    string                                        │  │
│   │ username:  string                                        │  │
│   │ isGuest:   boolean                                       │  │
│   │ isAdmin:   boolean                                       │  │
│   │ createdAt: Date                                          │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   sessionMiddleware(req, res, next):                            │
│                                                                 │
│   1. CHECK EXISTING SESSION                                     │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ sessionId = req.cookies?.sessionId                    │  │
│      │                                                       │  │
│      │ IF sessionId:                                         │  │
│      │     sessionData = redis.get(`session:${sessionId}`)   │  │
│      │                                                       │  │
│      │     IF sessionData:                                   │  │
│      │         req.session = JSON.parse(sessionData)         │  │
│      │         redis.expire(`session:${sessionId}`, 86400)   │  │
│      │         RETURN next()                                 │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
│   2. CREATE GUEST SESSION                                       │
│      ┌──────────────────────────────────────────────────────┐  │
│      │ newSessionId = crypto.randomUUID()                    │  │
│      │                                                       │  │
│      │ session = {                                           │  │
│      │   userId: crypto.randomUUID(),                        │  │
│      │   username: `Guest_${random6chars()}`,                │  │
│      │   isGuest: true,                                      │  │
│      │   isAdmin: false,                                     │  │
│      │   createdAt: new Date()                               │  │
│      │ }                                                     │  │
│      │                                                       │  │
│      │ redis.setex(`session:${newSessionId}`, 86400, session)│  │
│      │                                                       │  │
│      │ res.cookie('sessionId', newSessionId, {               │  │
│      │   httpOnly: true,                                     │  │
│      │   secure: production,                                 │  │
│      │   sameSite: 'lax',                                    │  │
│      │   maxAge: 86400000                                    │  │
│      │ })                                                    │  │
│      │                                                       │  │
│      │ req.session = session                                 │  │
│      │ next()                                                │  │
│      └──────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Backend: Auth Routes

```
┌─────────────────────────────────────────────────────────────────┐
│                     AUTH ROUTES                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   POST /api/v1/auth/register                                    │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ VALIDATE:                                                │  │
│   │   username: 3-32 chars                                   │  │
│   │   password: >= 8 chars                                   │  │
│   │                                                          │  │
│   │ CHECK EXISTING:                                          │  │
│   │   SELECT id FROM users WHERE username = $1               │  │
│   │   IF exists ──▶ 409 "Username already taken"             │  │
│   │                                                          │  │
│   │ CREATE USER:                                             │  │
│   │   passwordHash = bcrypt.hash(password, 12)               │  │
│   │   INSERT INTO users (username, password_hash)            │  │
│   │                                                          │  │
│   │ UPDATE SESSION:                                          │  │
│   │   session = { userId, username, isGuest: false, ... }    │  │
│   │   redis.setex(`session:${sessionId}`, 86400, session)    │  │
│   │                                                          │  │
│   │ RETURN { success: true, username }                       │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   POST /api/v1/auth/login                                       │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ LOOKUP USER:                                             │  │
│   │   SELECT id, username, password_hash, is_admin           │  │
│   │   FROM users WHERE username = $1 AND is_banned = false   │  │
│   │                                                          │  │
│   │   IF NOT found ──▶ 401 "Invalid credentials"             │  │
│   │                                                          │  │
│   │ VERIFY PASSWORD:                                         │  │
│   │   valid = bcrypt.compare(password, hash)                 │  │
│   │   IF NOT valid ──▶ 401 "Invalid credentials"             │  │
│   │                                                          │  │
│   │ UPDATE SESSION:                                          │  │
│   │   session = { userId, username, isGuest: false, isAdmin }│  │
│   │   redis.setex(`session:${sessionId}`, 86400, session)    │  │
│   │                                                          │  │
│   │ RETURN { success: true, username, isAdmin }              │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   GET /api/v1/auth/me                                           │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ RETURN {                                                 │  │
│   │   userId, username, isGuest, isAdmin                     │  │
│   │ }                                                        │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: Auth Store

```
┌─────────────────────────────────────────────────────────────────┐
│                    AUTH STORE (Zustand)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   STATE:                                                        │
│   ├── userId: string | null                                     │
│   ├── username: string | null                                   │
│   ├── isGuest: boolean                                          │
│   ├── isAdmin: boolean                                          │
│   └── isLoading: boolean                                        │
│                                                                 │
│   ACTIONS:                                                      │
│                                                                 │
│   fetchSession():                                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ TRY:                                                     │  │
│   │   res = await fetch('/api/v1/auth/me')                   │  │
│   │   data = await res.json()                                │  │
│   │   set({ ...data, isLoading: false })                     │  │
│   │ CATCH:                                                   │  │
│   │   set({ isLoading: false })                              │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   login(username, password):                                    │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ res = await fetch('/api/v1/auth/login', {                │  │
│   │   method: 'POST', body: { username, password }           │  │
│   │ })                                                       │  │
│   │                                                          │  │
│   │ IF NOT res.ok: throw new Error(res.json().error)         │  │
│   │                                                          │  │
│   │ data = await res.json()                                  │  │
│   │ set({ username: data.username, isGuest: false, ... })    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   logout():                                                     │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ await fetch('/api/v1/auth/logout', { method: 'POST' })   │  │
│   │ set({ userId: null, username: null, isGuest: true, ... })│  │
│   │ window.location.reload()                                 │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Error Handling (5 minutes)

### Error Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     ERROR HANDLING FLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   FRONTEND                 BACKEND               USER FEEDBACK  │
│      │                        │                       │         │
│      │ 1. Place pixel         │                       │         │
│      │───────────────────────▶│                       │         │
│      │                        │                       │         │
│      │ 2. Rate limited        │                       │         │
│      │◀───────────────────────│                       │         │
│      │  { type: "error",      │                       │         │
│      │    code: "RATE_LIMITED"│                       │         │
│      │    remainingSeconds: 3}│                       │         │
│      │                        │                       │         │
│      │ 3. Rollback optimistic │                       │         │
│      │    update              │                       │         │
│      │                        │                       │         │
│      │ 4. Update cooldown     │                       │         │
│      │    timer               │                       │         │
│      │                        │                       │         │
│      │ 5. Show toast          │───────────────────────▶│        │
│      │                        │    "Wait 3 seconds"   │         │
│      ▼                        ▼                       ▼         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Backend: Error Handler

```
┌─────────────────────────────────────────────────────────────────┐
│                   ERROR HANDLER MIDDLEWARE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   AppError CLASS:                                               │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ constructor(code, message, statusCode = 400, metadata?)  │  │
│   │                                                          │  │
│   │ code:       string       (e.g., 'RATE_LIMITED')          │  │
│   │ message:    string       (human-readable)                │  │
│   │ statusCode: number       (HTTP status)                   │  │
│   │ metadata:   Record<k,v>  (extra data)                    │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   errorHandler(err, req, res, next):                            │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ IF err instanceof AppError:                              │  │
│   │     res.status(err.statusCode).json({                    │  │
│   │       error: err.code,                                   │  │
│   │       message: err.message,                              │  │
│   │       ...err.metadata                                    │  │
│   │     })                                                   │  │
│   │                                                          │  │
│   │ ELSE:                                                    │  │
│   │     logger.error('Unhandled error', { error: err })      │  │
│   │     res.status(500).json({                               │  │
│   │       error: 'INTERNAL_ERROR',                           │  │
│   │       message: 'An unexpected error occurred'            │  │
│   │     })                                                   │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: Error Boundary and Toast

```
┌─────────────────────────────────────────────────────────────────┐
│               FRONTEND ERROR HANDLING                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   APP STRUCTURE:                                                │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ <ErrorBoundary fallback={<ErrorFallback />}>             │  │
│   │   <ToastProvider>                                        │  │
│   │     <RouterProvider router={router} />                   │  │
│   │   </ToastProvider>                                       │  │
│   │ </ErrorBoundary>                                         │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
│   useToast HOOK:                                                │
│   ┌─────────────────────────────────────────────────────────┐  │
│   │ state: toasts[]                                          │  │
│   │                                                          │  │
│   │ showToast(message, type = 'info'):                       │  │
│   │   id = crypto.randomUUID()                               │  │
│   │   setToasts(prev ──▶ [...prev, { id, message, type }])   │  │
│   │                                                          │  │
│   │   setTimeout(3000, () ──▶                                │  │
│   │     setToasts(prev ──▶ prev.filter(t ──▶ t.id !== id))   │  │
│   │   )                                                      │  │
│   └─────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
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
