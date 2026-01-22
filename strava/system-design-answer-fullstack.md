# Strava - Fitness Tracking Platform - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a fitness tracking platform like Strava, focusing on the end-to-end integration between GPS data capture, backend processing, and frontend visualization. This involves the complete activity upload flow, segment matching pipeline, and real-time leaderboard updates. Let me clarify requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements (Full-Stack Perspective)

1. **Activity Upload Flow** - GPX upload with client-side preview, server processing, and result display
2. **Segment Matching Pipeline** - End-to-end flow from upload to leaderboard update
3. **Real-time Feed** - Activity feed with social interactions (kudos, comments)
4. **Leaderboard Integration** - Frontend display synced with backend rankings
5. **User Statistics** - Aggregated stats computed on backend, displayed on frontend
6. **Achievement System** - Server-side rules, client-side notifications

### Non-Functional Requirements

- **Consistency** - Leaderboard updates visible within 5 seconds of activity processing
- **Type Safety** - Shared TypeScript types between frontend and backend
- **Error Handling** - Graceful degradation with user-friendly messages
- **Developer Experience** - Hot reload, unified tooling, consistent patterns

### Integration Points

- API contracts between React frontend and Express backend
- Shared type definitions for activities, segments, users
- Real-time updates via polling (WebSocket future)
- File upload with progress tracking

---

## 2. Technology Stack (3 minutes)

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 19 + Vite + TypeScript | Type safety, fast development |
| Backend | Node.js + Express + TypeScript | Unified language, type sharing |
| Database | PostgreSQL + Redis | Relational + cache/leaderboards |
| Maps | Leaflet (frontend) | Open source, React integration |
| API | REST + JSON | Simple, widely understood |
| Validation | Zod (shared) | Runtime + compile-time safety |

---

## 3. System Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Frontend                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   React     │  │  TanStack   │  │  Zustand    │  │  Leaflet    │    │
│  │   + Vite    │  │   Router    │  │   Store     │  │   Maps      │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │            │
│         └────────────────┴────────────────┴────────────────┘            │
│                                   │                                      │
│                          Shared Types (TypeScript)                       │
│                                   │                                      │
└───────────────────────────────────┼──────────────────────────────────────┘
                                    │ HTTP/JSON
                                    ▼
┌───────────────────────────────────┼──────────────────────────────────────┐
│                              Backend                                      │
│                                   │                                       │
│  ┌─────────────┐  ┌─────────────┐ │ ┌─────────────┐  ┌─────────────┐     │
│  │   Express   │  │   Auth      │ │ │  Activity   │  │  Segment    │     │
│  │   Server    │  │   Routes    │ │ │   Routes    │  │   Routes    │     │
│  └──────┬──────┘  └──────┬──────┘ │ └──────┬──────┘  └──────┬──────┘     │
│         │                │        │        │                │            │
│         └────────────────┴────────┴────────┴────────────────┘            │
│                                   │                                       │
│  ┌─────────────┐  ┌─────────────┐ │ ┌─────────────┐  ┌─────────────┐     │
│  │   GPX       │  │  Segment    │ │ │ Leaderboard │  │   Feed      │     │
│  │  Parser     │  │  Matcher    │ │ │  Service    │  │  Generator  │     │
│  └──────┬──────┘  └──────┬──────┘ │ └──────┬──────┘  └──────┬──────┘     │
└─────────┼────────────────┼────────┼────────┼────────────────┼────────────┘
          │                │        │        │                │
          ▼                ▼        │        ▼                ▼
┌─────────────────┐  ┌─────────────┐│  ┌─────────────────────────────────┐
│   PostgreSQL    │  │   Redis     ││  │      Shared Domain Logic        │
│   + PostGIS     │  │  Leaderboards│  │   - Haversine distance          │
│                 │  │  + Sessions ││  │   - Polyline encode/decode      │
│ - Users         │  │  + Feeds    ││  │   - Duration formatting         │
│ - Activities    │  │             ││  └─────────────────────────────────┘
│ - GPS Points    │  │             ││
│ - Segments      │  │             ││
└─────────────────┘  └─────────────┘│
```

---

## 4. Shared Type Definitions (5 minutes)

### Core Domain Types

"I'm using Zod schemas in a shared directory that both frontend and backend can import. This gives us runtime validation plus TypeScript inference."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ACTIVITY TYPE SCHEMA (Zod)                           │
├─────────────────────────────────────────────────────────────────────────┤
│  ActivityType: 'run' | 'ride' | 'hike' | 'walk'                         │
├─────────────────────────────────────────────────────────────────────────┤
│  GpsPoint: {                                                             │
│    index: number, latitude: number, longitude: number,                   │
│    altitude?: number, timestamp: datetime,                               │
│    speed?: number, heartRate?: number                                    │
│  }                                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  Activity: {                                                             │
│    id: uuid, userId: uuid, type: ActivityType, name: string,            │
│    startTime: datetime, elapsedTime: number, movingTime: number,        │
│    distance: number (meters), elevationGain: number,                    │
│    avgSpeed: number, maxSpeed: number, avgHeartRate?: number,           │
│    polyline: string (encoded), startLat/Lng, endLat/Lng,                │
│    kudosCount: number, commentCount: number, hasKudos?: boolean         │
│  }                                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  ActivityWithUser: Activity + { user: { id, username, profilePhoto } }  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Segment Types

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SEGMENT SCHEMAS                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  Segment: {                                                              │
│    id: uuid, creatorId: uuid, name: string,                             │
│    activityType: ActivityType, distance: number, elevationGain: number, │
│    polyline: string, startLat/Lng, endLat/Lng,                          │
│    effortCount: number, athleteCount: number                            │
│  }                                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  SegmentEffort: {                                                        │
│    id: uuid, segmentId: uuid, activityId: uuid, userId: uuid,           │
│    elapsedTime: number, movingTime: number,                             │
│    prRank: 1|2|3|null, createdAt: datetime                              │
│  }                                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  LeaderboardEntry: {                                                     │
│    rank: number, user: { id, username, profilePhoto },                  │
│    elapsedTime: number, formattedTime: string, isPR?: boolean           │
│  }                                                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### API Response Types

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     API RESPONSE SCHEMAS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  PaginatedResponse<T>: { items: T[], nextCursor: string|null,           │
│                          hasMore: boolean }                              │
├─────────────────────────────────────────────────────────────────────────┤
│  FeedResponse: { activities: ActivityWithUser[],                        │
│                  nextCursor: string|null }                              │
├─────────────────────────────────────────────────────────────────────────┤
│  UploadResponse: { activity: Activity, segmentEfforts: SegmentEffort[], │
│    newPRs: [{ segmentId, segmentName, rank, previousTime, newTime }] }  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Activity Upload Flow (10 minutes)

### End-to-End Upload Sequence

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  React   │    │  Express │    │   GPX    │    │ Segment  │    │  Redis   │
│  Upload  │    │  Server  │    │  Parser  │    │ Matcher  │    │  Cache   │
└────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘
     │               │               │               │               │
     │ 1. Select GPX │               │               │               │
     ├──────────────▶│               │               │               │
     │               │               │               │               │
     │ 2. Preview    │               │               │               │
     │    (client)   │               │               │               │
     │               │               │               │               │
     │ 3. POST /upload               │               │               │
     ├──────────────▶│               │               │               │
     │               │ 4. Parse GPX  │               │               │
     │               ├──────────────▶│               │               │
     │               │◀──────────────┤               │               │
     │               │    points[]   │               │               │
     │               │               │               │               │
     │               │ 5. Privacy filter             │               │
     │               ├──────────────────────────────▶│               │
     │               │               │               │               │
     │               │ 6. Find segments              │               │
     │               ├──────────────────────────────▶│               │
     │               │◀──────────────────────────────┤               │
     │               │   efforts[]   │               │               │
     │               │               │               │               │
     │               │ 7. Update leaderboards        │               │
     │               ├──────────────────────────────────────────────▶│
     │               │               │               │               │
     │               │ 8. Generate feed entries      │               │
     │               ├──────────────────────────────────────────────▶│
     │               │               │               │               │
     │◀──────────────┤               │               │               │
     │ 9. UploadResponse             │               │               │
     │    (activity + efforts + PRs) │               │               │
     │               │               │               │               │
     │ 10. Navigate  │               │               │               │
     │    to detail  │               │               │               │
     ▼               ▼               ▼               ▼               ▼
```

### Frontend Upload Component

"I'm using TanStack Query's useMutation for the upload. On success, it shows PR notifications and navigates to the activity detail page."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     UPLOAD PAGE COMPONENT                                │
├─────────────────────────────────────────────────────────────────────────┤
│  State:                                                                  │
│    - file: File | null                                                   │
│    - preview: ActivityPreview | null                                     │
│                                                                          │
│  useMutation<UploadResponse>:                                            │
│    - mutationFn: POST /api/activities/upload (FormData)                  │
│    - onSuccess: showPRNotifications + navigate to /activity/$id          │
│                                                                          │
│  handleFileSelect(file):                                                 │
│    1. setFile(file)                                                      │
│    2. Parse GPX client-side for preview                                  │
│    3. setPreview(parsed)                                                 │
│                                                                          │
│  handleSubmit(metadata):                                                 │
│    1. Create FormData with file + name + type                            │
│    2. uploadMutation.mutate(formData)                                    │
│                                                                          │
│  Render:                                                                 │
│    - !file: <FileDropzone />                                             │
│    - file: <UploadForm preview={preview} onSubmit={handleSubmit} />      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Backend Upload Handler

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     POST /upload HANDLER                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Parse GPX file                                                       │
│     ──▶ { points[], metrics }                                            │
│                                                                          │
│  2. Apply privacy zones                                                  │
│     ──▶ filteredPoints = applyPrivacyZones(points, userZones)            │
│                                                                          │
│  3. Create activity record                                               │
│     ──▶ INSERT INTO activities (userId, name, type, metrics,             │
│           polyline: encodePolyline(filteredPoints),                      │
│           startLat/Lng, endLat/Lng)                                      │
│                                                                          │
│  4. Store GPS points                                                     │
│     ──▶ batchInsertGpsPoints(activityId, filteredPoints)                 │
│                                                                          │
│  5. Match segments                                                       │
│     ──▶ segmentEfforts = matchSegments(activity, filteredPoints)         │
│                                                                          │
│  6. Update leaderboards + track PRs                                      │
│     ──▶ FOR EACH effort: updateLeaderboard(effort)                       │
│         IF isPR: push to newPRs[]                                        │
│                                                                          │
│  7. Generate feed entries                                                │
│     ──▶ generateFeedEntries(activity) // fan-out to followers           │
│                                                                          │
│  8. Check achievements                                                   │
│     ──▶ checkAchievements(userId)                                        │
│                                                                          │
│  Response: { activity, segmentEfforts, newPRs }                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Segment Matching Service

"I use a two-phase approach. First, bounding box filtering eliminates 99% of segments. Then precise Haversine matching on candidates."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SEGMENT MATCHING ALGORITHM                           │
├─────────────────────────────────────────────────────────────────────────┤
│  DISTANCE_THRESHOLD = 25 meters                                          │
│                                                                          │
│  Phase 1: Bounding Box Filter                                            │
│  ────────────────────────────────                                        │
│    SELECT id, polyline, start_lat/lng, end_lat/lng                       │
│    FROM segments                                                         │
│    WHERE activity_type = $type                                           │
│      AND min_lat <= activity.maxLat AND max_lat >= activity.minLat       │
│      AND min_lng <= activity.maxLng AND max_lng >= activity.minLng       │
│                                                                          │
│  Phase 2: Precise Matching                                               │
│  ────────────────────────────                                            │
│    FOR EACH candidate segment:                                           │
│      1. Decode segment polyline to points                                │
│      2. Find activity points within THRESHOLD of segment start           │
│      3. Attempt match from each start candidate                          │
│      4. If matched: calculate elapsedTime, movingTime                    │
│      5. Save SegmentEffort, increment segment stats                      │
│                                                                          │
│  matchSingleSegment():                                                   │
│    - findPointsNear(activityPoints, segmentStart, THRESHOLD)             │
│    - FOR EACH startIdx: tryMatch(slice from startIdx, segmentPoints)     │
│    - IF matched: return { startIndex, endIndex, elapsedTime, movingTime }│
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Leaderboard Sync (8 minutes)

### Backend Leaderboard Update

"Redis sorted sets are perfect here. Lower time = better ranking, and we get O(log N) insertions with O(1) rank lookups."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     LEADERBOARD UPDATE FLOW                              │
├─────────────────────────────────────────────────────────────────────────┤
│  updateLeaderboard(effort) ──▶ LeaderboardUpdateResult                   │
│                                                                          │
│  1. Check personal record                                                │
│     ──▶ prKey = "pr:{userId}:{segmentId}"                                │
│     ──▶ currentPR = redis.GET(prKey)                                     │
│                                                                          │
│  2. IF no current PR OR elapsedTime < currentPR:                         │
│     ──▶ redis.SET(prKey, elapsedTime)          // New personal record    │
│     ──▶ redis.ZADD("leaderboard:{segmentId}", elapsedTime, oderId)       │
│     ──▶ rank = redis.ZRANK("leaderboard:{segmentId}", oderId)            │
│     ──▶ IF rank < 3: UPDATE effort SET prRank = rank + 1                 │
│     ──▶ RETURN { isPR: true, rank: rank + 1, previousTime }              │
│                                                                          │
│  3. ELSE:                                                                │
│     ──▶ RETURN { isPR: false, rank: null, previousTime }                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     GET LEADERBOARD                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  getLeaderboard(segmentId, { limit, filter, userId })                    │
│                                                                          │
│  IF filter == 'overall':                                                 │
│    ──▶ redis.ZRANGE("leaderboard:{segmentId}", 0, limit-1, WITHSCORES)  │
│                                                                          │
│  IF filter == 'friends':                                                 │
│    ──▶ following = db.getFollowing(userId)                               │
│    ──▶ scores = redis.ZMSCORE(lbKey, ...followingIds)                    │
│    ──▶ Sort by score, slice to limit                                     │
│                                                                          │
│  Enrich with user data:                                                  │
│    ──▶ FOR EACH [userId, time]: getCachedUser(userId)                    │
│    ──▶ RETURN [{ rank, user, elapsedTime, formattedTime }]               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend Leaderboard Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     SEGMENT LEADERBOARD COMPONENT                        │
├─────────────────────────────────────────────────────────────────────────┤
│  Props: { segmentId: string }                                            │
│  State: filter = 'overall' | 'friends'                                   │
│                                                                          │
│  useQuery(['leaderboard', segmentId, filter]):                           │
│    - GET /api/segments/{segmentId}/leaderboard?filter={filter}           │
│    - staleTime: 30_000 (30 seconds)                                      │
│    - refetchOnWindowFocus: true                                          │
│                                                                          │
│  Derived:                                                                │
│    - myEntry = leaderboard.find(e => e.user.id === user.id)              │
│                                                                          │
│  Render:                                                                 │
│    ┌──────────────────────────────────────────────────┐                  │
│    │ [All Athletes] [Following]       ← Filter Tabs   │                  │
│    ├──────────────────────────────────────────────────┤                  │
│    │ 1. 🥇 Alice     4:32   ← LeaderboardRow          │                  │
│    │ 2. 🥈 Bob       4:45                             │                  │
│    │ 3. 🥉 Carol     5:01                             │                  │
│    │ ...                                              │                  │
│    ├──────────────────────────────────────────────────┤                  │
│    │ Your rank: 47. You   6:23   ← If not in top 10  │                  │
│    └──────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Activity Feed Integration (5 minutes)

### Backend Feed Generation

"I use fan-out on write. When an activity is created, I push it to all followers' feeds in Redis. This trades write amplification for fast reads."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     FEED GENERATION (Fan-out on Write)                   │
├─────────────────────────────────────────────────────────────────────────┤
│  generateFeedEntries(activity):                                          │
│                                                                          │
│  1. Get all followers                                                    │
│     ──▶ SELECT follower_id FROM follows WHERE following_id = $userId     │
│                                                                          │
│  2. Batch update Redis feeds                                             │
│     ──▶ pipeline = redis.pipeline()                                      │
│     ──▶ FOR EACH follower:                                               │
│           pipeline.ZADD("feed:{followerId}", timestamp, activityId)     │
│           pipeline.ZREMRANGEBYRANK("feed:{followerId}", 0, -1001)       │
│                                       // Keep last 1000 entries          │
│     ──▶ pipeline.exec()                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     GET FEED                                             │
├─────────────────────────────────────────────────────────────────────────┤
│  getFeed(userId, cursor?, limit = 20) ──▶ FeedResponse                   │
│                                                                          │
│  1. Get activity IDs from Redis                                          │
│     ──▶ IF cursor: ZREVRANGEBYSCORE("feed:{userId}", cursor, -inf)      │
│     ──▶ ELSE: ZREVRANGE("feed:{userId}", 0, limit-1)                     │
│                                                                          │
│  2. Batch fetch activities with user data                                │
│     ──▶ SELECT a.*, u.username, u.profile_photo,                         │
│               EXISTS(SELECT 1 FROM kudos ...) as has_kudos               │
│         FROM activities a JOIN users u                                   │
│         WHERE a.id = ANY($activityIds)                                   │
│         ORDER BY a.start_time DESC                                       │
│                                                                          │
│  3. Get next cursor                                                      │
│     ──▶ lastTimestamp = ZSCORE("feed:{userId}", lastActivityId)          │
│                                                                          │
│  Response: { activities, nextCursor }                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend Feed with Infinite Scroll

"I combine TanStack Query's useInfiniteQuery with TanStack Virtual for efficient rendering of large feeds."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     FEED PAGE COMPONENT                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  useInfiniteQuery<FeedResponse>(['feed']):                               │
│    - queryFn: GET /api/feed?cursor={pageParam}                           │
│    - getNextPageParam: (lastPage) => lastPage.nextCursor                 │
│    - staleTime: 60_000 (1 minute)                                        │
│                                                                          │
│  Derived:                                                                │
│    - allActivities = data.pages.flatMap(p => p.activities)               │
│                                                                          │
│  Virtualization:                                                         │
│    - useVirtualizer({                                                    │
│        count: hasNextPage ? allActivities.length + 1 : allActivities.length,
│        getScrollElement: () => parentRef.current,                        │
│        estimateSize: () => 450,  // Estimated card height                │
│        overscan: 3               // Extra items above/below viewport     │
│      })                                                                  │
│                                                                          │
│  Auto-load more:                                                         │
│    - useEffect: IF lastItem.index >= allActivities.length - 1            │
│                 AND hasNextPage AND !isFetchingNextPage                  │
│                 THEN fetchNextPage()                                     │
│                                                                          │
│  Render:                                                                 │
│    ┌──────────────────────────────────────────────────┐                  │
│    │ <div style={{ height: virtualizer.getTotalSize() }}>               │
│    │   {virtualizer.getVirtualItems().map(row =>                        │
│    │     <ActivityCard activity={allActivities[row.index]} />           │
│    │   )}                                                                │
│    │ </div>                                                              │
│    └──────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Shared Utilities (4 minutes)

### Geospatial Calculations

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     HAVERSINE DISTANCE                                   │
├─────────────────────────────────────────────────────────────────────────┤
│  haversineDistance(point1, point2) ──▶ meters                            │
│                                                                          │
│  R = 6371000 (Earth's radius in meters)                                  │
│                                                                          │
│  Convert to radians:                                                     │
│    lat1, lat2 = toRad(point1.lat), toRad(point2.lat)                    │
│    deltaLat = toRad(point2.lat - point1.lat)                            │
│    deltaLng = toRad(point2.lng - point1.lng)                            │
│                                                                          │
│  Haversine formula:                                                      │
│    a = sin(deltaLat/2)^2 + cos(lat1)*cos(lat2)*sin(deltaLng/2)^2        │
│    c = 2 * atan2(sqrt(a), sqrt(1-a))                                    │
│    distance = R * c                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Duration & Distance Formatting

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     FORMAT UTILITIES                                     │
├─────────────────────────────────────────────────────────────────────────┤
│  formatDuration(seconds) ──▶ "H:MM:SS" or "M:SS"                        │
│    hours = floor(seconds / 3600)                                        │
│    minutes = floor((seconds % 3600) / 60)                               │
│    secs = seconds % 60                                                  │
│    IF hours > 0: return "{hours}:{minutes:02}:{secs:02}"                │
│    ELSE: return "{minutes}:{secs:02}"                                   │
│                                                                          │
│  formatDistance(meters) ──▶ "X.XX km" or "X m"                          │
│    IF meters >= 1000: return "{meters/1000:.2f} km"                     │
│    ELSE: return "{round(meters)} m"                                     │
│                                                                          │
│  formatPace(distanceMeters, timeSeconds) ──▶ "M:SS /km"                 │
│    paceSecondsPerKm = (timeSeconds / distanceMeters) * 1000             │
│    minutes = floor(paceSecondsPerKm / 60)                               │
│    seconds = round(paceSecondsPerKm % 60)                               │
│    return "{minutes}:{seconds:02} /km"                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Polyline Encoding/Decoding

"Polyline encoding compresses GPS coordinates by ~10x by using delta encoding and variable-length encoding."

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     POLYLINE ENCODING                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  encodePolyline(points: [lat, lng][]) ──▶ string                        │
│                                                                          │
│  1. Track previous lat/lng (start at 0, 0)                               │
│  2. FOR EACH [lat, lng]:                                                 │
│       - Scale to 5 decimal places: latE5 = round(lat * 1e5)              │
│       - Compute delta: delta = latE5 - prevLat                           │
│       - Encode delta as variable-length chars                            │
│       - Repeat for longitude                                             │
│       - Update prev values                                               │
│  3. Return encoded string                                                │
│                                                                          │
│  decodePolyline(encoded: string) ──▶ [lat, lng][]                       │
│                                                                          │
│  1. Initialize lat = 0, lng = 0, index = 0                               │
│  2. WHILE index < encoded.length:                                        │
│       - Decode lat delta, add to lat                                     │
│       - Decode lng delta, add to lng                                     │
│       - Push [lat/1e5, lng/1e5] to points                                │
│  3. Return points array                                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Trade-offs and Alternatives

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Type Sharing | Zod schemas in shared/ | Build step required | OpenAPI codegen |
| API Style | REST | Familiar; multiple requests | GraphQL (single query) |
| State Sync | TanStack Query | Cache invalidation | WebSocket real-time |
| File Upload | Multipart form | Browser native | Chunked uploads |
| Leaderboard | Redis sorted sets | In-memory limits | PostgreSQL with indexes |
| Feed Strategy | Fan-out on write | Write amplification | Fan-out on read |

---

## 10. Future Enhancements

1. **Real-time Updates**
   - WebSocket for live kudos/comments
   - Server-Sent Events for leaderboard changes
   - Optimistic UI with rollback

2. **Offline Support**
   - Service Worker for feed caching
   - Background sync for pending kudos
   - IndexedDB for activity drafts

3. **Performance**
   - Edge caching for leaderboards
   - Precomputed segment stats
   - Worker threads for GPX parsing

4. **Mobile**
   - React Native shared components
   - Background GPS recording
   - Push notifications for PRs

---

## Summary

"To summarize the full-stack architecture:

1. **Shared TypeScript types** - Zod schemas define API contracts between frontend and backend, ensuring type safety across the stack

2. **End-to-end upload flow** - Client-side GPX preview for immediate feedback, server-side processing for segment matching and leaderboard updates, response includes PR notifications

3. **Redis for real-time features** - Sorted sets for O(log N) leaderboard updates, feed caching with fan-out on write, session storage

4. **TanStack Query for data sync** - Caching with stale-while-revalidate, infinite scroll with cursor pagination, optimistic updates for kudos

5. **Shared utilities** - Haversine distance, polyline encoding, duration formatting used by both frontend and backend

The key insight is maintaining a clean API boundary with shared types while keeping domain logic (segment matching, leaderboard calculation) on the backend and presentation logic (map rendering, virtualization) on the frontend."
