# Strava - Fitness Tracking - Architecture Design

## System Overview

A fitness tracking and social platform for athletes that records GPS-based activities, enables social features among athletes, and provides segment-based leaderboards. The core challenges are efficient GPS data storage at scale, real-time segment matching against thousands of predefined routes, leaderboard computation with O(log N) updates, and fan-out-on-write feed generation for social features.

## Requirements

### Functional Requirements

- **Activity Recording** - Record GPS-based activities (running, cycling, hiking) with detailed metrics (distance, elevation, speed, heart rate)
- **Route Visualization** - Display activities on maps with polyline-encoded route overlays
- **Segment Matching** - Automatically detect when activities traverse predefined route segments
- **Leaderboards** - Rank athletes on segments by elapsed time with personal record tracking
- **Social Features** - Follow athletes, personalized activity feed, kudos, comments
- **Statistics** - Track personal stats, achievements, and fitness milestones

### Non-Functional Requirements

- **Reliability**: Never lose uploaded activity data; 99.99% uptime for activity uploads
- **Latency**: Activity upload and processing (including segment matching) under 30 seconds; p99 API response < 200ms
- **Scale**: 10M registered users, 5M activities/day, 50B GPS points/year
- **Accuracy**: Segment matching within 25m GPS tolerance for fair competition
- **Storage**: Efficient tiered storage for GPS data (hot/warm/cold)

### Out of Scope

- Training plans and coaching features
- Paid subscription tiers
- Partner device integrations (Garmin, Wahoo, etc.)
- Real-time live tracking during activities

## Capacity Estimation

### Production Scale

**Activity volume:**
- 5 million activities per day
- Average activity: 5,000 GPS points x 50 bytes = 250 KB
- Daily GPS ingestion: 5M x 250KB = 1.25 TB/day
- Annual GPS storage: ~450 TB (before downsampling)

**Leaderboard operations:**
- 1M segments with active leaderboards
- Each activity matches ~5 segments on average = 25M segment effort inserts/day
- Leaderboard reads: 50M/day (segment page views)

**Social operations:**
- Average user follows 100 athletes
- 5M activities/day x 100 followers = 500M feed fan-out writes/day
- Feed reads: 20M/day

### Local Development Scale

- 100-1,000 registered users
- 10-100 activities per day
- 1,000-10,000 GPS points per activity
- 10-100 segments
- Storage: ~5 MB GPS data/day

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │  Mobile App  │  │   Web App    │  │ Device Sync  │                  │
│  │  (iOS/Android)│  │ (React SPA) │  │ (Garmin/etc) │                  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
└─────────┼─────────────────┼─────────────────┼──────────────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                   ┌────────▼────────┐
                   │   API Gateway   │
                   │  (Rate Limit,   │
                   │   Auth, TLS)    │
                   └────────┬────────┘
                            │
         ┌──────────────────┼──────────────────────┐
         │                  │                      │
┌────────▼────────┐ ┌───────▼────────┐ ┌───────────▼──────────┐
│ Activity Service│ │ Social Service │ │ Segment Service      │
│                 │ │                │ │                      │
│ - Upload/Parse  │ │ - Follow/Feed │ │ - Matching (2-phase) │
│ - GPX parsing   │ │ - Kudos       │ │ - Leaderboards       │
│ - Metrics calc  │ │ - Comments    │ │ - PR tracking        │
│ - Idempotency   │ │ - Fan-out     │ │ - Achievement check  │
└────────┬────────┘ └───────┬────────┘ └───────────┬──────────┘
         │                  │                      │
         └──────────────────┼──────────────────────┘
                            │
         ┌──────────────────┼──────────────────────┐
         │                  │                      │
┌────────▼────────┐ ┌───────▼────────┐ ┌───────────▼──────────┐
│   PostgreSQL    │ │    Redis       │ │      Kafka           │
│   + PostGIS     │ │    Cluster     │ │                      │
│                 │ │                │ │ - Activity events    │
│ - Users         │ │ - Sessions    │ │ - Feed fan-out       │
│ - Activities    │ │ - Leaderboards│ │ - Segment matching   │
│ - GPS Points    │ │ - Feed cache  │ │ - Achievement checks │
│ - Segments      │ │ - User cache  │ │                      │
│ - Efforts       │ │ - Idempotency │ │                      │
└─────────────────┘ └───────────────┘ └──────────────────────┘
```

### Core Components

1. **Activity Service** - Handles GPX file uploads, parses GPS tracks, calculates metrics (distance, elevation gain, calories, speed), and stores both encoded polylines (for display) and raw GPS points (for segment matching). Uses idempotency to prevent duplicate uploads from flaky device sync.

2. **Segment Matcher** - Two-phase matching algorithm: Phase 1 uses bounding box intersection to eliminate 99% of segments (O(1) per segment via spatial index). Phase 2 compares GPS points within 25m tolerance using Haversine distance. Runs asynchronously after activity creation.

3. **Leaderboard Service** - Redis sorted sets where score = elapsed time (lower is better). O(log N) insertions, O(1) rank lookups, O(k) for top-k queries. Personal records stored separately for quick PR detection.

4. **Feed Generator** - Fan-out on write: when an activity is created, it is pushed to all followers' feed sorted sets in Redis. Feed reads are O(k) retrievals. Works well for typical follower counts (<1,000); would need hybrid (fan-out on read for celebrity athletes) at scale.

5. **Achievement Service** - Checks milestone criteria after each activity (distance totals, activity counts, segment completions). Criteria are table-driven (`criteria_type` + `criteria_value`) for easy addition without schema changes.

## Database Schema

### Entity-Relationship Overview

```
                                    ┌──────────────────┐
                                    │   achievements   │
                                    │                  │
                                    │ - id             │
                                    │ - name           │
                                    │ - criteria_type  │
                                    │ - criteria_value │
                                    └────────┬─────────┘
                                             │
                                             │ 1:N
                                             │
┌──────────────┐                    ┌────────▼─────────┐                    ┌──────────────┐
│   follows    │◄───────────────────┤      users       ├───────────────────►│privacy_zones │
│              │  1:N               │                  │  1:N               │              │
│ - follower_id│  (as follower)     │ - id (UUID)      │                    │ - id         │
│ - following_id                    │ - username       │                    │ - user_id    │
│ - created_at │  1:N               │ - email          │                    │ - center_lat │
│              │◄─────(as following)│ - password_hash  │                    │ - center_lng │
└──────────────┘                    │ - role           │                    │ - radius     │
                                    └─────────┬────────┘                    └──────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │ 1:N                     │ 1:N                     │ 1:N
                    ▼                         ▼                         ▼
           ┌────────────────┐        ┌────────────────┐        ┌────────────────┐
           │  activities    │        │   segments     │        │user_achievements│
           │                │        │                │        │                │
           │ - id           │        │ - id           │        │ - user_id      │
           │ - user_id      │        │ - creator_id   │        │ - achievement_id│
           │ - type         │        │ - name         │        │ - earned_at    │
           │ - start_time   │        │ - activity_type│        └────────────────┘
           │ - distance     │        │ - distance     │
           │ - polyline     │        │ - polyline     │
           │ - kudos_count  │        │ - bbox coords  │
           └───────┬────────┘        └────────┬───────┘
                   │                          │
     ┌─────────────┼─────────────┐            │
     │ 1:N         │ 1:N         │ 1:N        │
     ▼             ▼             ▼            │
┌──────────┐ ┌──────────┐ ┌──────────┐        │
│gps_points│ │  kudos   │ │ comments │        │
│          │ │          │ │          │        │
│- id      │ │-activity_│ │- id      │        │
│-activity_│ │  id      │ │-activity_│        │
│  id      │ │- user_id │ │  id      │        │
│- lat/lng │ │          │ │- user_id │        │
│- altitude│ └──────────┘ │- content │        │
│- speed   │              └──────────┘        │
└──────────┘                                  │
                                              │
                              ┌───────────────┴───────────────┐
                              │       segment_efforts         │
                              │                               │
                              │ - id                          │
                              │ - segment_id (FK)             │
                              │ - activity_id (FK)            │
                              │ - user_id (FK)                │
                              │ - elapsed_time                │
                              │ - pr_rank                     │
                              └───────────────────────────────┘
```

### Complete PostgreSQL Schema

```sql
-- Users: Central entity for all athletes
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    profile_photo   VARCHAR(512),
    weight_kg       DECIMAL(5,2),
    bio             TEXT,
    location        VARCHAR(255),
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- Following relationships: Directed social graph
CREATE TABLE follows (
    follower_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    following_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- Activities: Core workout records
CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL,           -- 'run', 'ride', 'hike', 'walk'
    name            VARCHAR(255),
    description     TEXT,
    start_time      TIMESTAMP NOT NULL,
    elapsed_time    INTEGER NOT NULL,               -- Total time (seconds)
    moving_time     INTEGER NOT NULL,               -- Time moving (seconds)
    distance        DECIMAL(12,2),                  -- Distance (meters)
    elevation_gain  DECIMAL(8,2),                   -- Climbing (meters)
    calories        INTEGER,
    avg_heart_rate  INTEGER,
    max_heart_rate  INTEGER,
    avg_speed       DECIMAL(8,2),                   -- m/s
    max_speed       DECIMAL(8,2),                   -- m/s
    privacy         VARCHAR(20) DEFAULT 'followers',
    polyline        TEXT,                           -- Encoded route for display
    start_lat       DECIMAL(10,7),
    start_lng       DECIMAL(10,7),
    end_lat         DECIMAL(10,7),
    end_lng         DECIMAL(10,7),
    kudos_count     INTEGER DEFAULT 0,             -- Denormalized
    comment_count   INTEGER DEFAULT 0,             -- Denormalized
    created_at      TIMESTAMP DEFAULT NOW()
);

-- GPS Points: Detailed route data (largest table)
CREATE TABLE gps_points (
    id              SERIAL PRIMARY KEY,
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    point_index     INTEGER NOT NULL,
    timestamp       TIMESTAMP,
    latitude        DECIMAL(10,7) NOT NULL,
    longitude       DECIMAL(10,7) NOT NULL,
    altitude        DECIMAL(8,2),
    speed           DECIMAL(8,2),
    heart_rate      INTEGER,
    cadence         INTEGER,
    power           INTEGER
);

CREATE INDEX idx_gps_points_activity ON gps_points(activity_id, point_index);

-- Segments: Predefined route sections for competition
CREATE TABLE segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    activity_type   VARCHAR(20) NOT NULL,
    distance        DECIMAL(12,2) NOT NULL,
    elevation_gain  DECIMAL(8,2),
    polyline        TEXT NOT NULL,
    start_lat       DECIMAL(10,7) NOT NULL,
    start_lng       DECIMAL(10,7) NOT NULL,
    end_lat         DECIMAL(10,7) NOT NULL,
    end_lng         DECIMAL(10,7) NOT NULL,
    min_lat         DECIMAL(10,7) NOT NULL,         -- Bounding box
    min_lng         DECIMAL(10,7) NOT NULL,
    max_lat         DECIMAL(10,7) NOT NULL,
    max_lng         DECIMAL(10,7) NOT NULL,
    effort_count    INTEGER DEFAULT 0,
    athlete_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);
CREATE INDEX idx_segments_type ON segments(activity_type);

-- Segment Efforts: Records of segment completions
CREATE TABLE segment_efforts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id      UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_time    INTEGER NOT NULL,
    moving_time     INTEGER NOT NULL,
    start_index     INTEGER,
    end_index       INTEGER,
    avg_speed       DECIMAL(8,2),
    max_speed       DECIMAL(8,2),
    pr_rank         INTEGER,                       -- 1, 2, or 3
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_segment_efforts_segment ON segment_efforts(segment_id, elapsed_time);
CREATE INDEX idx_segment_efforts_user ON segment_efforts(user_id, segment_id);

-- Privacy Zones: Hide GPS data near sensitive locations
CREATE TABLE privacy_zones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100),
    center_lat      DECIMAL(10,7) NOT NULL,
    center_lng      DECIMAL(10,7) NOT NULL,
    radius_meters   INTEGER NOT NULL DEFAULT 500,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Kudos: Activity "likes" (composite PK prevents duplicates)
CREATE TABLE kudos (
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (activity_id, user_id)
);

-- Comments: Discussion on activities
CREATE TABLE comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content         TEXT NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Achievements: Badge definitions
CREATE TABLE achievements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon            VARCHAR(50),
    criteria_type   VARCHAR(50) NOT NULL,
    criteria_value  INTEGER NOT NULL
);

-- User Achievements: Earned badges
CREATE TABLE user_achievements (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id  UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at       TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);
```

### Index Strategy

| Index Name | Table | Columns | Purpose |
|-----------|-------|---------|---------|
| idx_gps_points_activity | gps_points | (activity_id, point_index) | Fast GPS track retrieval in order |
| idx_segments_bbox | segments | (min_lat, max_lat, min_lng, max_lng) | Phase 1 segment matching (bounding box) |
| idx_segments_type | segments | (activity_type) | Filter segments by run/ride |
| idx_segment_efforts_segment | segment_efforts | (segment_id, elapsed_time) | Leaderboard sorting without filesort |
| idx_segment_efforts_user | segment_efforts | (user_id, segment_id) | Personal record lookups |

### Foreign Key Cascade Behaviors

All child tables use `ON DELETE CASCADE` from their parent. When a user is deleted, all their activities, GPS points, segment efforts, follows, kudos, comments, and achievements are removed automatically. When an activity is deleted, its GPS points, segment efforts, kudos, and comments are removed. This is appropriate for a fitness platform where user data has no regulatory retention requirement beyond the user's account lifetime.

### Redis Data Structures

```
# Leaderboards (sorted sets - lower time = better)
leaderboard:{segment_id}      -> ZSET { user_id: elapsed_time }

# Personal Records
pr:{user_id}:{segment_id}     -> best_elapsed_time (STRING)

# Activity Feeds (sorted sets - score = timestamp)
feed:{user_id}                -> ZSET { activity_id: timestamp }

# Sessions
sess:{session_id}             -> JSON { userId, username, role }

# Idempotency keys for activity uploads
idem:activity:{sha256_hash}   -> JSON { activity_id, name, type, cached_at }
```

### Data Flow Between Tables

**Activity Upload Flow:**
```
1. User uploads GPX file
   └──▶ activities row created (metrics calculated)
       └──▶ gps_points rows inserted (1,000-50,000 points)
           └──▶ Segment matching triggered (async)
               ├──▶ Query segments by bounding box intersection
               └──▶ For each matching segment:
                   └──▶ segment_efforts row created
                       ├──▶ segments.effort_count incremented
                       ├──▶ Redis leaderboard ZADD
                       └──▶ Achievement check triggered
                           └──▶ user_achievements row (if earned)
```

**Feed Generation Flow:**
```
1. Activity created
   └──▶ Query follows WHERE following_id = activity.user_id
       └──▶ For each follower:
           └──▶ ZADD feed:{follower_id} timestamp activity_id
               └──▶ ZREMRANGEBYRANK to cap at 1,000 entries
```

### Storage Estimation

| Table | Row Size (avg) | Growth Per Active User/Year | Largest Tables |
|-------|---------------|----------------------------|----------------|
| gps_points | 50 bytes | 500K rows | Dominant (>90% of storage) |
| activities | 500 bytes | 100 rows | Moderate |
| segment_efforts | 100 bytes | 500 rows | Moderate |
| follows | 50 bytes | 100 rows | Small |
| kudos | 50 bytes | 1,000 rows | Small |

At 10K active users after 1 year: gps_points = ~25 GB, everything else combined < 200 MB.

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/logout` | Logout (destroy session) |
| GET | `/api/auth/me` | Get current user |

### Activities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/activities` | List activities (paginated) |
| GET | `/api/activities/:id` | Get activity details |
| GET | `/api/activities/:id/gps` | Get GPS points |
| POST | `/api/activities/upload` | Upload GPX file (idempotent) |
| POST | `/api/activities/simulate` | Create simulated activity |
| POST | `/api/activities/:id/kudos` | Give kudos |
| DELETE | `/api/activities/:id/kudos` | Remove kudos |
| POST | `/api/activities/:id/comments` | Add comment |

### Segments

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/segments` | List segments with search |
| GET | `/api/segments/:id` | Get segment with leaderboard |
| GET | `/api/segments/:id/leaderboard` | Get full leaderboard |
| POST | `/api/segments` | Create segment from activity GPS track |

### Users & Social

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users/:id` | Get user profile with stats |
| POST | `/api/users/:id/follow` | Follow user |
| DELETE | `/api/users/:id/follow` | Unfollow user |
| GET | `/api/feed` | Get personalized feed |
| GET | `/api/feed/explore` | Get public activities |

## Key Design Decisions

### 1. GPS Data Storage: PostgreSQL vs Cassandra/TimescaleDB

**Chosen: PostgreSQL with indexed tables (production would use Cassandra or TimescaleDB).** GPS points are write-heavy (5M activities x 5K points = 25B inserts/day at production scale) and read-once (loaded for segment matching during upload, then rarely accessed again). Cassandra's wide-column model with activity_id as partition key would provide O(1) partition lookups and linear scaling. PostgreSQL with `(activity_id, point_index)` composite index works well for the learning project but would hit write throughput limits at ~50K inserts/second on a single instance.

**Trade-off acknowledged:** PostgreSQL keeps all GPS data in a single table, which grows to 25 GB at modest scale. Production would partition by time and archive old data. The polyline column on activities stores the pre-encoded route separately, so most read operations (map display, feed rendering) never touch the gps_points table.

### 2. Segment Matching: Two-Phase Algorithm

**Chosen: Bounding box filter + GPS point comparison.** Phase 1 uses simple range queries against the segment's bounding box (`min_lat <= activity_max_lat AND max_lat >= activity_min_lat`), which runs against a B-tree index and eliminates 99% of segments without geometric computation. Phase 2 iterates through GPS points using Haversine distance with a 25m threshold, which is computationally expensive but only runs on the few candidate segments that survive Phase 1.

**Trade-off acknowledged:** The 25m threshold is tuned for road cycling where GPS drift is minimal. Trail running with tree canopy cover may need a looser threshold (50m), but this increases false positives. An alternative approach using Frechet distance would handle path similarity better but is O(n*m) vs our O(n) sequential scan, making it impractical for real-time matching.

### 3. Leaderboard: Redis Sorted Sets vs PostgreSQL ORDER BY

**Chosen: Redis sorted sets with elapsed_time as score.** Popular segments may have 100K+ efforts. PostgreSQL `ORDER BY elapsed_time LIMIT 10` is O(N log N) even with an index because it must scan the index to find the top entries. Redis ZRANGE is O(log N + k) where k is the result size. More importantly, ZRANK provides O(log N) rank lookups -- athletes checking "where do I rank?" is the most common leaderboard query, and it must be fast.

**Trade-off acknowledged:** Redis leaderboards are volatile. If Redis crashes, all leaderboards must be rebuilt from PostgreSQL segment_efforts data. The rebuild script queries `SELECT segment_id, user_id, MIN(elapsed_time) FROM segment_efforts GROUP BY segment_id, user_id` and re-populates Redis. This takes minutes for large datasets but is acceptable as a recovery procedure.

### 4. Activity Feed: Fan-Out on Write vs Fan-Out on Read

**Chosen: Fan-out on write.** When an athlete uploads an activity, it is immediately pushed to all followers' feed sorted sets in Redis. This trades write amplification (100 followers = 100 Redis ZADD operations) for read simplicity (feed page load = single ZREVRANGE). Most athletes have <1,000 followers, making the fan-out manageable.

**Trade-off acknowledged:** Celebrity athletes with 100K+ followers would create massive write amplification. Production would use a hybrid approach: fan-out on write for normal athletes (<10K followers), fan-out on read for celebrities (merge their activities at read time). The current implementation uses a `maxFanoutFollowers` config (1,000) to cap fan-out, though the fallback path is not yet implemented.

## Consistency and Idempotency

### Idempotency for Activity Uploads

GPS devices frequently retry uploads due to network timeouts, user impatience, firmware bugs, or app crashes. Without idempotency, retries create duplicate activities, corrupt statistics, and double-count segment efforts.

The idempotency service uses a two-layer approach:

1. **Content-based hashing**: SHA-256 of `userId + GPX content + start timestamp` creates a unique fingerprint. Same GPX uploaded twice produces the same hash.
2. **Client-provided keys**: The `X-Idempotency-Key` header enables mobile apps to generate their own upload IDs, returning the original response on retry.

Keys are stored in Redis with 24h TTL. Duplicate detection returns 200 OK (not 409 Conflict) because the client's goal was achieved.

### Consistency Model

| Entity | Consistency | Rationale |
|--------|-------------|-----------|
| Activities + GPS points | Strong (PostgreSQL transaction) | Upload must be atomic; partial GPS data is useless |
| Segment efforts | Strong (write after matching) | Must be consistent with leaderboard |
| Leaderboards | Eventual (Redis, seconds lag) | Acceptable; athletes tolerate brief stale rankings |
| Activity feeds | Eventual (fan-out delay) | Feed staleness of seconds is imperceptible |
| Kudos/comments counts | Eventual (denormalized) | Counter slightly behind actual count is fine |

## Security

- **Authentication**: Session-based with HttpOnly cookies, Redis-backed sessions (24h TTL)
- **Password Storage**: bcrypt hashing
- **Sensitive Field Redaction**: Pino logger redacts password, sessionId, cookie, authorization headers
- **CORS**: Restricted to known frontend origins
- **Input Validation**: Parameterized queries for all database operations
- **Privacy Zones**: GPS points within radius of user-defined zones are excluded from public views

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Purpose |
|--------|------|---------|
| `strava_activity_uploads_total` | Counter | Upload rate by type and status |
| `strava_activity_upload_duration_seconds` | Histogram | Upload processing time (parsing + storage) |
| `strava_activity_gps_points_total` | Counter | GPS data ingestion volume |
| `strava_activity_idempotency_hits_total` | Counter | Duplicate upload detection rate |
| `strava_segment_match_duration_seconds` | Histogram | Segment matching latency |
| `strava_segment_matches_total` | Counter | Segment effort creation rate |
| `strava_leaderboard_updates_total` | Counter | PR and podium frequency |
| `strava_leaderboard_query_duration_seconds` | Histogram | Redis leaderboard query speed |
| `strava_feed_fanout_duration_seconds` | Histogram | Fan-out write time by follower count |
| `strava_feed_cache_hits_total` | Counter | Feed cache effectiveness |
| `http_request_duration_seconds` | Histogram | API latency by route |
| `strava_db_query_duration_seconds` | Histogram | Database query performance |
| `strava_redis_connected` | Gauge | Redis connection health |

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /health` | Kubernetes liveness | Process running, uptime, memory |
| `GET /health/ready` | Kubernetes readiness | PostgreSQL connected, Redis connected |
| `GET /health/detailed` | Debugging/ops | Connection pools, memory, latency per dependency |

### Structured Logging

Pino JSON logging with component-specific child loggers (activity, segment, leaderboard, feed, database, redis, auth, lifecycle). Request-scoped loggers carry correlation IDs via `X-Request-Id` header. Sensitive fields (password, session, cookie) are automatically redacted.

## Failure Handling

### Graceful Degradation

| Failure | Degradation |
|---------|-------------|
| Redis down | Activities still save to PostgreSQL; feeds reconstruct on recovery; leaderboards unavailable until rebuilt |
| PostgreSQL down | All writes fail; cached data (sessions, feeds) still served from Redis |
| Segment matching timeout | Activity saved successfully; segment matching retried in background |
| Idempotency Redis check fails | Allow upload to proceed (better potential duplicate than blocked upload) |

### Recovery Procedures

**Redis cache loss:**
1. Rebuild leaderboards: `SELECT segment_id, user_id, MIN(elapsed_time) FROM segment_efforts GROUP BY segment_id, user_id` -> ZADD to sorted sets
2. Rebuild feeds: For each user, query followed users' activities from last 30 days -> ZADD to feed sorted set

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless, behind load balancer. Session data in Redis enables any server to handle any request
2. **GPS data**: Move to Cassandra/TimescaleDB with activity_id as partition key for write scaling
3. **Segment matching**: Offload to background workers via Kafka/RabbitMQ; decouple from upload request
4. **Read replicas**: PostgreSQL replicas for activity listing, profile views, segment browsing
5. **CDN**: Cache map tiles, profile photos, and encoded polylines
6. **Feed optimization**: Hybrid fan-out (write for normal users, read for celebrities)

### Data Lifecycle

| Data Type | Hot Storage | Warm/Archive | Deletion |
|-----------|-------------|--------------|----------|
| Activities | Indefinite | N/A | Manual by user |
| GPS Points (full resolution) | 1 year | Downsample to every 5th point (80% reduction) | Keep downsampled indefinitely |
| Segment Efforts | 2 years | Archive to cold storage | After 5 years |
| Activity Feeds | 30 days (Redis ZSET) | N/A | Auto-expire; reconstructible from DB |
| Sessions | 24 hours (Redis TTL) | N/A | Auto-expire |
| Leaderboards | Indefinite (Redis) | N/A | Rebuild from DB if lost |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| GPS storage | PostgreSQL + indexed tables | Cassandra / TimescaleDB | Sufficient for learning scale; Cassandra for production write throughput |
| Segment matching | Two-phase (bbox + GPS) | PostGIS spatial queries / Frechet distance | 99% filter in Phase 1; Phase 2 is O(n) vs O(n*m) for Frechet |
| Leaderboards | Redis sorted sets | PostgreSQL ORDER BY | O(log N) rank lookup vs O(N log N) query; critical for per-user rank checks |
| Activity feeds | Fan-out on write | Fan-out on read / hybrid | Fast reads; write amplification manageable for <1K followers |
| Idempotency | Redis with content hashing | PostgreSQL idempotency table | Faster checks; Redis TTL handles cleanup; graceful fallback on Redis failure |
| Polyline encoding | Store on activity row | Compute from GPS points on read | 10x compression; avoids loading 5K GPS points for map display |

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Setup Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    localhost                                       │
│                                                                   │
│  ┌──────────────┐    HTTP     ┌──────────────────────────────┐   │
│  │   Frontend   │ ──────────▶ │      Backend (Express)       │   │
│  │  Vite + React│             │        Port 3000             │   │
│  │  Port 5173   │             │                              │   │
│  │              │             │  ┌──────────┐ ┌───────────┐  │   │
│  │  - Upload    │             │  │  Auth    │ │  Activity  │  │   │
│  │  - Map view  │             │  │  Routes  │ │  Routes    │  │   │
│  │    (Leaflet) │             │  ├──────────┤ ├───────────┤  │   │
│  │  - Feed      │             │  │ Segment  │ │  Social    │  │   │
│  │  - Profile   │             │  │  Routes  │ │  Routes    │  │   │
│  │  - Segments  │             │  ├──────────┤ ├───────────┤  │   │
│  │  - Stats     │             │  │  User    │ │ Feed/Stats │  │   │
│  │              │             │  │  Routes  │ │  Routes    │  │   │
│  └──────────────┘             │  └──────────┘ └───────────┘  │   │
│                               └──────────┬───────────────────┘   │
│                                          │                        │
│                            ┌─────────────┴─────────────┐         │
│                            │                           │         │
│                  ┌─────────▼──────────┐         ┌──────▼──────┐  │
│                  │  PostgreSQL        │         │   Valkey    │  │
│                  │  + PostGIS         │         │  Port 6379  │  │
│                  │  Port 5432         │         │             │  │
│                  │                    │         │ - Sessions  │  │
│                  │  strava DB         │         │ - Leaders   │  │
│                  │  (10 tables)       │         │ - Feeds     │  │
│                  │                    │         │ - Idempot.  │  │
│                  └────────────────────┘         └─────────────┘  │
│                                                                   │
│  Docker: strava-postgres (postgis/postgis:16-3.4),               │
│          strava-redis (valkey:7-alpine),                          │
│          strava-kafka (optional, confluentinc/cp-kafka:7.5.0)    │
└──────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Why It Matters |
|---------|---------|-----------|----------------|
| Activity idempotency | Custom (Redis + SHA-256) | `backend/src/shared/idempotency.ts` | Two-layer dedup: content hashing + client keys; prevents duplicate activities from device sync retries |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 20+ metrics covering uploads, segment matching, leaderboards, feeds, DB, Redis, and HTTP |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with 8 component loggers, request correlation IDs, sensitive field redaction |
| Health checks | Custom 3-tier | `backend/src/shared/health.ts` | Liveness/readiness/detailed endpoints with per-component latency measurement |
| Retention config | Centralized | `backend/src/shared/config.ts` | Tiered GPS retention (1yr full, then downsample), feed TTL (30d), session TTL (24h) |
| Segment matching | Two-phase algorithm | `backend/src/services/segmentMatcher.ts` | Bounding box filter + 25m Haversine threshold; production-ready matching logic |
| Fan-out on write | Redis ZSET | `backend/src/routes/` (activity creation) | Activity pushed to all followers' feed sorted sets on upload |
| Leaderboard system | Redis sorted sets | `backend/src/routes/` (segment routes) | O(log N) insertions, O(1) rank lookups, PR tracking |
| Achievement system | Table-driven criteria | `backend/src/services/achievements.ts` | Flexible criteria_type + criteria_value pattern for milestone badges |
| Polyline encoding | polyline library | `backend/src/routes/` (activity routes) | 10x compression of GPS routes for map display |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| API Gateway (Kong/Envoy) | Express middleware | No centralized rate limiting or TLS termination |
| CDN for map tiles | Leaflet loads from OSM tile servers | Higher latency for map rendering |
| Cassandra/TimescaleDB for GPS | PostgreSQL gps_points table | Write throughput limited; single partition |
| Kafka for async segment matching | Synchronous matching during upload | Upload response includes matching time |
| Multiple microservices | Single Express process | No independent scaling of services |
| Redis Cluster | Single Valkey instance | No sharding; single point of failure |
| PostgreSQL read replicas | Single PostgreSQL instance | All reads and writes on same instance |
| Hybrid fan-out for celebrities | Pure fan-out on write | Would break with >1K followers |
| OAuth/SSO | Session-based auth with bcrypt | Simpler but no third-party auth |
| PostGIS spatial queries | Manual bounding box + Haversine | PostGIS extension is installed but spatial functions not used directly |

### What Was Omitted

- CDN and edge caching for static assets and map tiles
- Multi-region deployment and geographic partitioning
- Kubernetes orchestration and auto-scaling
- Real-time live tracking during activities (WebSocket)
- Privacy zone GPS filtering (table exists, enforcement not implemented)
- Background job queue for segment matching (runs synchronously)
- GPS route snapping to road network
- Near-duplicate activity detection (SimHash)
- Grafana dashboards (metrics exposed at `/metrics` but no visualization)
- Distributed tracing (OpenTelemetry)
- Training load and fitness/fatigue tracking
- Heat maps and aggregate route visualization

## Frontend Architecture

This section describes the React frontend implementation: component hierarchy, state management, routing, data fetching patterns, and key UI behaviors.

### Technology Stack

| Technology | Purpose |
|-----------|---------|
| React 19 + TypeScript | UI framework with type safety |
| TanStack Router | File-based routing with type-safe params |
| Zustand | Lightweight global state management with localStorage persistence |
| Leaflet + react-leaflet | Interactive map rendering with OpenStreetMap tiles |
| polyline (library) | Decoding Google-encoded polylines to lat/lng arrays |
| Tailwind CSS | Utility-first CSS with Strava-branded custom colors |
| Vite | Development server and build tool |

### Route Structure

TanStack Router file-based routing in `frontend/src/routes/`:

| File | Path | Description |
|------|------|-------------|
| `__root.tsx` | (layout) | Root layout with Navbar and auth check on mount |
| `index.tsx` | `/` | Dashboard with activity feed (personalized if logged in, explore if not) |
| `login.tsx` | `/login` | Login form |
| `register.tsx` | `/register` | Registration form |
| `upload.tsx` | `/upload` | GPX file upload and activity simulation |
| `activity.$id.tsx` | `/activity/:id` | Activity detail with map, metrics, kudos, comments, segment efforts |
| `explore.tsx` | `/explore` | Public activity discovery feed |
| `segments.tsx` | `/segments` | Segment browser with search and filtering |
| `segment.$id.tsx` | `/segment/:id` | Segment detail with leaderboard and map |
| `profile.$id.tsx` | `/profile/:id` | Athlete profile with stats, activities, achievements |
| `profile.$id.followers.tsx` | `/profile/:id/followers` | Followers list |
| `profile.$id.following.tsx` | `/profile/:id/following` | Following list |
| `stats.tsx` | `/stats` | Personal statistics dashboard with records and achievements |

### Zustand Store

The frontend uses a single Zustand store for authentication:

**`authStore.ts`** -- Athlete authentication state with `persist` middleware. Stores the user object and `isAuthenticated` flag in localStorage (via `partialize`). On app load, `checkAuth()` validates the session by calling `GET /api/auth/me`. If the session is invalid, state is cleared. The store provides `login`, `register`, `logout`, and `checkAuth` actions. Unlike many projects that persist only the token, this store persists the full user object and auth flag, so the UI renders immediately on reload without waiting for the auth check to complete.

This project does not use additional Zustand stores for activities, segments, or feed data. Instead, each route component manages its own data state via `useState` + `useEffect`, fetching data on mount. This approach is simpler for a content-consumption app where most pages load independent data that is not shared across routes.

### API Service Layer

The API client (`services/api.ts`) is organized as five domain-specific objects, each grouping related endpoints:

| Object | Purpose | Key Methods |
|--------|---------|-------------|
| `auth` | Authentication | `login`, `register`, `logout`, `me` |
| `activities` | Activity CRUD and social | `list`, `get`, `getGps`, `upload`, `simulate`, `kudos`, `removeKudos`, `addComment` |
| `feed` | Activity feeds | `get` (personalized), `explore` (public) |
| `users` | Profiles and social | `get`, `search`, `follow`, `unfollow`, `getFollowers`, `getFollowing`, `getAchievements` |
| `segments` | Segments and leaderboards | `list`, `get`, `getLeaderboard`, `getEfforts`, `create`, `delete` |
| `stats` | Personal and admin stats | `me`, `records`, `adminOverview` |

All methods use a shared `request<T>()` wrapper that handles JSON parsing, credentials (`credentials: 'include'`), and error extraction. The `upload` method is special-cased to use `FormData` instead of JSON for GPX file uploads.

### Component Hierarchy

```
__root (Navbar + Outlet)
├── Dashboard (index)
│   ├── Feed section (lg:col-span-2)
│   │   ├── Action buttons (Simulate Activity, Upload Activity)
│   │   └── ActivityCard[] (activity list with map thumbnails)
│   └── Sidebar (lg:col-span-1)
│       ├── User profile mini-card (avatar initial, username, link to stats)
│       └── Quick links (Explore Segments, Discover Activities)
├── Upload
│   ├── GPX file input (drag-and-drop styled, .gpx filter)
│   ├── Activity type selector (run, ride, hike, walk, swim)
│   ├── Name/description inputs
│   └── Submit (Upload) + Simulate button
├── ActivityDetail
│   ├── ActivityMap (Leaflet map with route polyline)
│   ├── Metrics grid (distance, time, elevation, speed, heart rate)
│   ├── Kudos button (toggle)
│   ├── Comments section
│   └── Segment efforts list (matched segments with times and PR rank)
├── Segments browser
│   ├── Search input + activity type filter
│   └── SegmentCard[] (name, distance, elevation, athlete count)
├── SegmentDetail
│   ├── Segment map (Leaflet polyline)
│   ├── LeaderboardTable (rank, athlete, time, date)
│   └── Effort history
├── Profile
│   ├── Profile header (avatar, bio, location, follow/unfollow button)
│   ├── Stats summary (activities, distance, followers, following)
│   ├── Recent activities
│   └── Achievements list
└── Stats dashboard
    ├── Activity totals by type
    ├── Personal records (longest, fastest, biggest climb)
    └── Achievement progress
```

### Key UI Patterns

**Map visualization with Leaflet**: The `ActivityMap` component is central to the Strava experience. It accepts either a pre-encoded polyline string (for performance -- 10x smaller than raw points) or an array of GPS points (for detailed views). The `polyline` library decodes the encoded string into lat/lng arrays. The component uses `useMemo` to avoid re-decoding on every render. A `FitBounds` sub-component calls `map.fitBounds()` on mount to auto-zoom to the route extent with 20px padding. Start and end markers use custom `L.divIcon` elements (green circle for start, red for finish) with CSS-styled borders and shadows. Map interactivity (scroll zoom, dragging, zoom controls) is configurable -- disabled in card thumbnails and enabled on detail pages.

**Activity simulation**: Since real GPX files are hard to come by during development, the upload page includes a "Simulate" button that calls `POST /api/activities/simulate`. This generates a random GPS track with configurable point count and activity type. The simulation result redirects to the new activity's detail page, making it easy to populate the system with test data for segment matching and feed generation.

**Conditional feed behavior**: The dashboard (index route) serves two purposes. For authenticated users, it fetches the personalized feed (`feed.get()`) showing activities from followed athletes. For unauthenticated users, it fetches the explore feed (`feed.explore()`) showing public activities. The heading changes ("Your Feed" vs "Explore Activities") and action buttons (Simulate, Upload) are conditionally rendered based on auth state.

**Strava-branded theming**: The frontend uses custom Tailwind colors (`strava-orange`, `strava-orange-dark`, `strava-gray-*`) to match Strava's visual identity. These are defined in the Tailwind config and used throughout for buttons, headers, and accent colors.

**Activity-type color coding**: The `getActivityColor()` utility function (`utils/format.ts`) maps activity types to colors (e.g., run = orange, ride = blue) used for polyline rendering on maps and UI accents.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before. Each explanation covers what the pattern is, what problem it solves, and how it works in this project.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of checking per-user permissions, the system checks if a user's role includes the required permission.

**What problem it solves**: Without RBAC, determining who can do what requires scattered conditional checks throughout the code. For a fitness platform, you need to distinguish between regular athletes (who can upload activities, follow others, and give kudos) and admins (who can view platform-wide statistics, manage all users, and moderate content). RBAC provides a clean boundary: user-facing endpoints check for the `user` role, admin endpoints check for the `admin` role.

**How it works in this project**: The `users` table has a `role` column (default `'user'`). The auth middleware loads the session from Redis and attaches the user object (including role) to each request. Admin endpoints (`/api/stats/admin/*`) check the role in middleware before allowing access. Regular athletes can only modify their own data (ownership checks for activities, kudos, comments). The social graph (follow/unfollow) and activity privacy settings (`privacy` column: `'public'`, `'followers'`, `'private'`) add a second layer of access control beyond simple role checks.

### Redis Cache-Aside

**What it is**: Cache-aside is a caching strategy where the application checks the cache before querying the database. On a cache miss, the database is queried, the result is stored in the cache with a TTL, and then returned. On a cache hit, the cached value is returned directly.

**What problem it solves**: In a fitness platform, certain data is read far more often than it is written. A popular segment's leaderboard might be viewed 1,000 times per hour but only updated when someone rides that segment. Activity feeds are read on every page load but only updated when followed athletes upload activities. Without caching, every feed view requires a `ZREVRANGE` on Redis plus database lookups for activity details -- the Redis part is fast, but the database lookups add up under load.

**How it works in this project**: Redis sorted sets serve as the primary cache for two hot data paths. Leaderboards use sorted sets (`leaderboard:{segment_id}`) with elapsed time as the score, providing O(log N) insertions and O(k) for top-k queries. Activity feeds use sorted sets (`feed:{user_id}`) with timestamps as scores, providing chronological feed reads via `ZREVRANGE`. Personal records are cached as simple string keys (`pr:{user_id}:{segment_id}`) for O(1) lookups. Idempotency results are cached with 24-hour TTL to prevent duplicate activity uploads. All cached data is reconstructible from PostgreSQL -- if Redis crashes, leaderboards and feeds are rebuilt from `segment_efforts` and `activities` tables.

### Circuit Breaker

**What it is**: A circuit breaker wraps calls to external or potentially failing services and monitors their success rate. When failures exceed a threshold, it stops sending requests (circuit "opens"), waits for a recovery period, then allows test requests (circuit "half-open"). If tests succeed, normal operation resumes.

**What problem it solves**: In this project, the circuit breaker concept applies to segment matching. Segment matching runs synchronously during activity upload and involves expensive database queries (bounding box intersection + GPS point comparison). If the database is under heavy load, segment matching could time out, causing the entire activity upload to fail. A circuit breaker around the matching service would allow the activity to be saved even if matching fails, with matching retried later.

**How it works in this project**: While not using the Opossum library directly (segment matching runs in-process), the architecture design applies circuit breaker thinking to the segment matching flow. The system is designed so that segment matching failure does not prevent activity creation -- the activity and GPS points are committed to PostgreSQL first, and matching runs as a separate step. If matching times out or errors, the activity is still saved successfully. The production design would move matching to a background worker behind a Kafka topic, with a proper circuit breaker wrapping the matching service calls.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable JSON rather than free-form text. Each entry has defined fields (timestamp, level, message, contextual data) that can be searched, filtered, and aggregated by log management tools.

**What problem it solves**: Debugging "why didn't segment matching find segment X for activity Y?" in a system processing thousands of activities per day requires precise log search. A free-form message like "No segments matched" is useless without context. A structured entry like `{"msg":"segment_match_complete","activity_id":"abc","candidates":15,"matches":0,"duration_ms":230}` can be found instantly and reveals that 15 candidates were evaluated but none matched.

**How it works in this project**: Pino (`backend/src/shared/logger.ts`) outputs JSON logs with 8 component-specific child loggers: `activity`, `segment`, `leaderboard`, `feed`, `database`, `redis`, `auth`, `lifecycle`. Each child logger automatically includes a `component` field in every entry. Request-scoped loggers carry correlation IDs from `X-Request-Id` headers, enabling end-to-end tracing of a single activity upload through parsing, GPS storage, segment matching, leaderboard updates, feed fan-out, and achievement checking. Sensitive fields (password, session ID, cookies, authorization headers) are automatically redacted by Pino's redaction configuration.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system where the application exposes numerical measurements at a `/metrics` endpoint, scraped periodically by a Prometheus server. Grafana visualizes this data as dashboards and triggers alerts on thresholds.

**What problem it solves**: A fitness platform needs visibility into several performance-critical pipelines. How long does activity upload take? How many GPS points are we ingesting per minute? Is segment matching keeping up, or is it creating a backlog? Are leaderboard updates fast enough? Without metrics, these questions require manual investigation -- with metrics, they are answered by a glance at a dashboard.

**How it works in this project**: The `prom-client` library (`backend/src/shared/metrics.ts`) registers 20+ metrics organized by subsystem. Activity metrics: `strava_activity_uploads_total` (counter by type/status), `strava_activity_upload_duration_seconds` (histogram), `strava_activity_gps_points_total` (counter tracking data ingestion volume). Segment metrics: `strava_segment_match_duration_seconds` (histogram measuring the two-phase matching algorithm's latency), `strava_segment_matches_total` (counter tracking how often matching finds results). Leaderboard metrics: `strava_leaderboard_updates_total` (counter for PR and podium frequency), `strava_leaderboard_query_duration_seconds` (histogram for Redis query speed). Feed metrics: `strava_feed_fanout_duration_seconds` (histogram tracking how long it takes to fan out an activity to followers -- this grows with follower count). Infrastructure metrics: `strava_db_query_duration_seconds`, `strava_redis_connected` (gauge for connection health).

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make within a time window, rejecting excess requests with HTTP 429.

**What problem it solves**: Activity uploads are expensive (GPX parsing, GPS point insertion, segment matching). Without rate limiting, a buggy fitness device could upload the same activity repeatedly, consuming database resources and creating duplicate segment efforts. The API also needs protection against bots scraping athlete profiles and leaderboard data.

**How it works in this project**: Rate limiting is implemented at the API Gateway level in the production design (not as a separate middleware in the local implementation). The architecture specifies per-endpoint limits: activity uploads are rate-limited more aggressively (expensive operation) than feed reads (cheap Redis query). The idempotency system (see below) provides a complementary defense specifically for activity uploads.

### Idempotency

**What it is**: An idempotent operation produces the same result whether executed once or multiple times. For APIs, this means retrying a request due to network failure is always safe -- the server detects the duplicate and returns the original response without re-executing the operation.

**What problem it solves**: GPS devices and fitness apps frequently retry activity uploads. A cyclist finishes a ride, the app uploads the GPX file, the network drops before the response arrives, and the app retries. Without idempotency, the second upload creates a duplicate activity with duplicate segment efforts, corrupting leaderboards (the athlete now appears twice) and inflating statistics (their monthly distance is doubled). This is especially problematic because the duplicate is difficult to detect after the fact -- two identical activities with slightly different upload timestamps look legitimate.

**How it works in this project**: The idempotency service (`backend/src/shared/idempotency.ts`) uses a two-layer approach. Layer 1 is content-based hashing: a SHA-256 hash of `userId + GPX file content + start timestamp` creates a unique fingerprint. The same GPX file uploaded twice by the same user produces the same hash. Layer 2 is client-provided keys: the `X-Idempotency-Key` header allows mobile apps to generate their own upload IDs, enabling idempotency even before the GPX content is read. Keys are stored in Redis with 24-hour TTL in key pattern `idem:activity:{sha256_hash}` containing `{ activity_id, name, type, cached_at }`. On duplicate detection, the server returns 200 OK with the original activity data (not 409 Conflict), because the client's goal (activity uploaded) was achieved.

### Health Checks

**What it is**: Health check endpoints are HTTP routes that report whether the application is functioning correctly. They are consumed by load balancers, container orchestrators, and monitoring systems to make automated routing and lifecycle decisions.

**What problem it solves**: An API server might be running but unable to process activity uploads because PostgreSQL is unreachable or unable to serve feeds because Redis is down. Without health checks, a load balancer keeps routing traffic to the broken instance, causing errors. Health checks enable automatic removal of unhealthy instances from the traffic pool.

**How it works in this project**: The backend (`backend/src/shared/health.ts`) exposes a three-tier health check system. `GET /health` (liveness): returns 200 with uptime and memory usage -- confirms the process is running and not deadlocked. `GET /health/ready` (readiness): checks PostgreSQL connectivity (via `SELECT 1`) and Redis connectivity (via `PING`). Returns 200 only if both are connected, otherwise 503. This is used by load balancers to decide if this instance should receive traffic. `GET /health/detailed` (debugging): reports per-component status with measured latency for each dependency check, connection pool statistics, and memory breakdown. This is used by operators during incident investigation. The separation between liveness and readiness matters: an instance that lost its Redis connection is alive (do not kill it, Redis might come back) but not ready (do not send it traffic that requires leaderboard or feed reads).
