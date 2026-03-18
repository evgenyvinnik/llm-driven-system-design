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
