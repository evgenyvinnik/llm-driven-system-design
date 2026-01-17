# Strava - Fitness Tracking - Architecture Design

## System Overview

A fitness tracking and social platform for athletes that records GPS-based activities, enables social features among athletes, and provides segment-based leaderboards.

## Requirements

### Functional Requirements

- **Activity Recording** - Record GPS-based activities (running, cycling, hiking) with metrics
- **Route Visualization** - Display activities on maps with route polylines
- **Segment Matching** - Detect when activities traverse predefined route segments
- **Leaderboards** - Rank athletes on segments by time
- **Social Features** - Follow athletes, activity feed, kudos, comments
- **Statistics** - Track personal stats and achievements

### Non-Functional Requirements

- **Reliability** - Never lose uploaded activity data
- **Latency** - Activity upload and processing under 30 seconds
- **Scalability** - Handle multiple concurrent users (learning project scale)
- **Accuracy** - Segment matching must be precise for fair competition

### Out of Scope

- Training plans and coaching features
- Paid subscription tiers
- Partner device integrations (Garmin, Wahoo, etc.)
- Real-time live tracking during activities

## Capacity Estimation

### Learning Project Scale

- 100-1000 registered users
- 10-100 activities per day
- 1000-10000 GPS points per activity
- 10-100 segments

### Storage Estimates

- GPS point: ~50 bytes (lat, lng, altitude, time, speed, heart_rate)
- Average activity: 1000 points x 50 bytes = 50 KB
- Daily GPS storage: ~5 MB

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   React     │  │  TanStack   │  │  Zustand    │  │  Leaflet    │    │
│  │   + Vite    │  │   Router    │  │   Store     │  │   Maps      │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ HTTP
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Backend API                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Express   │  │   Auth      │  │  Activity   │  │  Segment    │    │
│  │   Server    │  │   Routes    │  │   Routes    │  │   Routes    │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │   GPX       │  │  Segment    │  │ Achievement │                      │
│  │  Parser     │  │  Matcher    │  │  Service    │                      │
│  └─────────────┘  └─────────────┘  └─────────────┘                      │
└─────────────────────┬─────────────────────────┬─────────────────────────┘
                      │                         │
                      ▼                         ▼
           ┌─────────────────┐       ┌─────────────────┐
           │   PostgreSQL    │       │     Redis       │
           │   + PostGIS     │       │                 │
           │                 │       │ - Sessions      │
           │ - Users         │       │ - Leaderboards  │
           │ - Activities    │       │ - Feed Cache    │
           │ - GPS Points    │       │ - User Cache    │
           │ - Segments      │       │                 │
           │ - Efforts       │       │                 │
           └─────────────────┘       └─────────────────┘
```

### Core Components

1. **Activity Service** - Handles uploads, GPX parsing, metric calculation
2. **Segment Matcher** - Two-phase matching: bounding box filter + GPS point comparison
3. **Leaderboard Service** - Redis sorted sets for rankings
4. **Feed Generator** - Fan-out on write for personalized feeds
5. **Achievement Service** - Checks and awards achievements after activities

## Data Model

### Entity-Relationship Overview

The database follows a normalized design with clear entity boundaries. The central entities are **Users**, **Activities**, and **Segments**, connected through relationship tables.

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
│ - follower_id│  (as follower)     │ - id             │                    │ - id         │
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
                              │ - segment_id  ───────────────►│
                              │ - activity_id ───────────────►│
                              │ - user_id     ───────────────►│
                              │ - elapsed_time                │
                              │ - pr_rank                     │
                              └───────────────────────────────┘
```

### Complete PostgreSQL Schema

The full schema is available in `/backend/src/db/init.sql`. Below is the detailed documentation of each table.

#### Core User Management

```sql
-- Users table: Central entity for all athletes
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(50) UNIQUE NOT NULL,    -- Public display name
    email           VARCHAR(255) UNIQUE NOT NULL,   -- Login credential
    password_hash   VARCHAR(255) NOT NULL,          -- bcrypt hashed
    profile_photo   VARCHAR(512),                   -- URL to profile image
    weight_kg       DECIMAL(5,2),                   -- For calorie calculations
    bio             TEXT,                           -- User biography
    location        VARCHAR(255),                   -- General location
    role            VARCHAR(20) DEFAULT 'user',     -- 'user' or 'admin'
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
```

**Design Rationale:**
- **UUID primary keys**: Allows distributed ID generation and prevents ID enumeration attacks
- **Composite primary key on follows**: Prevents duplicate relationships and enables efficient lookups in both directions
- **ON DELETE CASCADE**: When a user is deleted, all their follow relationships are automatically removed

#### Activity Tracking

```sql
-- Activities table: Core workout records
CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL,           -- 'run', 'ride', 'hike', 'walk'
    name            VARCHAR(255),                   -- Activity title
    description     TEXT,                           -- User notes
    start_time      TIMESTAMP NOT NULL,             -- When activity started
    elapsed_time    INTEGER NOT NULL,               -- Total time (seconds)
    moving_time     INTEGER NOT NULL,               -- Time moving (seconds)
    distance        DECIMAL(12,2),                  -- Distance (meters)
    elevation_gain  DECIMAL(8,2),                   -- Climbing (meters)
    calories        INTEGER,                        -- Estimated calories
    avg_heart_rate  INTEGER,                        -- Average bpm
    max_heart_rate  INTEGER,                        -- Maximum bpm
    avg_speed       DECIMAL(8,2),                   -- Average m/s
    max_speed       DECIMAL(8,2),                   -- Maximum m/s
    privacy         VARCHAR(20) DEFAULT 'followers', -- Visibility level
    polyline        TEXT,                           -- Encoded route
    start_lat       DECIMAL(10,7),                  -- Starting coordinates
    start_lng       DECIMAL(10,7),
    end_lat         DECIMAL(10,7),                  -- Ending coordinates
    end_lng         DECIMAL(10,7),
    kudos_count     INTEGER DEFAULT 0,              -- Denormalized count
    comment_count   INTEGER DEFAULT 0,              -- Denormalized count
    created_at      TIMESTAMP DEFAULT NOW()
);

-- GPS Points: Detailed route data
CREATE TABLE gps_points (
    id              SERIAL PRIMARY KEY,
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    point_index     INTEGER NOT NULL,               -- Order in track
    timestamp       TIMESTAMP,                      -- When recorded
    latitude        DECIMAL(10,7) NOT NULL,         -- GPS latitude
    longitude       DECIMAL(10,7) NOT NULL,         -- GPS longitude
    altitude        DECIMAL(8,2),                   -- Elevation (meters)
    speed           DECIMAL(8,2),                   -- Instantaneous m/s
    heart_rate      INTEGER,                        -- Heart rate (bpm)
    cadence         INTEGER,                        -- Steps/rev per minute
    power           INTEGER                         -- Power (watts)
);

-- Index for efficient GPS retrieval
CREATE INDEX idx_gps_points_activity ON gps_points(activity_id, point_index);
```

**Design Rationale:**
- **Separate gps_points table**: Normalizes storage; an activity may have 1,000-50,000 GPS points
- **point_index column**: Maintains GPS track order for segment matching
- **polyline on activities**: Stores pre-encoded route for quick map display (avoids loading all GPS points)
- **Denormalized kudos_count/comment_count**: Avoids COUNT(*) queries on every activity load
- **DECIMAL for coordinates**: DECIMAL(10,7) provides ~1cm precision (7 decimal places)

#### Segment System

```sql
-- Segments: Predefined route sections for competition
CREATE TABLE segments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,          -- Segment name
    activity_type   VARCHAR(20) NOT NULL,           -- 'run' or 'ride'
    distance        DECIMAL(12,2) NOT NULL,         -- Length (meters)
    elevation_gain  DECIMAL(8,2),                   -- Climbing (meters)
    polyline        TEXT NOT NULL,                  -- Encoded route
    start_lat       DECIMAL(10,7) NOT NULL,         -- Start coordinates
    start_lng       DECIMAL(10,7) NOT NULL,
    end_lat         DECIMAL(10,7) NOT NULL,         -- End coordinates
    end_lng         DECIMAL(10,7) NOT NULL,
    min_lat         DECIMAL(10,7) NOT NULL,         -- Bounding box
    min_lng         DECIMAL(10,7) NOT NULL,
    max_lat         DECIMAL(10,7) NOT NULL,
    max_lng         DECIMAL(10,7) NOT NULL,
    effort_count    INTEGER DEFAULT 0,              -- Total completions
    athlete_count   INTEGER DEFAULT 0,              -- Unique athletes
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Bounding box index for segment matching
CREATE INDEX idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);
CREATE INDEX idx_segments_type ON segments(activity_type);

-- Segment efforts: Records of segment completions
CREATE TABLE segment_efforts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id      UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_time    INTEGER NOT NULL,               -- Completion time (seconds)
    moving_time     INTEGER NOT NULL,               -- Moving time (seconds)
    start_index     INTEGER,                        -- GPS point start
    end_index       INTEGER,                        -- GPS point end
    avg_speed       DECIMAL(8,2),                   -- Average m/s
    max_speed       DECIMAL(8,2),                   -- Maximum m/s
    pr_rank         INTEGER,                        -- Personal record rank (1,2,3)
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Leaderboard query optimization
CREATE INDEX idx_segment_efforts_segment ON segment_efforts(segment_id, elapsed_time);
-- Personal record lookups
CREATE INDEX idx_segment_efforts_user ON segment_efforts(user_id, segment_id);
```

**Design Rationale:**
- **Bounding box columns (min/max lat/lng)**: Enables fast Phase 1 segment matching using simple range queries
- **start_index/end_index on efforts**: Allows linking back to exact GPS points for detailed analysis
- **Composite indexes**: `(segment_id, elapsed_time)` enables efficient leaderboard sorting without filesort
- **Triple foreign keys on segment_efforts**: Denormalized user_id (could be derived from activity) for faster user-specific queries

#### Privacy Management

```sql
-- Privacy zones: Hide GPS data near sensitive locations
CREATE TABLE privacy_zones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100),                   -- Zone name (e.g., "Home")
    center_lat      DECIMAL(10,7) NOT NULL,         -- Center point
    center_lng      DECIMAL(10,7) NOT NULL,
    radius_meters   INTEGER NOT NULL DEFAULT 500,   -- Hidden radius
    created_at      TIMESTAMP DEFAULT NOW()
);
```

**Design Rationale:**
- **Circular zones**: Simple to implement with Haversine distance; sufficient for privacy
- **Default 500m radius**: Balances privacy with route continuity
- **Multiple zones per user**: Athletes can protect home, work, and other locations

#### Social Features

```sql
-- Kudos: Activity "likes"
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
```

**Design Rationale:**
- **Composite primary key on kudos**: Prevents duplicate kudos and enables quick "has user given kudos?" checks
- **ON DELETE CASCADE**: Automatically removes kudos/comments when activity is deleted

#### Achievements/Gamification

```sql
-- Achievements: Badge definitions
CREATE TABLE achievements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon            VARCHAR(50),
    criteria_type   VARCHAR(50) NOT NULL,           -- e.g., 'activity_count'
    criteria_value  INTEGER NOT NULL                -- Threshold to earn
);

-- User achievements: Earned badges
CREATE TABLE user_achievements (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id  UUID NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    earned_at       TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);
```

**Design Rationale:**
- **Flexible criteria system**: `criteria_type` + `criteria_value` allows defining new achievements without schema changes
- **Junction table pattern**: Standard many-to-many relationship with timestamp for "when earned"

### Foreign Key Relationships and Cascade Behaviors

| Parent Table | Child Table | Cascade Behavior | Rationale |
|-------------|-------------|------------------|-----------|
| users | follows (as follower) | ON DELETE CASCADE | User deletion removes their follow relationships |
| users | follows (as following) | ON DELETE CASCADE | User deletion removes others following them |
| users | activities | ON DELETE CASCADE | User deletion removes all their activities |
| users | segments | ON DELETE CASCADE | User deletion removes segments they created |
| users | segment_efforts | ON DELETE CASCADE | User deletion removes their segment efforts |
| users | privacy_zones | ON DELETE CASCADE | User deletion removes their privacy zones |
| users | kudos | ON DELETE CASCADE | User deletion removes kudos they gave |
| users | comments | ON DELETE CASCADE | User deletion removes their comments |
| users | user_achievements | ON DELETE CASCADE | User deletion removes their achievements |
| activities | gps_points | ON DELETE CASCADE | Activity deletion removes GPS data |
| activities | segment_efforts | ON DELETE CASCADE | Activity deletion removes related efforts |
| activities | kudos | ON DELETE CASCADE | Activity deletion removes kudos |
| activities | comments | ON DELETE CASCADE | Activity deletion removes comments |
| segments | segment_efforts | ON DELETE CASCADE | Segment deletion removes all efforts |
| achievements | user_achievements | ON DELETE CASCADE | Achievement deletion removes user awards |

### Index Strategy

| Index Name | Table | Columns | Purpose |
|-----------|-------|---------|---------|
| idx_gps_points_activity | gps_points | (activity_id, point_index) | Fast retrieval of GPS track in order |
| idx_segments_bbox | segments | (min_lat, max_lat, min_lng, max_lng) | Phase 1 segment matching (bounding box) |
| idx_segments_type | segments | (activity_type) | Filter segments by run/ride |
| idx_segment_efforts_segment | segment_efforts | (segment_id, elapsed_time) | Leaderboard queries with sorting |
| idx_segment_efforts_user | segment_efforts | (user_id, segment_id) | Personal records lookup |

### Data Flow Between Tables

#### Activity Upload Flow
```
1. User uploads GPX file
   └─► activities row created
       └─► gps_points rows created (1000s of points)
           └─► Segment matching triggered
               ├─► Query segments by bounding box (idx_segments_bbox)
               └─► For each matching segment:
                   └─► segment_efforts row created
                       ├─► segments.effort_count incremented
                       ├─► segments.athlete_count updated (if first effort)
                       └─► Redis leaderboard updated
                           └─► Achievement check triggered
                               └─► user_achievements row created (if earned)
```

#### Feed Generation Flow
```
1. Activity created
   └─► Query follows WHERE following_id = activity.user_id
       └─► For each follower:
           └─► Add to Redis feed:{follower_id} sorted set
```

#### Kudos Flow
```
1. User gives kudos
   └─► kudos row inserted (idempotent via primary key)
       └─► activities.kudos_count incremented (denormalized)
           └─► Achievement check for "Popular Athlete"
```

### Storage Estimation

| Table | Row Size (avg) | Rows per Active User | Growth Rate |
|-------|---------------|---------------------|-------------|
| users | 500 bytes | 1 | Stable |
| activities | 500 bytes | 100/year | Linear |
| gps_points | 50 bytes | 500,000/year | Linear (largest table) |
| segments | 300 bytes | 5/user created | Slow |
| segment_efforts | 100 bytes | 500/year | Linear |
| follows | 50 bytes | 100/user | Stable |
| kudos | 50 bytes | 1000/year | Linear |
| comments | 200 bytes | 200/year | Linear |

**Example: 1,000 active users after 1 year:**
- gps_points: 500M rows x 50 bytes = ~25 GB
- activities: 100K rows x 500 bytes = ~50 MB
- All other tables combined: < 100 MB

### Redis Data Structures

```
# Leaderboards (sorted sets - lower time = better)
leaderboard:{segment_id} -> ZSET { user_id: elapsed_time }

# Personal Records
pr:{user_id}:{segment_id} -> best_elapsed_time

# Activity Feeds (sorted sets - score = timestamp)
feed:{user_id} -> ZSET { activity_id: timestamp }

# Sessions
sess:{session_id} -> JSON { userId, username, role }
```

## API Design

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout (destroy session)
- `GET /api/auth/me` - Get current user

### Activities
- `GET /api/activities` - List activities (paginated)
- `GET /api/activities/:id` - Get activity details
- `GET /api/activities/:id/gps` - Get GPS points
- `POST /api/activities/upload` - Upload GPX file
- `POST /api/activities/simulate` - Create simulated activity
- `POST /api/activities/:id/kudos` - Give kudos
- `DELETE /api/activities/:id/kudos` - Remove kudos
- `POST /api/activities/:id/comments` - Add comment

### Segments
- `GET /api/segments` - List segments (with search)
- `GET /api/segments/:id` - Get segment with leaderboard
- `GET /api/segments/:id/leaderboard` - Get leaderboard
- `POST /api/segments` - Create segment from activity

### Users & Social
- `GET /api/users/:id` - Get user profile
- `POST /api/users/:id/follow` - Follow user
- `DELETE /api/users/:id/follow` - Unfollow user
- `GET /api/feed` - Get personalized feed
- `GET /api/feed/explore` - Get public activities

## Key Design Decisions

### GPS Data Storage

**Decision:** PostgreSQL with indexed tables instead of Cassandra.

**Rationale:** For this learning project, PostgreSQL handles the scale well. The `gps_points` table with a composite index on `(activity_id, point_index)` provides efficient retrieval. For production scale (millions of activities/day), we would use Cassandra or TimescaleDB.

### Segment Matching Algorithm

**Decision:** Two-phase matching:
1. Bounding box intersection (fast filter)
2. GPS point comparison (precise match)

**Implementation:**
```javascript
// Phase 1: Find candidate segments
const candidates = await db.query(`
  SELECT * FROM segments
  WHERE activity_type = $1
    AND min_lat <= $2 AND max_lat >= $3
    AND min_lng <= $4 AND max_lng >= $5
`, [activityType, activityMaxLat, activityMinLat, activityMaxLng, activityMinLng]);

// Phase 2: Match GPS points (25m threshold)
for (const segment of candidates) {
  const effort = matchGpsPoints(activityPoints, segmentPoints);
  if (effort) await saveEffort(effort);
}
```

### Leaderboard Implementation

**Decision:** Redis sorted sets with elapsed time as score.

**Advantages:**
- O(log N) insertions
- O(1) rank lookups
- Built-in range queries for top N

```javascript
// Update leaderboard
await redis.zadd(`leaderboard:${segmentId}`, elapsedTime, oderId);

// Get top 10
const leaderboard = await redis.zrange(`leaderboard:${segmentId}`, 0, 9, 'WITHSCORES');
```

### Activity Feed Strategy

**Decision:** Fan-out on write.

**Implementation:** When an activity is created, add it to all followers' feeds.

```javascript
const followers = await db.query('SELECT follower_id FROM follows WHERE following_id = $1', [userId]);
for (const follower of followers.rows) {
  await redis.zadd(`feed:${follower.follower_id}`, timestamp, activityId);
  await redis.zremrangebyrank(`feed:${follower.follower_id}`, 0, -1001); // Keep last 1000
}
```

**Trade-off:** More write work, but fast reads. Works well for typical follower counts.

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 19 + Vite | Fast development, TypeScript support |
| Routing | TanStack Router | File-based routing, type-safe |
| State | Zustand | Minimal boilerplate, performant |
| Maps | Leaflet + React-Leaflet | Open source, widely used |
| Backend | Node.js + Express | Familiar, quick iteration |
| Database | PostgreSQL + PostGIS | Reliable, geospatial support |
| Cache | Redis | Sessions, leaderboards, feeds |
| Styling | Tailwind CSS | Utility-first, consistent design |

## Scalability Considerations

### Current Implementation (Learning Scale)
- Single backend instance
- PostgreSQL for all data
- Redis for sessions/leaderboards/feeds
- Local file processing

### Production Scale Improvements
1. **Horizontal scaling**: Multiple API servers behind load balancer
2. **GPS data**: Move to Cassandra or TimescaleDB
3. **Segment matching**: Background job queue (RabbitMQ/Kafka)
4. **CDN**: Cache static assets and map tiles
5. **Read replicas**: PostgreSQL read replicas for queries
6. **Caching**: Application-level caching for hot data

## Monitoring and Observability

### Recommended Stack (Future)
- **Metrics**: Prometheus + Grafana
- **Logging**: Structured JSON logs
- **Tracing**: OpenTelemetry

### Key Metrics to Track
- Activity upload latency
- Segment matching duration
- API response times
- Database query performance
- Cache hit rates

## Security Considerations

- **Authentication**: Session-based with HttpOnly cookies
- **Password Storage**: bcrypt hashing
- **CORS**: Restricted to known origins
- **Input Validation**: Sanitize all user inputs
- **SQL Injection**: Parameterized queries only
- **Rate Limiting**: Consider for production

## Data Lifecycle Policies

### Retention and TTL Policies

| Data Type | Hot Storage | Warm/Archive | Deletion | Rationale |
|-----------|-------------|--------------|----------|-----------|
| Activities | Indefinite | N/A | Manual by user | Core user data, never auto-delete |
| GPS Points | 1 year full resolution | Downsample after 1 year | Keep downsampled indefinitely | Reduce storage while preserving routes |
| Segment Efforts | 2 years | Archive to cold storage | Delete after 5 years | Historical leaderboards less relevant |
| Activity Feeds | 30 days in Redis | N/A | Auto-expire | Reconstructible from database |
| Session Data | 24 hours | N/A | Redis TTL | Security best practice |
| Leaderboards | Indefinite in Redis | Rebuild from DB if lost | N/A | Small dataset, high read frequency |

### GPS Point Downsampling Strategy

After 1 year, reduce GPS resolution to save storage while preserving route shape:

```sql
-- Downsample to every 5th point (80% reduction)
DELETE FROM gps_points
WHERE activity_id IN (
  SELECT id FROM activities
  WHERE created_at < NOW() - INTERVAL '1 year'
)
AND point_index % 5 != 0;

-- Update polyline (encoded route unaffected, stored separately)
```

### Cold Storage Archival (Local Development)

For local development, cold storage is simulated using compressed SQL dumps:

```bash
# Archive old segment efforts to compressed file
pg_dump -t segment_efforts --where="created_at < NOW() - INTERVAL '2 years'" \
  strava_db | gzip > archives/efforts_$(date +%Y%m).sql.gz

# Delete archived records from active database
DELETE FROM segment_efforts WHERE created_at < NOW() - INTERVAL '2 years';
```

### Backfill and Replay Procedures

**Scenario 1: Redis Cache Lost**
```bash
# Rebuild leaderboards from PostgreSQL
npm run rebuild:leaderboards

# Script implementation:
# SELECT segment_id, user_id, MIN(elapsed_time) as best_time
# FROM segment_efforts
# GROUP BY segment_id, user_id
# -> ZADD to Redis sorted sets
```

**Scenario 2: Activity Feed Reconstruction**
```bash
# Rebuild user feeds from follows + activities
npm run rebuild:feeds

# For each user:
#   1. Get all followed users
#   2. Get their activities from last 30 days
#   3. ZADD to feed:{user_id} with activity timestamps
```

**Scenario 3: Segment Effort Reprocessing**
```bash
# Re-run segment matching for specific activities
npm run reprocess:segments --activity-id=<uuid>
npm run reprocess:segments --date-range="2024-01-01,2024-01-31"
```

## Deployment and Operations

### Rollout Strategy (Local Multi-Instance)

For learning distributed systems locally, run multiple instances:

```bash
# Terminal 1: Backend instance A (port 3001)
PORT=3001 npm run dev

# Terminal 2: Backend instance B (port 3002)
PORT=3002 npm run dev

# Terminal 3: Simple load balancer (nginx or node-based)
npm run dev:lb  # Routes to 3001/3002 round-robin
```

**Rolling deployment simulation:**
1. Start new version on port 3003
2. Health check: `curl http://localhost:3003/health`
3. Update load balancer to include 3003
4. Remove 3001 from load balancer
5. Stop old instance on 3001
6. Repeat for 3002

### Schema Migration Runbook

**Before running migrations:**
```bash
# 1. Check current migration status
npm run db:status

# 2. Review pending migrations
ls backend/src/db/migrations/

# 3. Take database backup (local)
pg_dump strava_db > backup_$(date +%Y%m%d_%H%M%S).sql
```

**Running migrations:**
```bash
# Apply all pending migrations
npm run db:migrate

# Verify migration success
npm run db:status
```

**Migration file naming:**
```
001_create_users.sql
002_create_activities.sql
003_add_polyline_to_activities.sql
004_create_segments.sql
```

### Rollback Runbook

**Application Rollback:**
```bash
# 1. Identify last known good commit
git log --oneline -10

# 2. Checkout and rebuild
git checkout <commit-hash>
npm install && npm run build

# 3. Restart services
npm run dev
```

**Database Rollback (if migration fails):**
```bash
# Option A: Restore from backup
psql strava_db < backup_20240115_143022.sql

# Option B: Run down migration (if implemented)
npm run db:rollback

# Option C: Manual fix (document the SQL)
psql strava_db -c "DROP TABLE IF EXISTS new_table;"
psql strava_db -c "ALTER TABLE activities DROP COLUMN IF EXISTS new_column;"
```

**Redis Rollback:**
```bash
# Redis data is reconstructible from PostgreSQL
# If corruption occurs, flush and rebuild

redis-cli FLUSHDB
npm run rebuild:leaderboards
npm run rebuild:feeds
```

### Health Check Endpoints

```javascript
// GET /health - Basic liveness
{ "status": "ok", "timestamp": "2024-01-15T10:30:00Z" }

// GET /health/ready - Readiness (dependencies)
{
  "status": "ok",
  "postgres": "connected",
  "redis": "connected",
  "latency_ms": { "postgres": 2, "redis": 1 }
}
```

## Capacity and Cost Guardrails

### Monitoring Alerts (Local Development)

Even for local development, practice setting up alerts. Use console logging or a simple dashboard:

**Queue Lag Alerts (if using RabbitMQ/Kafka for background jobs):**
```javascript
// Check every 30 seconds
const QUEUE_LAG_THRESHOLD = 100; // messages

async function checkQueueHealth() {
  const pendingJobs = await queue.getJobCounts();
  if (pendingJobs.waiting > QUEUE_LAG_THRESHOLD) {
    console.warn(`[ALERT] Queue lag: ${pendingJobs.waiting} pending jobs`);
  }
}
```

**Segment Matching Duration:**
```javascript
const SEGMENT_MATCH_WARN_MS = 5000;

const start = Date.now();
await matchSegments(activity);
const duration = Date.now() - start;

if (duration > SEGMENT_MATCH_WARN_MS) {
  console.warn(`[ALERT] Slow segment matching: ${duration}ms for activity ${activity.id}`);
}
```

### Storage Growth Monitoring

Track database size weekly to catch unexpected growth:

```sql
-- Check table sizes
SELECT
  relname as table_name,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  pg_size_pretty(pg_relation_size(relid)) as data_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

**Expected growth (learning project):**
| Table | Expected Size | Alert Threshold |
|-------|---------------|-----------------|
| gps_points | 50 MB/month | > 500 MB total |
| activities | 5 MB/month | > 50 MB total |
| segment_efforts | 1 MB/month | > 20 MB total |

### Cache Hit Rate Targets

Monitor Redis cache effectiveness:

```javascript
// Track cache hits/misses
const cacheStats = { hits: 0, misses: 0 };

async function getCachedFeed(userId) {
  const cached = await redis.get(`feed:${userId}`);
  if (cached) {
    cacheStats.hits++;
    return JSON.parse(cached);
  }
  cacheStats.misses++;
  // ... fetch from DB
}

// Log hit rate every 5 minutes
setInterval(() => {
  const total = cacheStats.hits + cacheStats.misses;
  const hitRate = total > 0 ? (cacheStats.hits / total * 100).toFixed(1) : 0;
  console.log(`[METRICS] Cache hit rate: ${hitRate}% (${cacheStats.hits}/${total})`);
  cacheStats.hits = 0;
  cacheStats.misses = 0;
}, 300000);
```

**Target hit rates:**
| Cache Type | Target | Action if Below |
|------------|--------|-----------------|
| Activity feeds | > 80% | Increase TTL or pre-warm on follow |
| Leaderboards | > 95% | Check for missing ZADD on effort creation |
| User profiles | > 70% | Acceptable, profiles change frequently |

### Resource Limits (Local Development)

Prevent runaway processes from consuming system resources:

```javascript
// Limit concurrent segment matching
const CONCURRENT_MATCH_LIMIT = 3;
const matchQueue = new PQueue({ concurrency: CONCURRENT_MATCH_LIMIT });

// Limit GPS points per activity (prevent DoS via huge uploads)
const MAX_GPS_POINTS = 50000; // ~14 hours at 1 point/second

// Limit feed size to prevent Redis bloat
const MAX_FEED_SIZE = 1000;
await redis.zremrangebyrank(`feed:${userId}`, 0, -MAX_FEED_SIZE - 1);
```

### Cost Estimation (If Deployed)

For reference, rough cloud costs at learning scale:

| Resource | Specification | Monthly Cost |
|----------|---------------|--------------|
| PostgreSQL | db.t3.micro (1 vCPU, 1GB) | ~$15 |
| Redis | cache.t3.micro (0.5GB) | ~$12 |
| Compute | t3.small (2 vCPU, 2GB) | ~$15 |
| Storage | 20GB gp3 | ~$2 |
| **Total** | | **~$44/month** |

Cost guardrails for cloud deployment:
- Set billing alerts at $25, $50, $75
- Use Reserved Instances after validating usage patterns
- Enable auto-scaling with max instance limits

## Future Optimizations

1. **Real-time updates**: WebSocket for live kudos/comments
2. **Privacy zones**: Full implementation with GPS filtering
3. **Route snapping**: Improve GPS accuracy using road network
4. **Challenges**: Time-based competitive events
5. **Heat maps**: Aggregate route visualization
6. **Training load**: Fitness and fatigue tracking

## Implementation Notes

This section explains the reasoning behind key implementation decisions for operability and reliability.

### Why Idempotency Prevents Duplicate Activity Uploads

**Problem:**
GPS devices and mobile apps frequently retry uploads due to:
- Network timeouts during large GPX file transfers
- User impatience leading to multiple "Upload" button clicks
- Device firmware bugs causing duplicate sync requests
- App crashes mid-upload with automatic retry on restart

Without idempotency, these retries create duplicate activities in the athlete's feed, corrupt statistics, and unfairly count segment efforts multiple times.

**Solution:**
The idempotency service (`src/shared/idempotency.js`) implements a two-layer approach:

1. **Content-based hashing**: SHA-256 hash of `userId + GPX content + start timestamp` creates a unique fingerprint. The same GPX file uploaded twice by the same user produces the same hash.

2. **Client-provided idempotency keys**: The `X-Idempotency-Key` header allows mobile apps to generate their own unique upload IDs, enabling retry logic that returns the original response.

**Implementation details:**
```javascript
// Key structure: idem:activity:<sha256-hash>
// TTL: 24 hours (covers delayed retries)
// On duplicate: Return cached activity with 200 OK (not 409 Conflict)
```

Returning 200 OK for duplicates (instead of an error) is intentional - the client's goal was achieved (activity exists), so the response should indicate success.

### Why Activity Archival Balances Athlete History vs Storage Costs

**Problem:**
GPS data is the largest storage consumer:
- Each GPS point: ~50 bytes (lat, lng, altitude, timestamp, heart_rate)
- Average activity: 1,000-10,000 points (50KB-500KB)
- Active athlete: 50-200 activities/year
- 10,000 users = 500GB-5TB GPS data annually

Athletes expect to view their complete history, but full-resolution GPS data from 5 years ago has diminishing value.

**Solution:**
The retention policy (`src/shared/config.js`) implements tiered storage:

| Age | Resolution | Rationale |
|-----|------------|-----------|
| 0-1 year | Full | Recent activities need detailed analysis |
| 1+ years | 1/5 points | Route shape preserved, 80% storage savings |

**Why downsampling works:**
- Polyline (encoded route for display) is stored separately and never modified
- Segment matching uses real-time GPS during upload, not historical data
- Downsampled points still support basic route replay

**Trade-off acknowledged:**
Athletes who want to re-analyze historical heart rate data at full resolution will lose granularity. This is acceptable because:
1. Such analysis is rare for old activities
2. Athletes can export GPX before downsampling
3. Storage costs compound while usage decreases

### Why Segment Metrics Enable Leaderboard Optimization

**Problem:**
Leaderboard queries are among the most frequent:
- Segment detail page loads top 10 on every view
- Athletes check their rank after each activity
- "Friends leaderboard" requires filtering and re-ranking

PostgreSQL `ORDER BY elapsed_time LIMIT 10` is O(N log N) - acceptable for small segments, problematic for popular ones with 100K+ efforts.

**Solution:**
The metrics module (`src/shared/metrics.js`) tracks segment performance:

```javascript
// Segment matching duration histogram
segmentMatchDuration.observe({ matched: true }, duration);

// Leaderboard query latency
leaderboardQueryDuration.observe({}, queryDuration);

// Track effort counts per segment
segmentMatchesTotal.inc({ segment_id: segmentId });
```

**How metrics enable optimization:**

1. **Identify slow segments**: `segmentMatchDuration` P99 > 5s triggers investigation
2. **Cache hot leaderboards**: High `segmentMatchesTotal` segments get Redis pre-warming
3. **Right-size Redis**: `leaderboardQueryDuration` validates Redis is faster than PostgreSQL

**Redis sorted set optimization:**
```javascript
// O(log N) insertion vs O(N log N) re-sort
await redis.zadd(`leaderboard:${segmentId}`, elapsedTime, oderId);

// O(1) rank lookup vs O(N) table scan
const rank = await redis.zrank(`leaderboard:${segmentId}`, oderId);
```

The `leaderboardUpdatesTotal` metric with `is_pr` and `is_podium` labels reveals how often leaderboards actually change, informing cache invalidation strategy.

### Why Health Checks Enable GPS Sync Reliability

**Problem:**
GPS device sync is often "fire and forget":
- Athlete ends workout, device attempts background sync
- If sync fails silently, athlete believes activity was saved
- Discovery of missing data may come hours/days later

The athlete experience depends on knowing sync succeeded or failed immediately.

**Solution:**
The health check service (`src/shared/health.js`) provides graduated checks:

| Endpoint | Use Case | Checks |
|----------|----------|--------|
| `GET /health` | Kubernetes liveness | Process running |
| `GET /health/ready` | Kubernetes readiness | PostgreSQL + Redis connected |
| `GET /health/detailed` | Debugging | Connection pools, memory, latency |

**How health checks enable sync reliability:**

1. **Load balancer integration**: Only route to instances where `/health/ready` returns 200
2. **Client retry logic**: Mobile apps can ping `/health` before upload to avoid wasted bandwidth
3. **Graceful degradation**: If Redis is down, activities still save to PostgreSQL (feeds reconstruct later)

**Startup sequence:**
```javascript
// Server starts accepting requests only after dependencies verified
const health = await checkReadiness();
if (health.status === HealthStatus.UNHEALTHY) {
  log.warn('Dependencies unhealthy at startup');
}
```

**Metrics integration:**
Health checks update Prometheus metrics for alerting:
```javascript
// Redis connection status (for Grafana alerts)
redisConnectionStatus.set(connected ? 1 : 0);

// Database pool saturation
dbConnectionsActive.set(pool.totalCount - pool.idleCount);
```

When `redisConnectionStatus` drops to 0, the alert fires before athletes notice feed delays.

### Observability Stack Summary

The implementation adds three observability pillars:

| Component | Technology | Purpose |
|-----------|------------|---------|
| Metrics | Prometheus (`/metrics`) | Quantitative health: latencies, counts, rates |
| Logging | Pino (JSON) | Qualitative context: request IDs, error stacks |
| Health | HTTP endpoints | Binary availability: up/down decisions |

**Key files:**
- `src/shared/metrics.js` - Prometheus counters, histograms, gauges
- `src/shared/logger.js` - Pino structured logging with request correlation
- `src/shared/health.js` - Liveness and readiness endpoints
- `src/shared/config.js` - Alert thresholds and retention policies
- `src/shared/idempotency.js` - Duplicate upload prevention
- `src/db/migrate.js` - Versioned schema migrations
