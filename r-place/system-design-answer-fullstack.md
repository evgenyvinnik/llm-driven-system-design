# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels in real-time. As a fullstack engineer, I'll focus on how the frontend and backend coordinate: the hybrid CDN + WebSocket architecture, optimistic updates with server validation, and the end-to-end pixel placement flow. Reddit handled 10.4 million concurrent users with this design."

---

## 🎯 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Shared Pixel Canvas** - A grid where any authenticated user can place colored pixels
2. **Rate Limiting** - Users can only place one pixel every 5 minutes
3. **Real-time Updates** - All users see pixel placements instantly
4. **Color Palette** - 16-color selection
5. **Canvas History** - Store all pixel placement events
6. **Session Management** - Support both registered users and anonymous guests

### Non-Functional Requirements

- **Latency** - Pixel updates visible within 500ms globally
- **Scale** - Support 10+ million concurrent users (Reddit's actual number)
- **Consistency** - Eventual consistency with last-write-wins
- **Availability** - Must stay up during the 4-day event

### Fullstack Considerations

- Hybrid rendering: CDN bitmap + WebSocket delta overlay
- Optimistic UI with server-side validation and rollback
- Session handling across frontend and backend
- Graceful degradation when components fail

---

## 🏗️ 2. High-Level Architecture (5 minutes)

"The key insight is separating canvas reads (CDN) from real-time updates (WebSocket)."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐             │
│  │  Canvas Layer  │  │  WebSocket     │  │  Auth/Session  │             │
│  │  (CDN bitmap + │  │  Manager       │  │  Store         │             │
│  │   WS overlay)  │  │  (reconnect)   │  │  (Zustand)     │             │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘             │
│          │                   │                   │                       │
└──────────┼───────────────────┼───────────────────┼───────────────────────┘
           │                   │                   │
           ▼                   ▼                   ▼
┌──────────────────┐  ┌────────────────────────────────────────────────────┐
│   CDN (Fastly)   │  │              BACKEND (Go)                          │
│   Canvas bitmap  │  ├────────────────────────────────────────────────────┤
│   (1-2s TTL)     │  │  ┌──────────────┐  ┌──────────────┐               │
└──────────────────┘  │  │  WebSocket   │  │  REST API    │               │
                      │  │  Handler     │  │  /api/v1/*   │               │
                      │  └──────┬───────┘  └──────┬───────┘               │
                      └─────────┼─────────────────┼────────────────────────┘
                                │                 │
           ┌────────────────────┼─────────────────┼────────────────────┐
           │                    │                 │                    │
    ┌──────▼──────┐      ┌──────▼──────┐   ┌──────▼──────┐      ┌──────▼──────┐
    │   Redis     │      │   Kafka     │   │  Cassandra  │      │   Redis     │
    │  (Canvas +  │      │  (Events)   │   │  (History)  │      │ (Sessions)  │
    │  Rate limit)│      │             │   │             │      │             │
    └─────────────┘      └─────────────┘   └─────────────┘      └─────────────┘
```

---

## 🔧 3. Deep Dive: Hybrid Canvas Rendering (10 minutes)

"The frontend renders two layers: a CDN-served bitmap (background) and WebSocket deltas (overlay)."

### Frontend Rendering Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Canvas Rendering Stack                         │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Layer 2: WebSocket Delta Overlay                          │  │
│  │  - Accumulated pixel updates since CDN fetch               │  │
│  │  - Rendered on top of base layer                           │  │
│  │  - Cleared when new CDN bitmap loads                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                           ▲                                      │
│                           │ Overlay                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Layer 1: CDN Bitmap (Base)                                │  │
│  │  - Fetched from Fastly CDN on load                         │  │
│  │  - Refreshed every 30-60 seconds                           │  │
│  │  - 2MB bit-packed (4 bits per pixel)                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Why Hybrid Rendering?

| Approach | Bandwidth | Latency | Complexity |
|----------|-----------|---------|------------|
| ❌ WebSocket only | 35K msg/s × 10M = impossible | Low | High |
| ❌ CDN polling | 10M × 2MB/s = 20PB/s | 1-2s stale | Low |
| ✅ Hybrid | CDN once + small deltas | Real-time | Medium |

### Frontend Canvas State (Zustand)

| Property | Type | Description |
|----------|------|-------------|
| baseCanvas | Uint8Array | CDN bitmap (bit-packed) |
| deltaPixels | Map<string, number> | WebSocket updates: "x,y" → color |
| lastCdnFetch | number | Timestamp of last CDN refresh |

### Rendering Flow

1. **Initial load**: Fetch bitmap from CDN, decode bit-packed data, render to canvas
2. **WebSocket updates**: Add to deltaPixels map, render overlay
3. **Periodic refresh**: Every 30-60s, fetch new CDN bitmap, clear deltas
4. **Zoom/pan**: Apply CSS transform, no re-render needed

---

## 🔧 4. Deep Dive: End-to-End Pixel Placement (8 minutes)

### Complete Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                   PIXEL PLACEMENT FLOW                           │
│                                                                  │
│  FRONTEND                BACKEND                 INFRASTRUCTURE  │
│     │                       │                          │         │
│     │ 1. User clicks        │                          │         │
│     │    (x=100, y=200)     │                          │         │
│     │                       │                          │         │
│     │ 2. Optimistic update  │                          │         │
│     │    (show pixel)       │                          │         │
│     │                       │                          │         │
│     │ 3. WebSocket: place   │                          │         │
│     │───────────────────────▶                          │         │
│     │                       │ 4. Rate limit check      │         │
│     │                       │─────────────────────────▶│ Redis   │
│     │                       │    SET NX EX             │         │
│     │                       │                          │         │
│     │                       │ 5. Update canvas         │         │
│     │                       │─────────────────────────▶│ Redis   │
│     │                       │    SETBIT                │         │
│     │                       │                          │         │
│     │                       │ 6. Publish event         │         │
│     │                       │─────────────────────────▶│ Kafka   │
│     │                       │                          │         │
│     │ 7. Confirmation       │                          │         │
│     │◀───────────────────────                          │         │
│     │    { success, next }  │                          │         │
│     │                       │                          │         │
│     │ 8. Broadcast (batch)  │◀─────────────────────────│ Kafka   │
│     │◀───────────────────────                          │         │
│     │    { pixels: [...] }  │                          │         │
│     ▼                       ▼                          ▼         │
└─────────────────────────────────────────────────────────────────┘
```

### Frontend: Optimistic Update with Rollback

**placePixel(x, y, color):**

1. **Check local cooldown** - If cooldownEnd > Date.now(), show toast, return
2. **Store rollback state** - previousColor = getPixel(x, y)
3. **Optimistic update** - setPixel(x, y, color), start cooldown UI
4. **Send to server** - WebSocket message with requestId
5. **On success** - Update cooldown from server's nextPlacement
6. **On error** - setPixel(x, y, previousColor), show error toast

### Backend: Placement Handler

**handlePlace(x, y, color, userId):**

1. **Validate** - 0 ≤ x < WIDTH, 0 ≤ y < HEIGHT, 0 ≤ color < 16
2. **Rate limit** - `SET ratelimit:{userId} 1 NX EX 300` (5 min)
3. **Update Redis** - Bit-pack and SETBIT at calculated offset
4. **Publish to Kafka** - Event for broadcast and persistence
5. **Return** - { success: true, nextPlacement: now + 300000 }

---

## 📡 5. Deep Dive: WebSocket Protocol (6 minutes)

### Message Types

**Client → Server:**

| Type | Fields | Description |
|------|--------|-------------|
| `place` | x, y, color, requestId | Place a pixel |
| `ping` | — | Keepalive (every 30s) |

**Server → Client:**

| Type | Fields | Description |
|------|--------|-------------|
| `init` | canvasUrl, cooldown, canvasInfo | Connection established |
| `batch` | pixels[], timestamp | Batched updates (every 1s) |
| `placed` | requestId, nextPlacement | Your placement confirmed |
| `error` | code, message, requestId?, retryAfter? | Placement failed |
| `pong` | — | Heartbeat response |

### Why Batch Updates?

| Approach | Messages to 10M clients | Feasibility |
|----------|------------------------|-------------|
| Individual | 35K × 10M = 350B/sec | ❌ Impossible |
| 1s batches | 10M × ~5KB = 50GB/sec | ✅ Distributed |

### Frontend: WebSocket Manager

**State:**

| Property | Type | Description |
|----------|------|-------------|
| ws | WebSocket \| null | Current connection |
| reconnectAttempts | number | For exponential backoff |
| pendingRequests | Map | requestId → { resolve, reject, timeout } |
| updateBuffer | PixelUpdate[] | Incoming updates for batch render |

**Reconnection with Backoff:**

| Attempt | Delay | With Jitter |
|---------|-------|-------------|
| 1 | 1s | 1.0-2.0s |
| 2 | 2s | 2.0-3.0s |
| 3 | 4s | 4.0-5.0s |
| 4+ | 8-30s | + random 0-1s |

---

## 🔐 6. Deep Dive: Session Management (5 minutes)

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    Session Flow                                 │
│                                                                 │
│  Browser           Backend              Redis                   │
│     │                 │                   │                     │
│     │ 1. First visit  │                   │                     │
│     │ (no cookie)     │                   │                     │
│     │────────────────▶│                   │                     │
│     │                 │ 2. Create guest   │                     │
│     │                 │────────────────────▶                    │
│     │                 │ SET session:{id}  │                     │
│     │                 │ TTL 24h           │                     │
│     │ 3. Set-Cookie   │                   │                     │
│     │◀────────────────│                   │                     │
│     │ sessionId=abc   │                   │                     │
│     │ httpOnly,secure │                   │                     │
│     │                 │                   │                     │
│     │ 4. Subsequent   │                   │                     │
│     │ requests        │                   │                     │
│     │────────────────▶│ 5. Lookup session │                     │
│     │                 │────────────────────▶                    │
│     │                 │ GET session:{id}  │                     │
│     ▼                 ▼                   ▼                     │
└────────────────────────────────────────────────────────────────┘
```

### Session Structure (Redis JSON)

| Field | Type | Description |
|-------|------|-------------|
| userId | string | UUID, persists across logins |
| username | string | Display name |
| isGuest | boolean | Anonymous or registered |
| isAdmin | boolean | Moderation privileges |
| createdAt | number | Session start timestamp |
| lastCooldown | number | Last pixel placement time |

### Frontend Auth Store (Zustand)

| State | Type | Description |
|-------|------|-------------|
| user | User \| null | Current user info |
| isLoading | boolean | Fetching session |
| cooldownEnd | number \| null | When can place next |

| Action | Description |
|--------|-------------|
| fetchSession() | GET /api/v1/auth/me on app load |
| login(u, p) | POST /api/v1/auth/login |
| logout() | POST /api/v1/auth/logout, reload |

---

## 📡 7. API Design

### REST Endpoints

| Method | Endpoint | Description | Response |
|--------|----------|-------------|----------|
| GET | `/api/v1/canvas` | Redirect to CDN | 302 → CDN URL |
| GET | `/api/v1/canvas/info` | Metadata | `{ width, height, colors, cooldownSec }` |
| GET | `/api/v1/pixel?x=&y=` | Pixel history | `{ placements: [...] }` |
| GET | `/api/v1/auth/me` | Current user | `{ userId, username, isGuest }` |
| POST | `/api/v1/auth/login` | Login | `{ success, username }` |
| POST | `/api/v1/auth/logout` | Logout | `{ success }` |

### WebSocket Endpoint

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/ws` | WS/WSS | Real-time bidirectional |

---

## ⚖️ 8. Trade-offs Analysis

### Trade-off 1: CDN + WebSocket Hybrid vs. Pure WebSocket

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Hybrid (CDN bitmap + WS deltas) | CDN handles 10M users, WS only for deltas | Two systems to maintain |
| ❌ Pure WebSocket | Single protocol | Can't scale to 10M concurrent |

> "We use a hybrid approach because serving the full canvas (2MB) to 10 million users via WebSocket is impossible—that's 20 petabytes of bandwidth. Instead, clients fetch the bitmap from CDN (which handles massive scale trivially) and receive only incremental updates via WebSocket. The trade-off is rendering complexity: frontend must overlay WebSocket deltas on the CDN bitmap and periodically reconcile. But this is a one-time implementation cost, and the scalability gain is essential."

### Trade-off 2: Optimistic UI vs. Wait for Server

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Optimistic + rollback | Instant feedback (<10ms) | Brief incorrect state on rejection |
| ❌ Wait for server | Always accurate | 50-200ms delay feels sluggish |

> "We show the pixel immediately because users expect instant feedback—waiting even 100ms makes the app feel broken. The trade-off is that ~1% of placements get rejected (mostly rate limiting), requiring rollback. We mitigate this by checking local cooldown first. Rollback is visually smooth since we're restoring a single pixel. For a collaborative art project, brief optimistic inaccuracy is acceptable; for financial transactions it wouldn't be."

### Trade-off 3: Session-Based vs. JWT Authentication

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Session + Redis | Instant revocation for bans | Redis lookup on every request |
| ❌ JWT | Stateless, no Redis lookup | Can't revoke until expiration |

> "We chose sessions because banning abusive users must take effect immediately—with JWT, a banned user's token remains valid until expiration, and they could vandalize art for minutes. The Redis lookup adds ~1ms latency, negligible compared to our 500ms target. We're already hitting Redis for rate limiting, so sessions add no new dependency."

---

## 🚨 9. Failure Handling

| Component | Failure | Frontend Behavior | Backend Mitigation |
|-----------|---------|-------------------|-------------------|
| CDN | Edge down | Use cached bitmap, show stale warning | Multiple edge PoPs |
| WebSocket | Disconnect | Exponential backoff reconnect | Stateless servers |
| Redis | Primary down | Placement fails, show error | Redis Cluster failover |
| Kafka | Broker down | Placements succeed but delayed broadcast | Replication factor 3 |

### Graceful Degradation

| Scenario | User Experience |
|----------|-----------------|
| WebSocket down | Can view canvas (CDN), can't place or see updates |
| Redis rate limit down | Allow placements (fail open) with warning |
| Kafka down | Placements work, broadcast delayed, history gaps |

---

## 📝 Summary

"To summarize, I've designed r/place as a fullstack system following Reddit's actual architecture:

1. **Hybrid rendering** - CDN serves 2MB bitmap, WebSocket delivers deltas, frontend overlays both
2. **Optimistic updates** - Instant feedback with rollback on server rejection
3. **Batched broadcasts** - 1-second WebSocket batches reduce 350B messages to 10M manageable ones
4. **Session-based auth** - Redis sessions enable instant ban enforcement
5. **Kafka event stream** - Durable log for broadcast fan-out and history
6. **Graceful degradation** - System stays usable when individual components fail

The key fullstack insight is that frontend and backend aren't separate—they form a unified system where CDN, WebSocket, and optimistic rendering work together. The frontend isn't just displaying data; it's actively participating in the distributed system by maintaining local state, reconciling updates, and handling failures gracefully."
