# Strava - Fitness Tracking Platform - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a fitness tracking platform like Strava, focusing on the backend systems that handle GPS data storage, segment matching algorithms, leaderboard calculations, and activity feed generation. This involves geospatial data processing, time-series storage, and real-time ranking systems. Let me clarify requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements (Backend Perspective)

1. **Activity Recording** - Ingest and parse GPS-based activities (GPX/FIT files) with metrics calculation
2. **Segment Matching** - Detect when activities traverse predefined route segments using geospatial algorithms
3. **Leaderboards** - Maintain real-time ranked lists with O(1) rank lookups
4. **Activity Feeds** - Generate personalized feeds using fan-out on write
5. **Privacy Zones** - Filter GPS points within user-defined circular zones
6. **Achievements** - Automatically check and award achievements after activities

### Non-Functional Requirements

- **Reliability** - Never lose uploaded activity data; idempotent uploads
- **Latency** - Activity upload and processing under 30 seconds end-to-end
- **Scalability** - Handle millions of GPS points per day
- **Accuracy** - Segment matching within 25m threshold for fair competition

### Backend-Specific Considerations

- GPS data storage optimization (50 bytes per point, thousands per activity)
- Efficient geospatial queries for segment candidate selection
- Redis sorted sets for O(log N) leaderboard updates
- Session-based authentication with Redis backing

---

## 2. Scale Estimation (3 minutes)

### Traffic Estimates

- 10 million weekly active users
- 5 million activities uploaded per day
- Average activity: 3,600 GPS points (1 hour at 1 point/second)
- Peak upload rate: ~100 activities/second

### Storage Estimates

| Data Type | Size per Unit | Daily Volume | Annual Volume |
|-----------|---------------|--------------|---------------|
| GPS points | 50 bytes | 900 GB | 330 TB |
| Activities | 500 bytes | 2.5 GB | 1 TB |
| Segment efforts | 100 bytes | 500 MB | 180 GB |

### Processing Estimates

- Segment matching: 5M activities x 100 candidate segments = 500M comparisons/day
- Feed fan-out: 10M users x 50 followers = 500M feed entries/day
- Leaderboard updates: ~10M new efforts/day

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           API Gateway                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Express   │  │   Auth      │  │  Activity   │  │  Segment    │    │
│  │   Server    │  │   Routes    │  │   Routes    │  │   Routes    │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   GPX       │  │  Segment    │  │ Leaderboard │  │   Feed      │    │
│  │  Parser     │  │  Matcher    │  │  Service    │  │  Generator  │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└─────────────────────┬─────────────────────────┬─────────────────────────┘
                      │                         │
          ┌───────────┴───────────┐   ┌─────────┴─────────┐
          ▼                       ▼   ▼                   ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   PostgreSQL    │     │    Cassandra    │     │     Redis       │
│   + PostGIS     │     │  (GPS Points)   │     │                 │
│                 │     │                 │     │ - Sessions      │
│ - Users         │     │ - TimeUUID      │     │ - Leaderboards  │
│ - Activities    │     │ - Point Index   │     │ - Feed Cache    │
│ - Segments      │     │                 │     │ - PR Cache      │
│ - Efforts       │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
          │
          ▼
┌─────────────────┐
│  Object Storage │
│  (GPX Files)    │
└─────────────────┘
```

### Core Backend Services

1. **Activity Service** - Upload handling, GPX parsing, privacy zone filtering, metrics calculation
2. **Segment Matcher** - Two-phase matching: bounding box filter + GPS point comparison
3. **Leaderboard Service** - Redis sorted sets for rankings, personal records
4. **Feed Generator** - Fan-out on write for personalized activity feeds
5. **Achievement Service** - Rule-based achievement checking after activities

---

## 4. Database Schema Design (8 minutes)

### PostgreSQL Schema (Relational Data)

```sql
-- Users table with authentication
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    profile_photo   VARCHAR(512),
    weight_kg       DECIMAL(5,2),
    role            VARCHAR(20) DEFAULT 'user',
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
);

-- Activities table with geospatial metadata
CREATE TABLE activities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            VARCHAR(20) NOT NULL,           -- 'run', 'ride', 'hike'
    name            VARCHAR(255),
    start_time      TIMESTAMP NOT NULL,
    elapsed_time    INTEGER NOT NULL,               -- seconds
    moving_time     INTEGER NOT NULL,
    distance        DECIMAL(12,2),                  -- meters
    elevation_gain  DECIMAL(8,2),
    avg_speed       DECIMAL(8,2),
    max_speed       DECIMAL(8,2),
    avg_heart_rate  INTEGER,
    max_heart_rate  INTEGER,
    privacy         VARCHAR(20) DEFAULT 'followers',
    polyline        TEXT,                           -- Encoded route for display
    start_lat       DECIMAL(10,7),
    start_lng       DECIMAL(10,7),
    end_lat         DECIMAL(10,7),
    end_lng         DECIMAL(10,7),
    kudos_count     INTEGER DEFAULT 0,              -- Denormalized for performance
    comment_count   INTEGER DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Segments with bounding box for fast filtering
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

-- Segment efforts with composite indexes
CREATE TABLE segment_efforts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    segment_id      UUID NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    elapsed_time    INTEGER NOT NULL,
    moving_time     INTEGER NOT NULL,
    start_index     INTEGER,                        -- GPS point start
    end_index       INTEGER,                        -- GPS point end
    pr_rank         INTEGER,                        -- 1, 2, 3 for podium
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Privacy zones for GPS filtering
CREATE TABLE privacy_zones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(100),
    center_lat      DECIMAL(10,7) NOT NULL,
    center_lng      DECIMAL(10,7) NOT NULL,
    radius_meters   INTEGER NOT NULL DEFAULT 500,
    created_at      TIMESTAMP DEFAULT NOW()
);
```

### Critical Indexes

```sql
-- GPS point retrieval in order
CREATE INDEX idx_gps_points_activity ON gps_points(activity_id, point_index);

-- Phase 1 segment matching (bounding box intersection)
CREATE INDEX idx_segments_bbox ON segments(min_lat, max_lat, min_lng, max_lng);
CREATE INDEX idx_segments_type ON segments(activity_type);

-- Leaderboard queries with sorting
CREATE INDEX idx_segment_efforts_segment ON segment_efforts(segment_id, elapsed_time);

-- Personal records lookup
CREATE INDEX idx_segment_efforts_user ON segment_efforts(user_id, segment_id);
```

### Cassandra Schema (GPS Time-Series)

```sql
-- Optimized for high-volume GPS writes
CREATE TABLE gps_points (
    activity_id     UUID,
    point_index     INT,
    timestamp       TIMESTAMP,
    latitude        DOUBLE,
    longitude       DOUBLE,
    altitude        DOUBLE,
    speed           DOUBLE,
    heart_rate      INT,
    cadence         INT,
    power           INT,
    PRIMARY KEY (activity_id, point_index)
) WITH CLUSTERING ORDER BY (point_index ASC);
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

# Idempotency keys
idem:activity:{sha256_hash} -> activity_id (TTL: 24h)
```

---

## 5. Deep Dive: Activity Upload Pipeline (10 minutes)

### Upload Flow Architecture

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Mobile  │───▶│   API    │───▶│  Object  │───▶│  Kafka   │
│   App    │    │  Server  │    │ Storage  │    │  Queue   │
└──────────┘    └────┬─────┘    └──────────┘    └────┬─────┘
                     │                               │
                     ▼                               ▼
              ┌──────────┐    ┌──────────┐    ┌──────────┐
              │   GPX    │───▶│ Privacy  │───▶│ Segment  │
              │  Parser  │    │  Filter  │    │ Matcher  │
              └──────────┘    └──────────┘    └────┬─────┘
                                                   │
                     ┌─────────────────────────────┴──────┐
                     ▼                                    ▼
              ┌──────────┐                         ┌──────────┐
              │   Feed   │                         │Leaderboard│
              │Generator │                         │  Update   │
              └──────────┘                         └──────────┘
```

### GPX Parsing Implementation

```javascript
async function parseGPX(gpxContent) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxContent, 'text/xml');
  const trackpoints = doc.querySelectorAll('trkpt');

  const points = [];
  let prevPoint = null;
  let totalDistance = 0;
  let totalElevationGain = 0;

  for (let i = 0; i < trackpoints.length; i++) {
    const trkpt = trackpoints[i];
    const point = {
      index: i,
      latitude: parseFloat(trkpt.getAttribute('lat')),
      longitude: parseFloat(trkpt.getAttribute('lon')),
      altitude: parseFloat(trkpt.querySelector('ele')?.textContent || 0),
      timestamp: new Date(trkpt.querySelector('time')?.textContent),
      heartRate: parseInt(trkpt.querySelector('hr')?.textContent || 0),
    };

    if (prevPoint) {
      const distance = haversineDistance(prevPoint, point);
      totalDistance += distance;

      const elevationChange = point.altitude - prevPoint.altitude;
      if (elevationChange > 0) {
        totalElevationGain += elevationChange;
      }

      const timeDelta = (point.timestamp - prevPoint.timestamp) / 1000;
      point.speed = timeDelta > 0 ? distance / timeDelta : 0;
    }

    points.push(point);
    prevPoint = point;
  }

  return {
    points,
    metrics: {
      distance: totalDistance,
      elevationGain: totalElevationGain,
      elapsedTime: (points[points.length - 1].timestamp - points[0].timestamp) / 1000,
      movingTime: calculateMovingTime(points),
      avgSpeed: totalDistance / calculateMovingTime(points),
    }
  };
}
```

### Privacy Zone Filtering

```javascript
function applyPrivacyZones(gpsPoints, privacyZones) {
  const filtered = [];
  let inPrivacyZone = false;

  for (const point of gpsPoints) {
    const insideAnyZone = privacyZones.some(zone =>
      haversineDistance(
        { lat: point.latitude, lng: point.longitude },
        { lat: zone.center_lat, lng: zone.center_lng }
      ) < zone.radius_meters
    );

    if (insideAnyZone) {
      if (!inPrivacyZone) {
        // Entering privacy zone - mark transition
        inPrivacyZone = true;
        if (filtered.length > 0) {
          filtered[filtered.length - 1].privacyTransition = true;
        }
      }
      // Skip points inside privacy zone
    } else {
      inPrivacyZone = false;
      filtered.push(point);
    }
  }

  return filtered;
}
```

### Idempotent Upload Handling

```javascript
async function handleActivityUpload(userId, gpxContent, idempotencyKey) {
  // Generate content-based hash for deduplication
  const contentHash = crypto
    .createHash('sha256')
    .update(`${userId}:${gpxContent}`)
    .digest('hex');

  const cacheKey = `idem:activity:${idempotencyKey || contentHash}`;

  // Check for existing upload
  const existingActivityId = await redis.get(cacheKey);
  if (existingActivityId) {
    const activity = await db.getActivity(existingActivityId);
    return { activity, duplicate: true };
  }

  // Process new upload
  const { points, metrics } = await parseGPX(gpxContent);
  const privacyZones = await db.getPrivacyZones(userId);
  const filteredPoints = applyPrivacyZones(points, privacyZones);

  // Create activity record
  const activity = await db.createActivity({
    userId,
    ...metrics,
    polyline: encodePolyline(filteredPoints),
    startLat: filteredPoints[0].latitude,
    startLng: filteredPoints[0].longitude,
  });

  // Batch insert GPS points to Cassandra
  await cassandra.batchInsert('gps_points',
    filteredPoints.map(p => ({
      activity_id: activity.id,
      point_index: p.index,
      ...p
    }))
  );

  // Cache for idempotency (24 hour TTL)
  await redis.setex(cacheKey, 86400, activity.id);

  // Publish for async processing
  await kafka.publish('activity.created', {
    activityId: activity.id,
    userId,
    boundingBox: calculateBoundingBox(filteredPoints),
  });

  return { activity, duplicate: false };
}
```

---

## 6. Deep Dive: Segment Matching Algorithm (8 minutes)

### Two-Phase Matching Strategy

```
Phase 1: Coarse Filter (Bounding Box)
┌─────────────────────────────────────────┐
│ Activity Bounding Box                   │
│   ┌───────────┐  ┌────────────────┐    │
│   │ Segment A │  │   Segment B    │    │   ← Candidates
│   │ (match)   │  │   (match)      │    │
│   └───────────┘  └────────────────┘    │
│                         ┌─────────────┐ │
│                         │  Segment C  │ │   ← Candidate
│                         └─────────────┘ │
└─────────────────────────────────────────┘

Phase 2: Fine Matching (GPS Point Comparison)
Only Segment A and C actually traversed by activity
```

### Phase 1: Bounding Box Query

```javascript
async function findCandidateSegments(activity) {
  const { minLat, maxLat, minLng, maxLng, type } = activity;

  // PostGIS spatial query using bounding box intersection
  const candidates = await db.query(`
    SELECT id, polyline, start_lat, start_lng, end_lat, end_lng
    FROM segments
    WHERE activity_type = $1
      AND min_lat <= $2 AND max_lat >= $3
      AND min_lng <= $4 AND max_lng >= $5
  `, [type, maxLat, minLat, maxLng, minLng]);

  return candidates.rows;
}
```

### Phase 2: GPS Point Matching

```javascript
const DISTANCE_THRESHOLD = 25; // meters

function matchSegmentToActivity(segmentPolyline, activityPoints) {
  const segmentPoints = decodePolyline(segmentPolyline);
  const segmentStart = segmentPoints[0];

  // Find activity points near segment start
  const startCandidates = findPointsNear(
    activityPoints,
    segmentStart,
    DISTANCE_THRESHOLD
  );

  for (const startIdx of startCandidates) {
    const matchResult = tryMatchFromPoint(
      activityPoints.slice(startIdx),
      segmentPoints
    );

    if (matchResult.isMatch) {
      return {
        startIndex: startIdx,
        endIndex: startIdx + matchResult.pointsUsed,
        elapsedTime: calculateElapsedTime(
          activityPoints.slice(startIdx, startIdx + matchResult.pointsUsed)
        )
      };
    }
  }

  return null;
}

function tryMatchFromPoint(activityPoints, segmentPoints) {
  let activityIdx = 0;
  let segmentIdx = 0;
  let maxDeviation = 0;

  while (segmentIdx < segmentPoints.length && activityIdx < activityPoints.length) {
    const segPoint = segmentPoints[segmentIdx];
    const actPoint = activityPoints[activityIdx];

    const distance = haversineDistance(segPoint, actPoint);

    if (distance > DISTANCE_THRESHOLD) {
      return { isMatch: false };
    }

    maxDeviation = Math.max(maxDeviation, distance);

    // Advance pointer that's behind
    if (shouldAdvanceActivity(activityPoints, segmentPoints, activityIdx, segmentIdx)) {
      activityIdx++;
    } else {
      segmentIdx++;
    }
  }

  // Check if we completed the segment
  if (segmentIdx >= segmentPoints.length - 1) {
    return { isMatch: true, pointsUsed: activityIdx, maxDeviation };
  }

  return { isMatch: false };
}
```

### Haversine Distance Calculation

```javascript
function haversineDistance(point1, point2) {
  const R = 6371000; // Earth's radius in meters
  const lat1 = toRadians(point1.latitude || point1.lat);
  const lat2 = toRadians(point2.latitude || point2.lat);
  const deltaLat = toRadians((point2.latitude || point2.lat) - (point1.latitude || point1.lat));
  const deltaLng = toRadians((point2.longitude || point2.lng) - (point1.longitude || point1.lng));

  const a = Math.sin(deltaLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
```

---

## 7. Deep Dive: Leaderboard System (5 minutes)

### Redis Sorted Set Operations

```javascript
async function updateLeaderboard(effort) {
  const { segmentId, oderId, elapsedTime } = effort;

  // Check personal record
  const prKey = `pr:${userId}:${segmentId}`;
  const currentPr = await redis.get(prKey);

  if (!currentPr || elapsedTime < parseInt(currentPr)) {
    // New personal record
    await redis.set(prKey, elapsedTime);

    // Update leaderboard (sorted set: lower score = better rank)
    const lbKey = `leaderboard:${segmentId}`;
    await redis.zadd(lbKey, elapsedTime, oderId);

    // Get new rank (0-indexed)
    const rank = await redis.zrank(lbKey, oderId);

    // Mark PR rank if podium finish
    if (rank !== null && rank < 3) {
      await db.updateEffort(effort.id, { prRank: rank + 1 });
    }

    return { isPr: true, rank: rank + 1 };
  }

  return { isPr: false };
}
```

### Leaderboard Query with Filters

```javascript
async function getSegmentLeaderboard(segmentId, options = {}) {
  const { limit = 10, filterType = 'overall', userId } = options;
  const lbKey = `leaderboard:${segmentId}`;

  let entries;

  if (filterType === 'overall') {
    // Overall top N: O(log N + M) where M = limit
    entries = await redis.zrange(lbKey, 0, limit - 1, 'WITHSCORES');
  } else if (filterType === 'friends') {
    // Friends leaderboard: intersection with following set
    const following = await redis.smembers(`following:${userId}`);
    const friendScores = await redis.zmscore(lbKey, ...following);
    entries = following
      .map((id, i) => ({ userId: id, time: friendScores[i] }))
      .filter(e => e.time !== null)
      .sort((a, b) => a.time - b.time)
      .slice(0, limit);
  }

  // Enrich with user details
  const leaderboard = await Promise.all(
    entries.map(async (entry, idx) => {
      const user = await getCachedUser(entry.userId || entry[0]);
      return {
        rank: idx + 1,
        user: { id: user.id, username: user.username, profilePhoto: user.profilePhoto },
        elapsedTime: parseInt(entry.time || entry[1]),
        formattedTime: formatDuration(parseInt(entry.time || entry[1])),
      };
    })
  );

  return leaderboard;
}
```

---

## 8. Activity Feed Generation (4 minutes)

### Fan-Out on Write

```javascript
async function generateFeedEntries(activity) {
  const { id: activityId, userId, startTime } = activity;
  const timestamp = startTime.getTime();

  // Get all followers
  const followers = await db.query(
    'SELECT follower_id FROM follows WHERE following_id = $1',
    [userId]
  );

  // Batch add to follower feeds
  const pipeline = redis.pipeline();

  for (const { follower_id } of followers.rows) {
    const feedKey = `feed:${follower_id}`;

    // Add to sorted set (score = timestamp for ordering)
    pipeline.zadd(feedKey, timestamp, activityId);

    // Trim to keep last 1000 items
    pipeline.zremrangebyrank(feedKey, 0, -1001);
  }

  await pipeline.exec();
}
```

### Feed Retrieval with Pagination

```javascript
async function getActivityFeed(userId, cursor = null, limit = 20) {
  const feedKey = `feed:${userId}`;

  let activityIds;
  if (cursor) {
    // Cursor-based pagination
    activityIds = await redis.zrevrangebyscore(
      feedKey,
      cursor - 1,  // exclusive of cursor
      '-inf',
      'LIMIT', 0, limit
    );
  } else {
    // First page
    activityIds = await redis.zrevrange(feedKey, 0, limit - 1);
  }

  if (activityIds.length === 0) {
    return { activities: [], nextCursor: null };
  }

  // Batch fetch activities
  const activities = await db.query(
    'SELECT * FROM activities WHERE id = ANY($1)',
    [activityIds]
  );

  // Enrich with user data, kudos status, comments preview
  const enriched = await enrichActivities(activities.rows, userId);

  // Get timestamp of last activity for next cursor
  const lastTimestamp = await redis.zscore(feedKey, activityIds[activityIds.length - 1]);

  return {
    activities: enriched,
    nextCursor: activityIds.length === limit ? lastTimestamp : null,
  };
}
```

---

## 9. Trade-offs and Alternatives

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| GPS Storage | Cassandra | High write throughput; harder analytics | TimescaleDB (better queries, more write overhead) |
| Leaderboards | Redis Sorted Sets | O(log N) updates, O(1) rank | PostgreSQL (simpler, slower at scale) |
| Feed Strategy | Fan-out on Write | Fast reads; write amplification | Fan-out on Read (less storage, slow reads) |
| Segment Matching | Synchronous | Immediate results; 30s latency | Async queue (faster upload, delayed results) |
| Privacy Zones | Circular (Haversine) | Simple implementation | Polygon zones (more flexible, complex) |
| Session Storage | Redis | Fast, distributed | JWT (stateless, no server-side revocation) |

---

## 10. Future Optimizations

1. **Sharding Strategy**
   - Activities: Shard by user_id (keeps user's activities together)
   - GPS Points: Shard by activity_id (keeps activity together)
   - Segments: Shard by geographic region (co-locate nearby segments)

2. **Caching Layers**
   - Hot segments cache (frequently matched)
   - User profile cache (30-minute TTL)
   - Activity details cache (24-hour TTL)

3. **Background Processing**
   - Kafka consumers for segment matching
   - Separate workers for feed generation
   - Async achievement checking

4. **GPS Data Lifecycle**
   - Full resolution: 1 year
   - Downsampled (1/5 points): 1+ years
   - Polyline preserved indefinitely

---

## Summary

"To summarize the backend architecture:

1. **Multi-database strategy** - PostgreSQL for relational data with PostGIS for geospatial queries, Cassandra for high-volume GPS time-series, Redis for leaderboards and feeds

2. **Two-phase segment matching** - Bounding box filter reduces candidates by 99%, then precise GPS point comparison with 25m Haversine threshold

3. **Redis sorted sets for leaderboards** - O(log N) insertions, O(1) rank lookups, with personal record tracking

4. **Fan-out on write feeds** - Trade write amplification for fast reads, suitable for typical follower counts

5. **Idempotent uploads** - Content-based hashing prevents duplicate activities from retry-prone mobile uploads

The key insight is separating storage by access pattern: PostgreSQL for complex queries, Cassandra for write-heavy GPS data, and Redis for real-time rankings."
