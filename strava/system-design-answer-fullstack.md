# Strava - Fitness Tracking Platform - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 🎯 Introduction (2 minutes)

"Thanks for this problem. I'll be designing a fitness tracking platform like Strava, focusing on the end-to-end integration between GPS data capture, backend processing, and frontend visualization. This involves the complete activity upload flow, segment matching pipeline, and real-time leaderboard updates. Let me clarify requirements."

---

## ✅ 1. Requirements Clarification (5 minutes)

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

## 🛠️ 2. Technology Stack (3 minutes)

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 19 + Vite + TypeScript | Type safety, fast development |
| Backend | Node.js + Express + TypeScript | Unified language, type sharing |
| Database | PostgreSQL + Redis | Relational + cache/leaderboards |
| Maps | Leaflet (frontend) | Open source, React integration |
| API | REST + JSON | Simple, widely understood |
| Validation | Zod (shared) | Runtime + compile-time safety |

---

## 🏗️ 3. System Architecture (5 minutes)

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

## 🧩 4. Shared Contract Between Client and Server (5 minutes)

"I define the domain types once, as Zod schemas in a shared directory both sides
import. That gives runtime validation on the server and inferred TypeScript
types on the client from a single declaration."

### Core domain objects

| Type | Key fields | Notes |
|------|-----------|-------|
| `ActivityType` | `run` \| `ride` \| `hike` \| `walk` | Drives pace vs speed display and which segments are eligible |
| `GpsPoint` | index, lat, lng, timestamp; optional altitude, speed, heartRate | The raw stream; optional fields reflect that not every device records them |
| `Activity` | id, userId, type, name, startTime, elapsedTime, movingTime, distance, elevationGain, avg/max speed, encoded polyline, start/end coordinates, kudos and comment counts | Everything the feed card needs without a join |
| `ActivityWithUser` | `Activity` plus a nested `{ id, username, profilePhoto }` | The feed's wire shape — see the note on denormalization below |
| `Segment` | id, creatorId, name, activityType, distance, elevationGain, polyline, start/end coordinates, effortCount, athleteCount | Created once, matched against forever |
| `SegmentEffort` | id, segmentId, activityId, userId, elapsedTime, movingTime, prRank, createdAt | One row per traversal; `prRank` is 1/2/3 or null |
| `LeaderboardEntry` | rank, user summary, elapsedTime, formattedTime, isPR | Built for rendering, not storage |

### Envelope types

Pagination is cursor-based everywhere: `{ items, nextCursor, hasMore }`. The
upload endpoint returns a richer envelope — the created activity, the segment
efforts it produced, and a `newPRs` list carrying segment name, new rank, and
previous time — because the client needs all three to render the
"You set a PR!" celebration without a second round trip.

> "Two decisions are embedded in these shapes. First, `Activity` carries
> denormalized `kudosCount` and `commentCount` rather than the client counting
> rows — a feed of 50 activities would otherwise mean 100 aggregate queries.
> Second, `ActivityWithUser` nests only three user fields rather than the whole
> user object. That's deliberate: it's the exact set the feed card renders, and
> keeping it minimal means a user's bio or email never accidentally ships to
> every follower's feed."

The cost of a shared schema package is coupling — a breaking change to
`Activity` breaks both deploys at once, so the two have to ship together or the
change has to be additive. For a single team that's a fair trade for never
having the client and server disagree about a field's nullability.

---


## 🔧 5. Deep Dive: Activity Upload Flow (10 minutes)

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

## 🏆 6. Deep Dive: Leaderboard Sync (8 minutes)

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

## 📰 7. Activity Feed Integration (5 minutes)

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

## 🧮 8. Shared Utilities (4 minutes)

"A handful of pure functions live in the shared package because both sides need
the identical answer — if the client and server compute distance differently,
the number on the activity card won't match the number in the leaderboard."

| Utility | Input → Output | Why it's shared |
|---------|----------------|-----------------|
| `haversineDistance` | two lat/lng points → metres | Great-circle distance over a spherical Earth (R = 6,371 km). The server uses it to total an activity; the client uses it for live distance during recording |
| `formatDuration` | seconds → `H:MM:SS` or `M:SS` | Drops the hour component under an hour, which is what runners expect |
| `formatDistance` | metres → `X.XX km` or `X m` | Switches unit at 1 km |
| `formatPace` | metres + seconds → `M:SS /km` | Pace, not speed, for foot sports — the inverse of what cycling shows |
| `encodePolyline` / `decodePolyline` | point array ⇄ string | Google's encoded-polyline format |

### Why polyline encoding matters here

An hour-long run at 1 Hz is ~3,600 GPS points. Sent as JSON objects with full
float precision that's roughly 300 KB per activity — and a feed page of 20
activities would be 6 MB of coordinates for maps rendered a few hundred pixels
wide.

Encoding fixes this with two ideas: store each coordinate as a **delta** from
the previous one rather than an absolute, and round to five decimal places
(~1 metre). Deltas between consecutive GPS samples are tiny, and small numbers
encode to fewer characters, so the string lands around 10× smaller than the raw
array.

> "The trade-off is precision loss and opacity. Five decimals means roughly a
> metre of error, which is well inside consumer GPS noise, so it costs nothing
> real. The bigger cost is that the polyline is opaque — you cannot query it. I
> can't ask the database 'which activities passed through this bounding box'
> against an encoded string, which is exactly why `Activity` also carries
> explicit `startLat/Lng` and `endLat/Lng` columns and why segment matching
> works off the separate GPS-point stream rather than the polyline. The
> polyline is a *rendering* artifact, and I keep it strictly in that role."

---


## ⚖️ 9. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Type Sharing | Zod schemas in shared/ | Build step required | OpenAPI codegen |
| API Style | REST | Familiar; multiple requests | GraphQL (single query) |
| State Sync | TanStack Query | Cache invalidation | WebSocket real-time |
| File Upload | Multipart form | Browser native | Chunked uploads |
| Leaderboard | Redis sorted sets | In-memory limits | PostgreSQL with indexes |
| Feed Strategy | Fan-out on write | Write amplification | Fan-out on read |

---

## 🚀 10. Future Enhancements

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

## 📌 Summary

"To summarize the full-stack architecture:

1. **Shared TypeScript types** - Zod schemas define API contracts between frontend and backend, ensuring type safety across the stack

2. **End-to-end upload flow** - Client-side GPX preview for immediate feedback, server-side processing for segment matching and leaderboard updates, response includes PR notifications

3. **Redis for real-time features** - Sorted sets for O(log N) leaderboard updates, feed caching with fan-out on write, session storage

4. **TanStack Query for data sync** - Caching with stale-while-revalidate, infinite scroll with cursor pagination, optimistic updates for kudos

5. **Shared utilities** - Haversine distance, polyline encoding, duration formatting used by both frontend and backend

The key insight is maintaining a clean API boundary with shared types while keeping domain logic (segment matching, leaderboard calculation) on the backend and presentation logic (map rendering, virtualization) on the frontend."
