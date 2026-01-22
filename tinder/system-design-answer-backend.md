# Tinder - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 1. Requirements Clarification (3 minutes)

### Functional Requirements
- **User Registration & Profiles**: Account creation with photos, bio, preferences
- **Geospatial Discovery**: Find potential matches within configurable radius
- **Swipe System**: Like/Pass actions with persistence and deduplication
- **Match Detection**: Real-time mutual like detection
- **Messaging**: Chat between matched users only
- **Unmatch**: Remove matches and conversation history

### Non-Functional Requirements
- **Low Latency**: Swipe processing < 50ms, discovery < 200ms
- **High Availability**: 99.9% uptime for core matching
- **Scalability**: Support millions of concurrent users
- **Data Consistency**: No duplicate matches, no lost swipes
- **Privacy**: Location never exposed, only relative distance

### Scale Estimation
- 50M daily active users
- 1.5B swipes per day (~17K/second)
- 30M matches per day
- 500M messages per day

---

## 2. High-Level Design (5 minutes)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Mobile    │────▶│ API Gateway  │────▶│ Authentication  │
│    Apps     │     │ (Rate Limit) │     │    Service      │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│   Discovery     │ │   Swipe     │ │    Messaging    │
│    Service      │ │  Service    │ │     Service     │
└────────┬────────┘ └──────┬──────┘ └────────┬────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐
│  Elasticsearch  │ │ Redis Sets  │ │ Redis Pub/Sub   │
│  (Geo Search)   │ │ (Swipes)    │ │ (Real-time)     │
└─────────────────┘ └─────────────┘ └─────────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   PostgreSQL    │
                  │   + PostGIS     │
                  └─────────────────┘
```

---

## 3. Data Model Design (7 minutes)

### PostgreSQL Schema with PostGIS

```
┌─────────────────────────────────────────────────────────────────┐
│                         users                                    │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), email (UNIQUE), phone, password_hash              │
│ name, birth_date, gender, bio                                    │
│ location (GEOGRAPHY Point 4326), location_updated_at            │
│ show_me (VARCHAR[]), age_min, age_max, distance_km              │
│ is_active, is_verified, last_active, created_at                 │
├─────────────────────────────────────────────────────────────────┤
│ INDEX GIST: location (for efficient geo queries)                │
│ INDEX: is_active + last_active DESC                             │
│ INDEX: gender                                                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         swipes                                   │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), swiper_id (FK), swiped_id (FK)                    │
│ direction: like | pass | super_like                              │
│ idempotency_key (UNIQUE), created_at                            │
│ UNIQUE (swiper_id, swiped_id)                                   │
├─────────────────────────────────────────────────────────────────┤
│ INDEX: swiper_id + created_at DESC                              │
│ INDEX: swiped_id WHERE direction IN (like, super_like)          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         matches                                  │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), user1_id (FK), user2_id (FK)                      │
│ matched_at, unmatched_at, unmatched_by                          │
│ CONSTRAINT: user1_id < user2_id (ordered for uniqueness)        │
│ UNIQUE (user1_id, user2_id)                                     │
├─────────────────────────────────────────────────────────────────┤
│ INDEX: user1_id WHERE unmatched_at IS NULL                      │
│ INDEX: user2_id WHERE unmatched_at IS NULL                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        messages                                  │
├─────────────────────────────────────────────────────────────────┤
│ id (UUID PK), match_id (FK), sender_id (FK)                     │
│ content (TEXT), read_at, created_at                             │
├─────────────────────────────────────────────────────────────────┤
│ INDEX: match_id + created_at DESC                               │
└─────────────────────────────────────────────────────────────────┘
```

### Redis Data Structures

```
┌─────────────────────────────────────────────────────────────────┐
│                      Redis Key Patterns                          │
├─────────────────────────────────────────────────────────────────┤
│  swipes:{user_id}:liked    │ SET of user IDs (24h TTL)         │
│  swipes:{user_id}:passed   │ SET of user IDs (24h TTL)         │
│  swipes:{user_id}:seen     │ SET of all seen user IDs          │
├─────────────────────────────────────────────────────────────────┤
│  likes:received:{user_id}  │ SORTED SET (user_id → timestamp)  │
│                            │ 7 days TTL                         │
├─────────────────────────────────────────────────────────────────┤
│  user:{user_id}:location   │ HASH {lat, lon, updated_at}       │
│                            │ 1 hour TTL                         │
├─────────────────────────────────────────────────────────────────┤
│  ratelimit:swipes:{user_id}│ Counter with 15-minute window     │
└─────────────────────────────────────────────────────────────────┘
```

### Elasticsearch Index

```
┌─────────────────────────────────────────────────────────────────┐
│                     users Index Mapping                          │
├─────────────────────────────────────────────────────────────────┤
│  user_id       │ keyword                                        │
│  location      │ geo_point                                      │
│  gender        │ keyword                                        │
│  age           │ integer                                        │
│  show_me       │ keyword (array)                                │
│  is_active     │ boolean                                        │
│  last_active   │ date                                           │
│  profile_score │ float                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. API Design (5 minutes)

### Discovery API

```
┌─────────────────────────────────────────────────────────────────┐
│                   GET /api/discovery/deck                        │
├─────────────────────────────────────────────────────────────────┤
│  Request:                                                        │
│    latitude, longitude, limit (default 10)                      │
├─────────────────────────────────────────────────────────────────┤
│  Response:                                                       │
│    profiles: ProfileCard[]                                       │
│    remaining_swipes: number                                      │
│    next_refresh_at: ISO timestamp                               │
├─────────────────────────────────────────────────────────────────┤
│  ProfileCard:                                                    │
│    id, name, age, bio, photos[]                                 │
│    distance_text: "5 miles away" (never exact)                  │
│    common_interests[]                                           │
└─────────────────────────────────────────────────────────────────┘
```

### Swipe API

```
┌─────────────────────────────────────────────────────────────────┐
│                     POST /api/swipes                             │
├─────────────────────────────────────────────────────────────────┤
│  Request:                                                        │
│    target_user_id, direction (like|pass|super_like)             │
│    idempotency_key (client-generated UUID)                      │
├─────────────────────────────────────────────────────────────────┤
│  Response:                                                       │
│    success: boolean                                              │
│    match?: { match_id, matched_user, matched_at }               │
│    remaining_swipes: number                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Match API

```
┌─────────────────────────────────────────────────────────────────┐
│                      GET /api/matches                            │
├─────────────────────────────────────────────────────────────────┤
│  Response:                                                       │
│    matches: Match[]                                              │
│    total: number                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Match:                                                          │
│    id, user: ProfileCard, matched_at                            │
│    last_message?: { content, sent_at, is_read }                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Geospatial Discovery (10 minutes)

### Elasticsearch Geo Query Strategy

"The discovery service uses Elasticsearch as the primary geo search engine because it's optimized for read-heavy workloads with complex filtering. PostGIS serves as a fallback when Elasticsearch is unavailable."

```
┌─────────────────────────────────────────────────────────────────┐
│                  Discovery Query Pipeline                        │
├─────────────────────────────────────────────────────────────────┤
│  1. Get seen users from Redis SET                               │
│  2. Build Elasticsearch bool query:                             │
│     ┌───────────────────────────────────────────────────────┐   │
│     │ must:                                                 │   │
│     │   - gender matches preferences (terms)                │   │
│     │   - age in range (range query)                        │   │
│     │   - is_active = true                                  │   │
│     │   - last_active within 7 days                         │   │
│     │   - mutual interest (show_me includes my gender)      │   │
│     ├───────────────────────────────────────────────────────┤   │
│     │ must_not:                                             │   │
│     │   - user_id = self                                    │   │
│     │   - user_id in seen_users                             │   │
│     ├───────────────────────────────────────────────────────┤   │
│     │ filter:                                               │   │
│     │   - geo_distance within preferences.distance_km       │   │
│     └───────────────────────────────────────────────────────┘   │
│  3. Sort by: distance ASC, profile_score DESC, last_active DESC │
│  4. Fetch 50 candidates, randomize client-side for freshness    │
└─────────────────────────────────────────────────────────────────┘
```

### Distance Privacy

"We never expose exact distances. The formatDistance function rounds to privacy-preserving buckets."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Distance Display Logic                         │
├─────────────────────────────────────────────────────────────────┤
│  < 1 km    ──▶  "Less than 1 mile away"                        │
│  < 5 km    ──▶  "About 2 miles away"                           │
│  < 10 km   ──▶  "About 5 miles away"                           │
│  < 25 km   ──▶  "About 15 miles away"                          │
│  < 50 km   ──▶  "About 30 miles away"                          │
│  >= 50 km  ──▶  "More than 50 miles away"                      │
└─────────────────────────────────────────────────────────────────┘
```

### PostGIS Fallback Query

When Elasticsearch is unavailable, fall back to PostgreSQL with PostGIS:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PostGIS Fallback Query                        │
├─────────────────────────────────────────────────────────────────┤
│  WITH user_prefs AS (                                            │
│    SELECT location, show_me, age_min, age_max, distance_km...   │
│    FROM users WHERE id = $1                                      │
│  )                                                               │
│  SELECT candidates WHERE:                                        │
│    - id != self                                                  │
│    - is_active = true                                            │
│    - gender matches preferences                                  │
│    - mutual interest (my gender in their show_me)               │
│    - age in range                                                │
│    - ST_DWithin(location, user_location, distance_km * 1000)    │
│    - id NOT IN (previously swiped)                              │
│  ORDER BY ST_Distance(location, user_location)                  │
│  LIMIT 50                                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Location Update with Fuzzing

"We add random noise to stored locations for privacy. Up to 1km offset prevents exact location inference."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Location Update Flow                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Receive lat/lon from client                                  │
│  2. Apply random offset (up to 1km):                            │
│     - Random angle: 0 to 2π                                     │
│     - Random distance: 0 to maxOffsetMeters                     │
│     - Convert to lat/lon delta                                  │
│  3. Update PostgreSQL with fuzzed location                      │
│  4. Update Redis cache with 1-hour TTL                          │
│  5. Update Elasticsearch index                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Swipe Processing & Match Detection (8 minutes)

### Swipe Service Architecture

"The swipe service processes 17K swipes/second. We use Redis for hot path operations (O(1) lookups) and async persistence to PostgreSQL."

```
┌─────────────────────────────────────────────────────────────────┐
│                    Swipe Processing Flow                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Check idempotency key (Redis GET)                           │
│     └──▶ If exists, return cached result                        │
│                                                                  │
│  2. Check rate limit (50 per 15 min)                            │
│     └──▶ If exceeded, throw RateLimitError                      │
│                                                                  │
│  3. Execute Redis pipeline (atomic):                            │
│     ┌───────────────────────────────────────────────────────┐   │
│     │ SADD swipes:{swiper}:seen {swiped}                    │   │
│     │ EXPIRE swipes:{swiper}:seen 86400                     │   │
│     │ if LIKE:                                              │   │
│     │   SADD swipes:{swiper}:liked {swiped}                 │   │
│     │   ZADD likes:received:{swiped} {timestamp} {swiper}   │   │
│     │   SISMEMBER swipes:{swiped}:liked {swiper}  ◀── match?│   │
│     │ if PASS:                                              │   │
│     │   SADD swipes:{swiper}:passed {swiped}                │   │
│     │ INCR ratelimit:swipes:{swiper}                        │   │
│     └───────────────────────────────────────────────────────┘   │
│                                                                  │
│  4. Persist to PostgreSQL (async)                               │
│                                                                  │
│  5. If mutual like detected:                                    │
│     └──▶ createMatch()                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Match Creation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Match Creation Flow                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Order user IDs (user1_id < user2_id for uniqueness)         │
│                                                                  │
│  2. INSERT INTO matches ... ON CONFLICT DO NOTHING              │
│     └──▶ Handles concurrent swipe race condition                │
│                                                                  │
│  3. If row created:                                              │
│     └──▶ Notify both users via Redis Pub/Sub:                   │
│         PUBLISH user:{user1_id}:events {match event}            │
│         PUBLISH user:{user2_id}:events {match event}            │
│                                                                  │
│  4. Return match info in response                                │
└─────────────────────────────────────────────────────────────────┘
```

### Bloom Filter Optimization

"For users with high swipe volume, we can use bloom filters to reduce Redis memory usage for the seen set."

```
┌─────────────────────────────────────────────────────────────────┐
│                   Bloom Filter Strategy                          │
├─────────────────────────────────────────────────────────────────┤
│  bloom:seen:{user_id} - Bitmap in Redis                         │
│  Size: 10,000 bits per user                                     │
│  Hash functions: 7 (MurmurHash variants)                        │
├─────────────────────────────────────────────────────────────────┤
│  hasSeenUser():                                                  │
│    - Compute 7 hash indices                                      │
│    - Check all bits with GETBIT                                 │
│    - Return true only if ALL bits set                           │
├─────────────────────────────────────────────────────────────────┤
│  markAsSeen():                                                   │
│    - Compute 7 hash indices                                      │
│    - Set all bits with SETBIT pipeline                          │
│    - Set 7-day TTL                                              │
├─────────────────────────────────────────────────────────────────┤
│  Trade-off: ~1% false positive rate saves 90%+ memory           │
│  False positives = user not shown, acceptable for discovery     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Deep Dive: Real-Time Messaging (5 minutes)

### WebSocket Gateway Architecture

"The messaging gateway uses Redis Pub/Sub for cross-server message delivery, enabling horizontal scaling of WebSocket servers."

```
┌─────────────────────────────────────────────────────────────────┐
│                  MessagingGateway Class                          │
├─────────────────────────────────────────────────────────────────┤
│  connections: Map<userId, WebSocket>                             │
│  subscriber: Redis (duplicate client for pub/sub)               │
├─────────────────────────────────────────────────────────────────┤
│  initialize():                                                   │
│    - Subscribe to pattern: user:*:events                        │
│    - On message: extract userId, deliver to local connection    │
├─────────────────────────────────────────────────────────────────┤
│  handleConnection(ws, userId):                                   │
│    - Store in connections Map                                    │
│    - Update presence in Redis HASH                              │
│    - Register message/close handlers                            │
└─────────────────────────────────────────────────────────────────┘
```

### Message Flow

```
┌─────────┐    WebSocket    ┌─────────────┐
│ Sender  │ ──────────────▶ │  Gateway A  │
└─────────┘                 └──────┬──────┘
                                   │
                    1. Verify match│exists
                    2. Store in DB │
                    3. Publish to  │Redis
                                   ▼
                           ┌─────────────┐
                           │ Redis PubSub│
                           │user:{id}:evt│
                           └──────┬──────┘
                                  │
                    All gateways  │receive
                                  ▼
┌─────────┐    WebSocket    ┌─────────────┐
│Receiver │ ◀────────────── │  Gateway B  │
└─────────┘                 └─────────────┘
```

### Message Handler Logic

```
┌─────────────────────────────────────────────────────────────────┐
│                   Message Type Handlers                          │
├─────────────────────────────────────────────────────────────────┤
│  'chat_message':                                                 │
│    1. Verify sender is part of match                            │
│    2. INSERT into messages table                                │
│    3. PUBLISH to recipient's event channel                      │
├─────────────────────────────────────────────────────────────────┤
│  'typing':                                                       │
│    - PUBLISH typing indicator to recipient                      │
├─────────────────────────────────────────────────────────────────┤
│  'read_receipt':                                                 │
│    - UPDATE messages SET read_at = NOW()                        │
│    - PUBLISH read confirmation to sender                        │
└─────────────────────────────────────────────────────────────────┘
```

### Message Pagination

```
┌─────────────────────────────────────────────────────────────────┐
│               GET /api/matches/:matchId/messages                 │
├─────────────────────────────────────────────────────────────────┤
│  Cursor-based pagination:                                        │
│    - cursor: ISO timestamp of oldest message in current page    │
│    - limit: default 50                                           │
├─────────────────────────────────────────────────────────────────┤
│  Query: WHERE match_id = $1 AND created_at < cursor             │
│  ORDER BY created_at DESC                                        │
│  LIMIT limit + 1 (to detect hasMore)                            │
├─────────────────────────────────────────────────────────────────┤
│  Response: messages (reversed for chronological order)           │
│  next_cursor: oldest message timestamp if hasMore               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Reliability & Scaling (5 minutes)

### Rate Limiting

```
┌─────────────────────────────────────────────────────────────────┐
│                    Rate Limit Configuration                      │
├─────────────────────────────────────────────────────────────────┤
│  swipes:     50 per 15 minutes                                   │
│  superLikes:  5 per day                                         │
│  messages:  100 per minute                                       │
├─────────────────────────────────────────────────────────────────┤
│  Implementation: Redis INCR with EXPIRE                         │
│  Response includes: allowed, remaining, reset_at                │
└─────────────────────────────────────────────────────────────────┘
```

### Data Retention Policy

```
┌─────────────────────────────────────────────────────────────────┐
│                   Retention Schedule                             │
├─────────────────────────────────────────────────────────────────┤
│  Swipes:              30 days                                    │
│  Unmatched messages:  365 days after unmatch                    │
│  Unmatched matches:   365 days after unmatch                    │
│  Inactive users (ES): 90 days of inactivity                     │
├─────────────────────────────────────────────────────────────────┤
│  Scheduled job runs daily via background worker                 │
│  Uses batched DELETEs to avoid lock contention                  │
└─────────────────────────────────────────────────────────────────┘
```

### Horizontal Scaling Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Load Balancer                                 │
│              (Geographic + Session Sticky)                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │  API 1  │    │  API 2  │    │  API 3  │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └────┬────┘    └────┬────┘    └────┬────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────────────────────────────────┐
    │         Redis Cluster               │
    │    (Pub/Sub across regions)         │
    └─────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │   ES    │    │   ES    │    │   ES    │
    │ (US-W)  │    │ (US-E)  │    │  (EU)   │
    └─────────┘    └─────────┘    └─────────┘
         │              │              │
         └──────────────┼──────────────┘
                        ▼
              ┌─────────────────┐
              │   PostgreSQL    │
              │  Primary + Read │
              │    Replicas     │
              └─────────────────┘
```

---

## 9. Trade-offs and Alternatives (2 minutes)

| Decision | Choice | Trade-off |
|----------|--------|-----------|
| Geo Search | Elasticsearch primary | Better performance, but added complexity |
| Swipe Storage | Redis Sets with TTL | Fast O(1) lookup, but eventual consistency with DB |
| Match Detection | Synchronous on swipe | Immediate feedback, but adds latency |
| Location Privacy | 1km fuzzing | Privacy protection, but less accurate distances |
| Message Storage | PostgreSQL | ACID guarantees, but scales less than NoSQL |

### Alternative Approaches

| Alternative | When to Consider |
|-------------|------------------|
| Cassandra for Messages | Better write throughput at 10x scale |
| Graph Database | Friend-of-friend discovery features |
| Redis Streams | Better event replay than Pub/Sub |
| S3 + CDN for Photos | Global photo delivery at scale |

---

## 10. Summary

This backend architecture handles Tinder's core requirements:

1. **Geospatial Discovery**: Elasticsearch with PostGIS fallback for finding nearby users
2. **Fast Swipe Processing**: Redis Sets for O(1) seen/liked checks with 24h TTL
3. **Real-Time Matching**: Immediate detection on every like with Redis
4. **Scalable Messaging**: WebSocket with Redis Pub/Sub for cross-server delivery
5. **Privacy First**: Location fuzzing and distance abstraction
6. **Reliability**: Idempotency keys, rate limiting, and data retention policies

The system scales horizontally with geographic load balancing and maintains consistency through PostgreSQL as the source of truth with Redis for hot data.
