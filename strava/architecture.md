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

### PostgreSQL Schema

```sql
-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    profile_photo   VARCHAR(512),
    weight_kg       DECIMAL(5,2),
    bio             TEXT,
    location        VARCHAR(255),
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Following relationships
CREATE TABLE follows (
    follower_id     UUID REFERENCES users(id),
    following_id    UUID REFERENCES users(id),
    created_at      TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

-- Activities
CREATE TABLE activities (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(20) NOT NULL,      -- 'run', 'ride', 'hike'
    name            VARCHAR(255),
    start_time      TIMESTAMP NOT NULL,
    elapsed_time    INTEGER NOT NULL,          -- seconds
    moving_time     INTEGER NOT NULL,
    distance        DECIMAL(12,2),             -- meters
    elevation_gain  DECIMAL(8,2),              -- meters
    avg_speed       DECIMAL(8,2),              -- m/s
    max_speed       DECIMAL(8,2),
    polyline        TEXT,                      -- Encoded polyline for display
    privacy         VARCHAR(20) DEFAULT 'public',
    kudos_count     INTEGER DEFAULT 0,
    comment_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- GPS Points (for segment matching)
CREATE TABLE gps_points (
    id              SERIAL PRIMARY KEY,
    activity_id     UUID REFERENCES activities(id),
    point_index     INTEGER NOT NULL,
    timestamp       TIMESTAMP,
    latitude        DECIMAL(10,7) NOT NULL,
    longitude       DECIMAL(10,7) NOT NULL,
    altitude        DECIMAL(8,2),
    speed           DECIMAL(8,2),
    heart_rate      INTEGER
);

-- Segments
CREATE TABLE segments (
    id              UUID PRIMARY KEY,
    creator_id      UUID REFERENCES users(id),
    name            VARCHAR(255) NOT NULL,
    activity_type   VARCHAR(20) NOT NULL,
    distance        DECIMAL(12,2) NOT NULL,
    elevation_gain  DECIMAL(8,2),
    polyline        TEXT NOT NULL,
    start_lat       DECIMAL(10,7) NOT NULL,
    start_lng       DECIMAL(10,7) NOT NULL,
    end_lat         DECIMAL(10,7) NOT NULL,
    end_lng         DECIMAL(10,7) NOT NULL,
    min_lat         DECIMAL(10,7) NOT NULL,
    min_lng         DECIMAL(10,7) NOT NULL,
    max_lat         DECIMAL(10,7) NOT NULL,
    max_lng         DECIMAL(10,7) NOT NULL,
    effort_count    INTEGER DEFAULT 0,
    athlete_count   INTEGER DEFAULT 0
);

-- Segment Efforts
CREATE TABLE segment_efforts (
    id              UUID PRIMARY KEY,
    segment_id      UUID REFERENCES segments(id),
    activity_id     UUID REFERENCES activities(id),
    user_id         UUID REFERENCES users(id),
    elapsed_time    INTEGER NOT NULL,
    moving_time     INTEGER NOT NULL,
    pr_rank         INTEGER,                   -- 1, 2, 3 for top PRs
    created_at      TIMESTAMP DEFAULT NOW()
);
```

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

## Future Optimizations

1. **Real-time updates**: WebSocket for live kudos/comments
2. **Privacy zones**: Full implementation with GPS filtering
3. **Route snapping**: Improve GPS accuracy using road network
4. **Challenges**: Time-based competitive events
5. **Heat maps**: Aggregate route visualization
6. **Training load**: Fitness and fatigue tracking
