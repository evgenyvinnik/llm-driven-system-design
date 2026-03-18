# Tinder - Matching Platform - Architecture Design

## System Overview

A location-based matching and recommendation system that enables users to discover potential matches based on location and preferences, swipe to express interest, and chat when mutually matched.

## Requirements

### Functional Requirements

- **Profile Browsing** - View potential matches based on location and preferences
- **Swiping Mechanism** - Like (right swipe) or pass (left swipe) on profiles
- **Match Detection** - Detect and notify when two users mutually like each other
- **Messaging** - Real-time chat between matched users
- **Discovery Preferences** - Age range, distance radius, gender preferences

### Non-Functional Requirements

- **Low Latency** - Card deck loading under 200ms at p95
- **Real-time** - Match notifications within 2 seconds
- **Scalability** - 15M daily active users, 1.5B swipes/day
- **Privacy** - Location never precisely exposed to other users
- **Availability** - 99.95% uptime (22 minutes downtime/month)

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Daily Active Users | 15M |
| Swipes per day | 1.5 billion |
| Messages per day | 750 million |
| Peak swipes per second | 50,000 |
| Storage per user (profile + photos) | 5MB avg |
| New matches per day | 25 million |

### Storage Estimates

| Data Type | Size per Record | Volume | Growth |
|-----------|-----------------|--------|--------|
| User profiles | 2KB | 75M total users | 500K new/month |
| Photos | 500KB avg, 5 per user | 200TB total | 2TB/month |
| Swipes | 50 bytes | 1.5B/day | 90-day retention |
| Messages | 200 bytes avg | 750M/day | 365-day after unmatch |
| Matches | 100 bytes | 25M/day | Indefinite |

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          Mobile / Web Clients                              │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
          ┌──────────────────┐   ┌──────────────────┐
          │   API Gateway    │   │   WebSocket GW   │
          │  (HTTP REST)     │   │  (Real-time)     │
          └────────┬─────────┘   └────────┬─────────┘
                   │                      │
       ┌───────────┼───────────┐          │
       │           │           │          │
       ▼           ▼           ▼          ▼
┌───────────┐ ┌───────────┐ ┌───────────────────┐
│  Profile  │ │ Discovery │ │    Matching +      │
│  Service  │ │  Service  │ │ Message Service    │
└─────┬─────┘ └─────┬─────┘ └─────────┬─────────┘
      │             │                   │
      └─────────────┼───────────────────┘
                    │
    ┌───────────────┼───────────────┬────────────────┐
    │               │               │                │
    ▼               ▼               ▼                ▼
┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌─────────┐
│ PostgreSQL  │ │    Redis    │ │Elasticsearch │ │  S3 /   │
│ + PostGIS   │ │  (Cache +   │ │ (Geo Search) │ │ MinIO   │
│ (Primary)   │ │  Pub/Sub)   │ │              │ │(Photos) │
└─────────────┘ └─────────────┘ └──────────────┘ └─────────┘
```

### Core Components

1. **Profile Service** - User profiles, photos, preferences management
2. **Discovery Service** - Geo-based candidate search, ranking, deck generation
3. **Matching Service** - Swipe processing, mutual-like detection, match creation
4. **Message Service** - Real-time chat between matched users
5. **WebSocket Gateway** - Persistent connections for match notifications and messages

## Database Schema

### Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              TINDER DATABASE SCHEMA                              │
└─────────────────────────────────────────────────────────────────────────────────┘

                                    ┌─────────────────┐
                                    │    sessions     │
                                    │─────────────────│
                                    │ sid (PK)        │
                                    │ sess            │
                                    │ expire          │
                                    └─────────────────┘

┌────────────────────────────────────────────────────────────────────────────────┐
│                              ┌─────────────────┐                              │
│                              │     users       │                              │
│                              │─────────────────│                              │
│                              │ id (PK)         │◄─────────────────────────┐   │
│                              │ email           │                          │   │
│                              │ password_hash   │                          │   │
│                              │ name            │                          │   │
│                              │ birthdate       │                          │   │
│                              │ gender          │                          │   │
│                              │ bio             │                          │   │
│                              │ latitude        │                          │   │
│                              │ longitude       │                          │   │
│                              │ location (geo)  │                          │   │
│                              │ last_active     │                          │   │
│                              │ is_admin        │                          │   │
│                              └────────┬────────┘                          │   │
│                                       │                                    │   │
│           ┌───────────────────────────┼──────────────────────┐            │   │
│           │                           │                      │            │   │
│           ▼ 1:1                       ▼ 1:N                  ▼ 1:N        │   │
│  ┌─────────────────┐         ┌─────────────────┐    ┌─────────────────┐  │   │
│  │user_preferences │         │     photos      │    │     swipes      │  │   │
│  │─────────────────│         │─────────────────│    │─────────────────│  │   │
│  │ user_id (PK,FK) │         │ id (PK)         │    │ id (PK)         │  │   │
│  │ interested_in   │         │ user_id (FK)    │    │ swiper_id (FK)  │──┘   │
│  │ age_min/max     │         │ url             │    │ swiped_id (FK)  │──────┤
│  │ distance_km     │         │ position        │    │ direction       │      │
│  │ show_me         │         │ is_primary      │    │ idempotency_key │      │
│  └─────────────────┘         └─────────────────┘    │ UNIQUE(swiper,  │      │
│                                                      │        swiped)  │      │
│                                                      └─────────────────┘      │
│                                                                                │
│    ┌─────────────────┐                      ┌─────────────────┐               │
│    │    matches      │                      │   messages      │               │
│    │─────────────────│                      │─────────────────│               │
│    │ id (PK)         │◄─────────────────────│ match_id (FK)   │               │
│    │ user1_id (FK)───┼──────────────────────│ sender_id (FK)──┼───────────────┘
│    │ user2_id (FK)───┼──────────────────────┼─────────────────┘
│    │ matched_at      │         1:N          │ id (PK)         │
│    │ last_message_at │                      │ content         │
│    │ unmatched_at    │                      │ sent_at         │
│    │ UNIQUE(u1,u2)   │                      │ read_at         │
│    └─────────────────┘                      └─────────────────┘
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Complete Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    name            VARCHAR(100) NOT NULL,
    birthdate       DATE NOT NULL,
    gender          VARCHAR(20) NOT NULL,
    bio             TEXT,
    job_title       VARCHAR(100),
    company         VARCHAR(100),
    school          VARCHAR(100),
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    location        GEOGRAPHY(Point, 4326),
    last_active     TIMESTAMP DEFAULT NOW(),
    created_at      TIMESTAMP DEFAULT NOW(),
    is_admin        BOOLEAN DEFAULT false
);

CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    interested_in   TEXT[] DEFAULT ARRAY['male', 'female'],
    age_min         INTEGER DEFAULT 18,
    age_max         INTEGER DEFAULT 100,
    distance_km     INTEGER DEFAULT 50,
    show_me         BOOLEAN DEFAULT true
);

CREATE TABLE photos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url             VARCHAR(512) NOT NULL,
    position        INTEGER NOT NULL,
    is_primary      BOOLEAN DEFAULT false,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE swipes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    swiper_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    swiped_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    direction       VARCHAR(10) NOT NULL CHECK (direction IN ('like', 'pass')),
    idempotency_key VARCHAR(64),
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(swiper_id, swiped_id)
);

CREATE TABLE matches (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user2_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    matched_at      TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP,
    unmatched_at    TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    sent_at         TIMESTAMP DEFAULT NOW(),
    read_at         TIMESTAMP
);

CREATE TABLE sessions (
    sid             VARCHAR(255) PRIMARY KEY,
    sess            JSON NOT NULL,
    expire          TIMESTAMP NOT NULL
);

-- Indexes
CREATE INDEX idx_users_location ON users USING GIST (location);
CREATE INDEX idx_users_gender ON users(gender);
CREATE INDEX idx_users_birthdate ON users(birthdate);
CREATE INDEX idx_users_last_active ON users(last_active);
CREATE INDEX idx_photos_user ON photos(user_id);
CREATE INDEX idx_photos_position ON photos(user_id, position);
CREATE INDEX idx_swipes_swiper ON swipes(swiper_id);
CREATE INDEX idx_swipes_swiped ON swipes(swiped_id);
CREATE INDEX idx_swipes_direction ON swipes(swiper_id, direction);
CREATE INDEX idx_swipes_idempotency_key ON swipes(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_matches_user1 ON matches(user1_id);
CREATE INDEX idx_matches_user2 ON matches(user2_id);
CREATE INDEX idx_matches_last_message ON matches(last_message_at);
CREATE INDEX idx_messages_match ON messages(match_id);
CREATE INDEX idx_messages_sent ON messages(sent_at);
CREATE INDEX idx_sessions_expire ON sessions(expire);

-- Trigger: auto-sync PostGIS geography from lat/lng
CREATE OR REPLACE FUNCTION update_user_location()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
        NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_user_location
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_user_location();

-- Utility: calculate age from birthdate
CREATE OR REPLACE FUNCTION calculate_age(birthdate DATE)
RETURNS INTEGER AS $$
BEGIN
    RETURN EXTRACT(YEAR FROM AGE(birthdate));
END;
$$ LANGUAGE plpgsql;

-- Trigger: auto-update swipe timestamp on modification
CREATE OR REPLACE FUNCTION update_swipe_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_swipe_timestamp
    BEFORE UPDATE ON swipes
    FOR EACH ROW EXECUTE FUNCTION update_swipe_timestamp();
```

### Elasticsearch Index

```json
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "name": { "type": "text" },
      "gender": { "type": "keyword" },
      "age": { "type": "integer" },
      "location": { "type": "geo_point" },
      "last_active": { "type": "date" },
      "show_me": { "type": "boolean" },
      "interested_in": { "type": "keyword" }
    }
  }
}
```

### Redis Data Structures

```
# Swipe tracking (24h TTL)
swipes:{user_id}:liked    -> Set of user IDs liked
swipes:{user_id}:passed   -> Set of user IDs passed

# Likes received (7-day TTL, for "Likes You" feature)
likes:received:{user_id}  -> Set of user IDs who liked this user

# User location cache (1h TTL)
user:{user_id}:location   -> JSON { latitude, longitude }

# Session storage (24h TTL)
session:{session_id}      -> JSON session data

# Rate limiting (sliding window)
rate_limit:{user_id}      -> Sorted set of timestamps
```

## API Design

### Authentication
```
POST /api/auth/register     # Register new user
POST /api/auth/login        # Login
POST /api/auth/logout       # Logout
GET  /api/auth/me           # Get current user
```

### User Management
```
GET  /api/users/profile     # Get own profile
PUT  /api/users/profile     # Update profile
PUT  /api/users/location    # Update location
GET  /api/users/preferences # Get discovery preferences
PUT  /api/users/preferences # Update preferences
GET/POST/DELETE /api/users/photos  # Manage photos
```

### Discovery
```
GET  /api/discovery/deck    # Get discovery card deck
POST /api/discovery/swipe   # Swipe on user
GET  /api/discovery/likes   # Get users who liked you
```

### Matches and Messaging
```
GET    /api/matches                  # Get all matches
GET    /api/matches/:id/messages     # Get conversation messages
POST   /api/matches/:id/messages     # Send message
DELETE /api/matches/:id              # Unmatch
```

### WebSocket Events
```
auth         # Authenticate WebSocket connection
new_match    # Match notification (server -> client)
new_message  # Message notification (server -> client)
typing       # Typing indicator (bidirectional)
```

## Key Design Decisions

### Discovery: Elasticsearch over PostGIS Alone

**Problem**: The discovery deck must filter candidates by location, age, gender, preferences, and exclude already-swiped users -- then rank by distance and activity.

**Why Elasticsearch**: PostGIS handles geo-queries well, but discovery queries combine geo-distance with multi-field filtering (gender, age range, show_me preference), exclusion lists (already swiped), and custom scoring (distance + last_active weighting). Elasticsearch handles these complex compound queries more efficiently than building equivalent SQL with JOIN/WHERE/EXCEPT clauses. It also scales horizontally for read-heavy workloads: discovery is 10x more read-heavy than any other operation.

**PostGIS as fallback**: If Elasticsearch is unavailable, the discovery service falls back to PostGIS with `ST_DWithin` queries. Results are less optimally ranked but functionally correct.

**Trade-off**: Requires syncing user profiles to Elasticsearch, adding operational complexity. Location updates must propagate quickly (< 5 seconds) or users see stale decks.

### Swipe Storage: Redis Sets + PostgreSQL

**Problem**: Every swipe must check "have I already seen this user?" before showing them in the deck. At 1.5B swipes/day, this lookup must be sub-millisecond.

**Solution**: Store swipe history in Redis Sets (`SISMEMBER` is O(1)) with 24-hour TTL for memory management. PostgreSQL stores the durable record for match detection and analytics. Eventual consistency between Redis and PostgreSQL is acceptable because a brief duplicate showing is tolerable (user just passes again).

**Why not just PostgreSQL?** A query like `SELECT swiped_id FROM swipes WHERE swiper_id = ?` returns thousands of IDs. Loading this into application memory on every deck request adds 10-50ms latency. Redis Set membership check takes < 0.5ms.

**Trade-off**: Memory cost. A power user who swipes 1,000 times has a ~16KB Redis set. At 15M DAU, swipe sets consume ~60GB Redis memory. The 24-hour TTL bounds this, but requires cache warmup if Redis restarts.

### Match Detection: Real-time on Every Like

**Problem**: When user A likes user B, we must check if B already liked A (mutual match).

**Solution**: On every "like" swipe, immediately check `SISMEMBER swipes:{swiped_id}:liked {swiper_id}` in Redis. If mutual, create a match row and notify both users via WebSocket (Redis Pub/Sub for cross-server delivery).

**Why not batch matching?** Batch matching (e.g., run matching jobs every 30 seconds) would delay the dopamine hit of a match notification. Dating apps are engagement-driven; the instant match moment is a core UX differentiator. The Redis lookup adds < 1ms to swipe processing, making real-time detection trivially cheap.

**Trade-off**: Every like swipe does an extra Redis lookup + potential PostgreSQL INSERT (match) + two WebSocket pushes. Under flash-crowd conditions (e.g., a viral moment), this creates write amplification. Mitigation: rate-limit swipes to 50/15-minutes.

### Real-time Messaging: WebSocket + Redis Pub/Sub

**Problem**: Matched users expect instant message delivery (< 500ms) and typing indicators.

**Solution**: WebSocket connections from clients to the API server. Messages are persisted to PostgreSQL, then delivered via WebSocket. When sender and recipient connect to different API servers, Redis Pub/Sub routes the message cross-server.

**Why not long polling?** Long polling adds 0-1 second latency per message (must wait for next poll cycle). For a chat experience, this feels sluggish. WebSocket maintains a persistent connection with < 50ms delivery latency. The trade-off is connection management complexity: heartbeats, reconnection logic, and per-server connection limits (~10K concurrent WebSocket connections per Node.js process).

## Consistency and Idempotency

### Idempotent Swipe Processing

Clients can provide an `idempotencyKey` with swipe requests. The database enforces `UNIQUE(swiper_id, swiped_id)`, and the idempotency key column enables safe retries without re-triggering match detection.

```
POST /api/discovery/swipe
{ "userId": "target-uuid", "direction": "like", "idempotencyKey": "client-uuid" }

1. Check idempotency key in swipes table
2. If exists -> return cached result (no re-processing)
3. If new -> INSERT with ON CONFLICT DO UPDATE
4. Match detection runs only on new swipes
```

### Match Ordering

Matches store `user1_id = LEAST(a, b)` and `user2_id = GREATEST(a, b)` with a UNIQUE constraint. This prevents duplicate match records regardless of which user swipes second.

## Security

- **Password hashing**: bcrypt with auto-generated salt
- **Session auth**: Cookie-based sessions stored in PostgreSQL (express-session)
- **Location privacy**: Only relative distance shown ("5 miles away"), never exact coordinates
- **Input validation**: All endpoints validate input types and ranges
- **Rate limiting**: Per-user sliding window (50 swipes/15 min, 100 swipes/hour)
- **CORS**: Configured for frontend origin only
- **Photo access**: URLs served through API, not direct storage access

## Observability

### Metrics (Prometheus via prom-client)

```
# Funnel metrics
discovery_deck_requests_total
swipes_total{direction="like|pass"}
matches_total
messages_total

# Performance
discovery_deck_duration_seconds
swipe_processing_duration_seconds
http_request_duration_seconds{method, path, status}

# Cache effectiveness
cache_hits_total{cache_type="swipe_history|location|session"}
cache_misses_total{cache_type}

# Rate limiting
rate_limited_requests_total{endpoint}
```

### Structured Logging

Pino JSON logging with request IDs, user context, and latency tracking.

### Alerting

| Metric | Warning | Critical |
|--------|---------|----------|
| Deck generation p95 | > 200ms | > 500ms |
| Match detection latency | > 100ms | > 500ms |
| WebSocket connections | > 5K/server | > 8K/server |
| Swipe cache hit rate | < 80% | < 60% |
| Error rate (5xx) | > 1% | > 5% |

## Failure Handling

- **Elasticsearch down**: Fall back to PostGIS-only discovery (slower, less optimal ranking)
- **Redis down**: Fall back to PostgreSQL for swipe history lookup, skip caching
- **WebSocket disconnect**: Client auto-reconnects with exponential backoff, missed messages fetched via REST
- **Match notification failure**: Message persisted to PostgreSQL; client fetches matches on reconnect

## Scalability Considerations

### Horizontal Scaling

- **API servers**: Stateless behind load balancer, scale by CPU/connection count
- **Redis**: Cluster mode for swipe sets exceeding single-node memory
- **Elasticsearch**: Per-region clusters (users primarily match locally)
- **PostgreSQL**: Read replicas for match/message reads; vertical scaling for writes
- **WebSocket**: Sticky sessions per user; Redis Pub/Sub bridges cross-server messaging

### Regional Deployment

Users primarily match within their region. Deploy Elasticsearch clusters per region to keep geo-queries local. Cross-region matching is handled as an edge case with higher latency tolerance.

### Hot Spot Handling

- Rate limit deck appearances to prevent profile fatigue
- Cap swipes per hour for free users
- Queue popular users for batch processing rather than appearing in every deck simultaneously

## Data Lifecycle Policies

| Data | Retention | Rationale |
|------|-----------|-----------|
| User profiles | Until account deletion | Core data |
| Photos | Until user deletes | User-managed |
| Swipes | 90 days | No need to store old passes |
| Active match messages | Indefinite | Users expect conversation history |
| Post-unmatch messages | 365 days | Privacy + storage optimization |
| Redis swipe sets | 24-hour TTL | Session-level deduplication |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geo search | Elasticsearch | PostGIS only | Complex multi-field queries, horizontal scaling |
| Swipe tracking | Redis Sets + PG | PostgreSQL only | O(1) membership check vs O(n) query |
| Match detection | Real-time per-swipe | Batch processing | Instant UX, < 1ms extra cost |
| Messaging | WebSocket + Pub/Sub | Long polling | Sub-50ms delivery, typing indicators |
| Session storage | PostgreSQL (express-session) | Redis sessions | Simpler setup |
| Photo storage | S3 / MinIO | Database BLOBs | Scalable, CDN-friendly |

## Frontend Architecture

### Technology Stack

React 19 + TypeScript + Vite + TanStack Router (file-based routing) + Zustand (state management) + Tailwind CSS + WebSocket client for real-time features.

### Component Hierarchy

```
__root.tsx (minimal root, no persistent layout -- each page owns its chrome)
├── index.tsx              → HomePage: swipe card deck + match modal
├── matches.tsx            → MatchesPage: list of matched users with last message preview
├── chat.$matchId.tsx      → ChatPage: real-time messaging with a matched user
├── profile.tsx            → ProfilePage: edit name, bio, job, school
├── preferences.tsx        → PreferencesPage: age range, distance, gender preferences
├── portraits.tsx          → PortraitsPage: ReignsAvatar showcase/gallery
├── admin.tsx              → AdminPage: platform stats and user management
├── admin/users.tsx        → AdminUsersPage: user list with ban/delete actions
├── login.tsx              → Login form
└── register.tsx           → Registration form with birthdate, gender, bio fields
```

### Zustand Stores

**`authStore`** -- manages user session, login, registration, logout, profile updates, and location updates. On successful login or registration, automatically connects the WebSocket service by calling `wsService.connect(user.id)`. On logout, disconnects WebSocket. The `checkAuth()` action validates the session on app load by calling `/api/auth/me` and reconnects WebSocket if the session is still valid. Also exposes `updateProfile()` for editing profile fields and `updateLocation()` for sending geolocation coordinates to the backend.

**`discoveryStore`** -- manages the swipe deck lifecycle. Stores the `deck` array (up to 20 discovery cards), `currentIndex` (pointer to the current card in the deck), and `lastMatch` (the most recent match, shown in the match modal). The `loadDeck()` action fetches a fresh deck from `/api/discovery/deck?limit=20`. The `swipe()` action sends a like/pass to the backend, advances `currentIndex`, and if the result includes a `match` object, stores it in `lastMatch` to trigger the MatchModal. Critically, when the user is 3 cards from the end of the deck (`nextIndex >= deck.length - 3`), it automatically calls `loadDeck()` to pre-fetch the next batch, ensuring the user never sees a loading spinner between cards.

**`matchStore`** -- manages matches and messaging. Stores `matches` (list of all matches with last message previews), `currentMatchId` (the active conversation), `messages` (messages for the current conversation), and `unreadCount`. The `loadMessages()` action fetches messages for a match and reverses them (API returns newest-first, UI displays oldest-first). The `sendMessage()` action posts a message and immediately appends it to the local messages array with `is_mine: true`, providing an optimistic update. The `subscribeToMessages()` action registers WebSocket handlers for `new_message` and `new_match` events and returns an unsubscribe function for cleanup. When a `new_message` event arrives, `addMessage()` appends it to the current conversation and updates the match list's last message preview.

### Real-Time Updates via WebSocket

The WebSocket client (`services/websocket.ts`) is a singleton class that manages a persistent connection to the backend. It supports three message types:

- **`auth`** -- sent by the client immediately after connection to authenticate the WebSocket with a user ID
- **`new_match`** -- received from the server when a mutual like is detected, triggers `matchStore.loadMatches()` to refresh the match list
- **`new_message`** -- received from the server when the other user sends a message, triggers `matchStore.addMessage()` to append to the current conversation

The WebSocket service implements automatic reconnection with exponential backoff. If the connection drops, it retries up to 5 times with delays of 1s, 2s, 4s, 8s, 16s. The `on()` method returns an unsubscribe function, which React components use in `useEffect` cleanup to prevent memory leaks. The `sendTyping()` method broadcasts typing indicators to the other user in a conversation.

The integration between Zustand stores and WebSocket is clean: `authStore` controls connection lifecycle (connect on login, disconnect on logout), while `matchStore` controls event subscription (subscribe on mount, unsubscribe on unmount). This separation means the WebSocket stays connected across page navigations, but message handlers are only active when the relevant component is mounted.

### Swipe Card UI

The `SwipeCard` component implements drag-to-swipe using raw touch and mouse events (no gesture library). The card tracks `dragDelta` (x/y pixel offset from where the drag started) and applies CSS transforms: `translateX` for horizontal movement, `translateY * 0.3` for dampened vertical movement, and `rotate(dragDelta.x * 0.1)deg` for tilt. Opacity decreases as the card moves further from center (`1 - abs(dragDelta.x) / 500`).

When the drag exceeds a 100px threshold in either direction, the `onSwipe` callback fires with `'like'` (right) or `'pass'` (left). The parent `HomePage` applies a CSS exit animation class (`animate-swipe-right` or `animate-swipe-left`) for 300ms before advancing to the next card, creating a smooth departure effect.

The deck renders two cards simultaneously: the current card on top and the next card behind it (at 95% scale and 80% opacity). This creates the visual illusion of a card stack and ensures the next card is already visible as the current card swipes away.

The `SwipeCard` component supports two visual modes: ReignsAvatar (procedurally generated medieval-portrait SVG avatars, used by default since there are no real user photos) and photo mode with navigation indicators and tap-to-advance areas for multi-photo browsing.

### Match Modal

When `discoveryStore.lastMatch` is non-null, the `MatchModal` overlay renders with a celebratory animation. The modal shows a pulsing gradient heart icon, the matched user's ReignsAvatar, and two action buttons: "Send Message" (navigates to the chat route with the match ID) and "Keep Swiping" (clears the match and returns to the deck). The modal uses `animate-match-pop` for a scale-in entrance effect.

### Chat Interface

The `chat.$matchId.tsx` route implements a mobile-first messaging interface. Messages are displayed in a scrollable list with sender-aligned bubbles (right-aligned gradient bubbles for the current user, left-aligned white bubbles for the other user). The `useEffect` hook auto-scrolls to the newest message using `messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })`. The chat subscribes to WebSocket messages on mount and unsubscribes on unmount. An options menu provides an "Unmatch" action with a confirmation dialog.

### Data Fetching Patterns

The API client (`services/api.ts`) organizes endpoints into domain-specific modules: `authApi`, `userApi`, `discoveryApi`, `matchApi`, and `adminApi`. Each module exports typed functions that wrap the generic `request()` helper. The `request()` helper includes `credentials: 'include'` for cookie-based session auth and extracts error messages from JSON error responses.

Photo uploads use a separate code path that bypasses JSON serialization, sending `FormData` directly via `fetch` to support multipart file uploads.

### Geolocation

On the home page, the app requests the browser's geolocation permission via `navigator.geolocation.getCurrentPosition()`. If granted, the user's coordinates are sent to `PUT /api/users/location`, which updates their PostGIS geography column and syncs to Elasticsearch. This happens once per session (only if `user.latitude` is not already set), not continuously, to avoid battery drain and excessive API calls.

### Bottom Navigation

The `BottomNav` component renders a persistent mobile-style navigation bar with icons for Discover (flame), Matches (chat bubble), Profile (person), and Preferences (sliders). The matches icon shows an unread count badge when `matchStore.unreadCount > 0`.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (JSON objects) rather than freeform text strings. A traditional log line like `"User 123 liked user 456, match detected, 12ms"` is easy for a human to read but difficult for a machine to search or aggregate. A structured log entry for the same event looks like `{"userId":"123","targetId":"456","action":"like","match":true,"latencyMs":12,"level":"info"}`.

The key advantage is that log aggregation systems (ELK stack, Grafana Loki, Datadog) can index JSON fields for fast querying. An operator can query "show me all match detections with latency > 100ms in the last hour" by filtering on `action=like AND match=true AND latencyMs>100`. With freeform text, this would require fragile regex parsing.

In this project, structured logging uses Pino (`backend/src/shared/logger.ts`). Pino writes JSON directly to stdout, which is significantly faster than alternatives like Winston because it avoids string formatting. Every HTTP request gets a unique `requestId` attached to all log entries for that request, enabling full request lifecycle tracing.

### Prometheus Metrics

Prometheus is a time-series monitoring system where the application exposes numeric metrics at an HTTP endpoint (`/metrics`), and a Prometheus server periodically scrapes that endpoint. The "pull-based" model (Prometheus pulls from the application) is simpler than push-based alternatives because the application does not need to know the monitoring server's address or handle connection failures.

Metrics come in four types. **Counters** are monotonically increasing (e.g., `swipes_total{direction="like"}` -- total likes since process start). **Gauges** go up and down (e.g., WebSocket connection count). **Histograms** track value distributions (e.g., `discovery_deck_duration_seconds` -- how long deck generation takes, bucketed into latency ranges).

In this project, metrics are implemented using `prom-client` (`backend/src/shared/metrics.ts`). The key business metrics track the dating funnel: deck requests, swipes (labeled by direction), matches, and messages sent. Cache effectiveness metrics (`cache_hits_total` / `cache_misses_total` by cache type) help identify whether Redis is providing value. Rate limiting metrics track how often users hit limits, which helps calibrate thresholds.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without rate limiting, a single user could swipe thousands of times per minute, overwhelming the backend and creating an unfair experience for others.

In this project, rate limiting uses per-user sliding window counters (`backend/src/shared/rateLimit.ts`). Swipes are limited to 50 per 15 minutes and 100 per hour. A sliding window counts requests across a rolling time period, which is more accurate than a fixed window. With a fixed 15-minute window, a user could make 50 swipes in the last second of one window and 50 more in the first second of the next, effectively making 100 swipes in 2 seconds. A sliding window prevents this boundary-burst exploit.

The implementation uses `express-rate-limit` middleware. When a user exceeds the limit, the API returns a 429 Too Many Requests response with a `Retry-After` header telling the client when they can resume.

### Idempotency

Idempotency means performing the same operation multiple times produces the same result as performing it once. In a dating app, this matters because network errors can cause swipe retries. Without idempotency, a retry could create a duplicate swipe record, potentially re-triggering match detection and sending a duplicate match notification.

In this project, swipe processing uses two idempotency mechanisms. First, the database enforces a `UNIQUE(swiper_id, swiped_id)` constraint, so duplicate swipe inserts fail at the database level. Second, clients can provide an `idempotencyKey` with the swipe request. The server checks for this key in the swipes table before processing. If the key exists, the cached result is returned without re-running match detection.

The `INSERT ... ON CONFLICT DO UPDATE` pattern handles the database-level deduplication. When a duplicate swipe arrives, instead of failing with a unique constraint violation, the database updates the existing row's timestamp. This approach is simpler than checking for existence first and then inserting, because it avoids a race condition where two concurrent requests both check, both find nothing, and both try to insert.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "cache hit"), it is returned immediately. If not (a "cache miss"), the application queries the database, stores the result in the cache with a TTL, and returns the result.

In this project, Redis cache-aside is used for swipe tracking. The discovery service needs to exclude already-swiped users from the deck. Querying `SELECT swiped_id FROM swipes WHERE swiper_id = ?` for every deck request would return thousands of IDs, adding 10-50ms latency. Instead, swipe history is cached in Redis Sets with a 24-hour TTL. Checking membership in a Redis Set (`SISMEMBER`) is O(1) -- constant time regardless of how many users have been swiped.

User location is also cached in Redis with a 1-hour TTL, avoiding a database lookup on every discovery request.

The trade-off is memory usage. A power user who swipes 1,000 times has a ~16KB Redis set. At 15M daily active users, swipe sets could consume ~60GB. The 24-hour TTL bounds this, but if Redis restarts, the cache is cold and must be re-warmed from PostgreSQL.

### Circuit Breaker

A circuit breaker prevents an application from repeatedly calling a service that is failing. It has three states: **CLOSED** (normal -- all requests pass through), **OPEN** (tripped -- all requests immediately fail with a fallback response), and **HALF-OPEN** (testing -- a few requests pass through to check if the service has recovered).

In this project, the discovery service wraps Elasticsearch calls in a circuit breaker. If Elasticsearch fails 5 times in 30 seconds, the breaker trips to OPEN. While open, discovery requests fall back to PostGIS-only queries (`ST_DWithin`). After 30 seconds, the breaker moves to HALF-OPEN and allows a test request through. If it succeeds, the breaker closes and Elasticsearch is used again.

Without the circuit breaker, a failing Elasticsearch cluster would cause every discovery request to hang for the full 5-second timeout before failing. With the breaker, the first few failures trip it, and all subsequent requests immediately get the PostGIS fallback response in milliseconds. This protects both the user experience and Elasticsearch (giving it time to recover without being hammered by requests).

Note: while the architecture document mentions circuit breakers as a pattern, the Opossum library integration around Elasticsearch is listed under "What Was Omitted" in the implementation notes. The PostGIS fallback is implemented directly in the discovery service as a conditional code path.

### Health Checks

Health checks are HTTP endpoints that report whether a service is functioning correctly. Load balancers use them to determine whether to route traffic to a service instance. Container orchestrators use them to decide whether to restart a container.

A **liveness check** confirms the process is running. A **readiness check** confirms the service can handle traffic (database connections established, caches warmed). A **detailed check** reports per-dependency status so operators can quickly identify which component is failing.

In this project, health checks test each dependency with a lightweight operation: `SELECT 1` for PostgreSQL, `PING` for Redis, and a cluster health check for Elasticsearch. Each check has its own timeout so a single slow dependency does not block the entire health endpoint. The response distinguishes between critical dependencies (PostgreSQL -- if down, service is unhealthy) and non-critical dependencies (Elasticsearch -- if down, service is degraded but functional via PostGIS fallback).

## Implementation Notes

This section documents the actual local setup, what production patterns are implemented, what was simplified, and what was omitted.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│           (Vite dev server, localhost:5173)               │
│     SwipeCard, MatchModal, ReignsAvatar, Chat UI         │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP + WebSocket
                          ▼
┌──────────────────────────────────────────────────────────┐
│       Express API + WebSocket Server (localhost:3001)      │
│              (or 3002/3003 for multi-instance)            │
└────┬──────────┬──────────┬───────────────────────────────┘
     │          │          │
     ▼          ▼          ▼
┌─────────┐ ┌────────┐ ┌───────┐
│PostgreSQL│ │ Valkey │ │Elastic│
│+ PostGIS│ │ :6379  │ │Search │
│  :5432  │ │        │ │ :9200 │
└─────────┘ └────────┘ └───────┘
```

All infrastructure runs via `docker-compose up -d`.

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Structured logging | Pino with JSON output | `backend/src/shared/logger.ts` |
| Prometheus metrics | prom-client: swipe funnel, cache hits, latency | `backend/src/shared/metrics.ts` |
| Rate limiting | express-rate-limit with per-user sliding window | `backend/src/shared/rateLimit.ts` |
| Idempotent swipes | Database UNIQUE constraint + idempotency_key column | `backend/src/routes/discovery.ts` |
| Geo-based discovery | Elasticsearch geo_distance + multi-field filter | `backend/src/services/discoveryService.ts` |
| PostGIS fallback | ST_DWithin queries when ES unavailable | `backend/src/services/discoveryService.ts` |
| Redis swipe cache | Redis Sets for O(1) "already swiped" checks | `backend/src/services/discoveryService.ts` |
| Real-time match detection | Redis SISMEMBER on every like | `backend/src/services/matchService.ts` |
| WebSocket messaging | ws library + Redis Pub/Sub for cross-server | `backend/src/services/websocketGateway.ts` |
| Photo upload | Multer + local disk storage | `backend/src/routes/users.ts` |
| Session auth | express-session with PostgreSQL store | `backend/src/middleware/auth.ts` |
| Procedural avatars | ReignsAvatar SVG component (seed-based) | `frontend/src/components/ReignsAvatar/` |
| Data retention | Cleanup script for old swipes/messages | `backend/src/shared/retention.ts`, `backend/src/scripts/cleanup.ts` |
| Seed data | Generates test users with locations | `backend/src/db/seed.ts` |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Why |
|-------------------|-----------------|-----|
| S3 + CDN for photos | Local disk (`uploads/` directory) | No cloud dependency |
| AWS ALB / API Gateway | Direct Express server (port 3001) | No load balancer |
| PostgreSQL read replicas | Single PostgreSQL + PostGIS instance | Sufficient for dev |
| Redis Cluster | Single Valkey instance | < 100MB data |
| Multi-node Elasticsearch | Single ES node (512MB heap) | Dev-scale index |
| OAuth / social login | Cookie-based session auth (express-session) | Simpler |
| Push notifications (APNs/FCM) | WebSocket-only delivery | No mobile app |
| Grafana dashboards | Prometheus `/metrics` endpoint only | Metrics exposed, no visualization |
| ML-based ranking | Distance + last_active scoring | No training pipeline |
| Procedural avatars instead of real photos | ReignsAvatar component generates medieval-portrait SVGs from user seed | Avoids need for photo moderation and sample images |

### What Was Omitted

- CDN for photo delivery
- Multi-region deployment and cross-region matching
- Database sharding
- Kubernetes / container orchestration
- Photo moderation (nudity detection, face verification)
- Machine learning recommendation engine
- Super Likes, Boosts, premium features
- Push notifications (APNs/FCM)
- Video chat integration
- Bloom filters for swipe history (memory optimization)
- Circuit breakers (Opossum) around Elasticsearch
- Distributed tracing (OpenTelemetry)
- A/B testing infrastructure for ranking algorithms

---

*Architecture document for a local development learning project. Production deployment would require additional considerations for multi-region, compliance, photo moderation, and premium feature gating.*
