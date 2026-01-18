# Design Kindle Community Highlights - Development with Claude

## Project Context

Building a social reading platform to understand real-time sync, large-scale aggregation, and privacy-preserving social features.

**Key Learning Goals:**
- Build real-time sync across devices
- Design aggregation at scale (billions of highlights)
- Implement privacy-preserving community features
- Handle offline-first architecture

---

## Implementation Status

### Phase 1: Core Highlights ✅
- [x] Highlight CRUD operations
- [x] PostgreSQL storage with migrations
- [x] Basic sync protocol (WebSocket)
- [x] Personal library view

### Phase 2: Sync ✅
- [x] WebSocket server with connection management
- [x] Conflict resolution via timestamps
- [x] Offline queue in Redis
- [x] Multi-device sync events

### Phase 3: Community ✅
- [x] Popular highlights aggregation
- [x] Privacy settings (public/friends/private)
- [x] Social features (follow, share)
- [x] Export functionality (Markdown, CSV, JSON)

### Phase 4: Scale ✅
- [x] Redis caching for popular highlights
- [x] Batch aggregation worker job
- [x] PostgreSQL full-text search (Elasticsearch optional)
- [x] Connection pooling and query optimization

---

## Key Challenges Explored

### 1. Real-time Sync

**Challenge**: Propagate highlights across devices in < 2 seconds

**Implementation:**
- WebSocket persistent connections via `ws` library
- Device connection registry in memory + Redis for state
- Push sync events to all connected devices
- Offline queue persisted in Redis (30-day TTL)
- Last-write-wins conflict resolution using timestamps

**Code Pattern:**
```typescript
// Sync Service broadcasts to all user devices
async function pushHighlight(userId: string, event: SyncEvent) {
  const devices = connections.get(userId)
  for (const [deviceId, ws] of devices) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event))
    } else {
      await queueForDevice(userId, deviceId, event)
    }
  }
}
```

### 2. Aggregation at Scale

**Problem**: Count highlights across millions of readers efficiently

**Implementation:**
- Redis hash counters for real-time increments
- Passage normalization: 100-character windows for grouping
- Background worker syncs Redis → PostgreSQL periodically
- 5-minute cache TTL for popular highlights API

**Trade-off:** Eventual consistency (acceptable) for write performance

### 3. Privacy

**Challenge**: Show community data without exposing individuals

**Implementation:**
- Per-highlight visibility: `private`, `friends`, `public`
- User privacy settings table with defaults
- Aggregation only includes opted-in users
- Friends' highlights require follow relationship

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync Protocol | WebSocket | Low latency, bidirectional |
| Aggregation Counter | Redis → PostgreSQL | Fast writes, durable reads |
| Passage Grouping | 100-char windows | Balance precision vs. aggregation |
| Auth | Session tokens in Redis | Simple, stateless services |
| Frontend State | Zustand | Minimal boilerplate |
| Routing | TanStack Router | Type-safe, file-based |

---

## Files Created

### Backend (`backend/`)
- `src/shared/db.ts` - PostgreSQL connection pool
- `src/shared/cache.ts` - Redis client
- `src/shared/auth.ts` - Session middleware
- `src/shared/logger.ts` - Pino structured logging
- `src/highlight/app.ts` - CRUD, search, export
- `src/sync/app.ts` - WebSocket sync
- `src/aggregation/app.ts` - Popular highlights API
- `src/aggregation/worker.ts` - Background aggregation job
- `src/social/app.ts` - Auth, follow, share
- `src/db/migrations/001_initial_schema.sql` - Database schema
- `src/db/migrate.ts` - Migration runner
- `src/db/seed.ts` - Demo data seeder

### Frontend (`frontend/`)
- `src/api/client.ts` - Typed API client
- `src/stores/useStore.ts` - Zustand global state
- `src/routes/__root.tsx` - Layout with navigation
- `src/routes/index.tsx` - Landing page
- `src/routes/login.tsx` - Login form
- `src/routes/register.tsx` - Registration form
- `src/routes/library.tsx` - User's books and highlights
- `src/routes/books.$bookId.tsx` - Book detail with tabs
- `src/routes/trending.tsx` - Trending highlights
- `src/routes/export.tsx` - Export functionality

---

## Resources

- [Amazon Kindle Popular Highlights](https://www.amazon.com/gp/help/customer/display.html?nodeId=201630920)
- [WebSocket Protocol](https://tools.ietf.org/html/rfc6455)
- [Conflict-free Replicated Data Types](https://crdt.tech/)
- [Local-First Software](https://www.inkandswitch.com/local-first/)
- [Figma's Multiplayer Technology](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)

---

## Running the Project

```bash
# Start infrastructure
docker-compose up -d

# Backend
cd backend
npm install
npm run db:migrate
npm run db:seed
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Frontend: http://localhost:5173
Demo login: alice@example.com / password123
