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
│  ┌─────────────┐  ┌─────────────┐│┌─────────────┐  ┌─────────────┐      │
│  │   Express   │  │   Auth      │││  Activity   │  │  Segment    │      │
│  │   Server    │  │   Routes    │││   Routes    │  │   Routes    │      │
│  └──────┬──────┘  └──────┬──────┘│└──────┬──────┘  └──────┬──────┘      │
│         │                │       ││       │                │             │
│         └────────────────┴───────┴┴───────┴────────────────┘             │
│                                   │                                       │
│  ┌─────────────┐  ┌─────────────┐ │ ┌─────────────┐  ┌─────────────┐    │
│  │   GPX       │  │  Segment    │ │ │ Leaderboard │  │   Feed      │    │
│  │  Parser     │  │  Matcher    │ │ │  Service    │  │  Generator  │    │
│  └──────┬──────┘  └──────┬──────┘ │ └──────┬──────┘  └──────┬──────┘    │
└─────────┼────────────────┼────────┼────────┼────────────────┼───────────┘
          │                │        │        │                │
          ▼                ▼        │        ▼                ▼
┌─────────────────┐  ┌─────────────┐│ ┌─────────────────────────────────┐
│   PostgreSQL    │  │   Redis     ││ │      Shared Domain Logic        │
│   + PostGIS     │  │  Leaderboards│ │   - Haversine distance          │
│                 │  │  + Sessions ││ │   - Polyline encode/decode      │
│ - Users         │  │  + Feeds    ││ │   - Duration formatting         │
│ - Activities    │  │             ││ └─────────────────────────────────┘
│ - GPS Points    │  │             ││
│ - Segments      │  │             ││
└─────────────────┘  └─────────────┘│
```

---

## 4. Shared Type Definitions (5 minutes)

### Core Domain Types

```typescript
// shared/types/activity.ts
import { z } from 'zod';

export const ActivityTypeSchema = z.enum(['run', 'ride', 'hike', 'walk']);
export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const GpsPointSchema = z.object({
  index: z.number(),
  latitude: z.number(),
  longitude: z.number(),
  altitude: z.number().optional(),
  timestamp: z.string().datetime(),
  speed: z.number().optional(),
  heartRate: z.number().optional(),
});
export type GpsPoint = z.infer<typeof GpsPointSchema>;

export const ActivitySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: ActivityTypeSchema,
  name: z.string(),
  startTime: z.string().datetime(),
  elapsedTime: z.number(), // seconds
  movingTime: z.number(),
  distance: z.number(), // meters
  elevationGain: z.number(),
  avgSpeed: z.number(),
  maxSpeed: z.number(),
  avgHeartRate: z.number().optional(),
  polyline: z.string(), // encoded
  startLat: z.number(),
  startLng: z.number(),
  endLat: z.number(),
  endLng: z.number(),
  kudosCount: z.number(),
  commentCount: z.number(),
  hasKudos: z.boolean().optional(), // Viewer-specific
  createdAt: z.string().datetime(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const ActivityWithUserSchema = ActivitySchema.extend({
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    profilePhoto: z.string().nullable(),
  }),
});
export type ActivityWithUser = z.infer<typeof ActivityWithUserSchema>;
```

### Segment Types

```typescript
// shared/types/segment.ts
export const SegmentSchema = z.object({
  id: z.string().uuid(),
  creatorId: z.string().uuid(),
  name: z.string(),
  activityType: ActivityTypeSchema,
  distance: z.number(),
  elevationGain: z.number(),
  polyline: z.string(),
  startLat: z.number(),
  startLng: z.number(),
  endLat: z.number(),
  endLng: z.number(),
  effortCount: z.number(),
  athleteCount: z.number(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const SegmentEffortSchema = z.object({
  id: z.string().uuid(),
  segmentId: z.string().uuid(),
  activityId: z.string().uuid(),
  userId: z.string().uuid(),
  elapsedTime: z.number(),
  movingTime: z.number(),
  prRank: z.number().nullable(), // 1, 2, 3 for podium
  createdAt: z.string().datetime(),
});
export type SegmentEffort = z.infer<typeof SegmentEffortSchema>;

export const LeaderboardEntrySchema = z.object({
  rank: z.number(),
  user: z.object({
    id: z.string().uuid(),
    username: z.string(),
    profilePhoto: z.string().nullable(),
  }),
  elapsedTime: z.number(),
  formattedTime: z.string(),
  isPR: z.boolean().optional(),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
```

### API Response Types

```typescript
// shared/types/api.ts
export const PaginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

export const FeedResponseSchema = z.object({
  activities: z.array(ActivityWithUserSchema),
  nextCursor: z.string().nullable(),
});
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

export const UploadResponseSchema = z.object({
  activity: ActivitySchema,
  segmentEfforts: z.array(SegmentEffortSchema),
  newPRs: z.array(z.object({
    segmentId: z.string().uuid(),
    segmentName: z.string(),
    rank: z.number(),
    previousTime: z.number().nullable(),
    newTime: z.number(),
  })),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
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

```tsx
// frontend/src/routes/upload.tsx
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { UploadResponse } from '@shared/types/api';

export function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ActivityPreview | null>(null);
  const navigate = useNavigate();

  const uploadMutation = useMutation<UploadResponse, Error, FormData>({
    mutationFn: async (formData) => {
      const response = await fetch('/api/activities/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Upload failed');
      }

      return response.json();
    },
    onSuccess: (data) => {
      // Show PR notifications
      if (data.newPRs.length > 0) {
        showPRNotifications(data.newPRs);
      }
      navigate({ to: '/activity/$id', params: { id: data.activity.id } });
    },
  });

  const handleFileSelect = async (file: File) => {
    setFile(file);

    // Client-side preview parsing
    const content = await file.text();
    const preview = parseGPXPreview(content);
    setPreview(preview);
  };

  const handleSubmit = (metadata: ActivityMetadata) => {
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', metadata.name);
    formData.append('type', metadata.type);

    uploadMutation.mutate(formData);
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Upload Activity</h1>

      {!file ? (
        <FileDropzone onFileSelect={handleFileSelect} />
      ) : (
        <UploadForm
          preview={preview}
          isLoading={uploadMutation.isPending}
          error={uploadMutation.error?.message}
          onSubmit={handleSubmit}
          onCancel={() => { setFile(null); setPreview(null); }}
        />
      )}
    </div>
  );
}
```

### Backend Upload Handler

```typescript
// backend/src/routes/activities.ts
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { parseGPX } from '../services/gpxParser.js';
import { matchSegments } from '../services/segmentMatcher.js';
import { updateLeaderboard } from '../services/leaderboard.js';
import { generateFeedEntries } from '../services/feed.js';
import { UploadResponseSchema } from '@shared/types/api';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const userId = req.session.userId;
    const { name, type } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // 1. Parse GPX file
    const gpxContent = file.buffer.toString('utf-8');
    const { points, metrics } = await parseGPX(gpxContent);

    // 2. Apply privacy zones
    const privacyZones = await db.getPrivacyZones(userId);
    const filteredPoints = applyPrivacyZones(points, privacyZones);

    // 3. Create activity record
    const activity = await db.createActivity({
      userId,
      name,
      type,
      ...metrics,
      polyline: encodePolyline(filteredPoints),
      startLat: filteredPoints[0].latitude,
      startLng: filteredPoints[0].longitude,
      endLat: filteredPoints[filteredPoints.length - 1].latitude,
      endLng: filteredPoints[filteredPoints.length - 1].longitude,
    });

    // 4. Store GPS points
    await db.batchInsertGpsPoints(activity.id, filteredPoints);

    // 5. Match segments
    const segmentEfforts = await matchSegments(activity, filteredPoints);

    // 6. Update leaderboards and track PRs
    const newPRs = [];
    for (const effort of segmentEfforts) {
      const result = await updateLeaderboard(effort);
      if (result.isPR) {
        const segment = await db.getSegment(effort.segmentId);
        newPRs.push({
          segmentId: effort.segmentId,
          segmentName: segment.name,
          rank: result.rank,
          previousTime: result.previousTime,
          newTime: effort.elapsedTime,
        });
      }
    }

    // 7. Generate feed entries for followers
    await generateFeedEntries(activity);

    // 8. Check for new achievements
    await checkAchievements(userId);

    const response: z.infer<typeof UploadResponseSchema> = {
      activity,
      segmentEfforts,
      newPRs,
    };

    res.json(response);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process activity' });
  }
});
```

### Segment Matching Service

```typescript
// backend/src/services/segmentMatcher.ts
import { haversineDistance } from '@shared/utils/geo';
import type { GpsPoint, SegmentEffort } from '@shared/types';

const DISTANCE_THRESHOLD = 25; // meters

export async function matchSegments(
  activity: Activity,
  gpsPoints: GpsPoint[]
): Promise<SegmentEffort[]> {
  // Phase 1: Find candidate segments via bounding box
  const candidates = await db.query(`
    SELECT id, polyline, start_lat, start_lng, end_lat, end_lng
    FROM segments
    WHERE activity_type = $1
      AND min_lat <= $2 AND max_lat >= $3
      AND min_lng <= $4 AND max_lng >= $5
  `, [
    activity.type,
    activity.maxLat,
    activity.minLat,
    activity.maxLng,
    activity.minLng,
  ]);

  const efforts: SegmentEffort[] = [];

  // Phase 2: Precise matching for each candidate
  for (const segment of candidates.rows) {
    const effort = matchSingleSegment(segment, gpsPoints, activity);
    if (effort) {
      // Save to database
      const saved = await db.createSegmentEffort({
        segmentId: segment.id,
        activityId: activity.id,
        userId: activity.userId,
        ...effort,
      });

      // Update segment stats
      await db.incrementSegmentEffortCount(segment.id);

      efforts.push(saved);
    }
  }

  return efforts;
}

function matchSingleSegment(
  segment: Segment,
  activityPoints: GpsPoint[],
  activity: Activity
): Partial<SegmentEffort> | null {
  const segmentPoints = decodePolyline(segment.polyline);

  // Find activity points near segment start
  const startCandidates = findPointsNear(
    activityPoints,
    { lat: segment.startLat, lng: segment.startLng },
    DISTANCE_THRESHOLD
  );

  for (const startIdx of startCandidates) {
    const result = tryMatch(activityPoints.slice(startIdx), segmentPoints);

    if (result.matched) {
      const endIdx = startIdx + result.pointsUsed;
      return {
        startIndex: startIdx,
        endIndex: endIdx,
        elapsedTime: calculateElapsedTime(activityPoints, startIdx, endIdx),
        movingTime: calculateMovingTime(activityPoints, startIdx, endIdx),
      };
    }
  }

  return null;
}
```

---

## 6. Deep Dive: Leaderboard Sync (8 minutes)

### Backend Leaderboard Update

```typescript
// backend/src/services/leaderboard.ts
import { redis } from '../shared/redis.js';

interface LeaderboardUpdateResult {
  isPR: boolean;
  rank: number | null;
  previousTime: number | null;
}

export async function updateLeaderboard(
  effort: SegmentEffort
): Promise<LeaderboardUpdateResult> {
  const { segmentId, userId, elapsedTime } = effort;

  // Check personal record
  const prKey = `pr:${userId}:${segmentId}`;
  const currentPR = await redis.get(prKey);
  const previousTime = currentPR ? parseInt(currentPR) : null;

  if (!currentPR || elapsedTime < parseInt(currentPR)) {
    // New personal record
    await redis.set(prKey, elapsedTime.toString());

    // Update leaderboard sorted set
    const lbKey = `leaderboard:${segmentId}`;
    await redis.zadd(lbKey, elapsedTime, oderId);

    // Get new rank (0-indexed)
    const rank = await redis.zrank(lbKey, oderId);

    // Update effort with PR rank if podium
    if (rank !== null && rank < 3) {
      await db.updateEffortPRRank(effort.id, rank + 1);
    }

    return { isPR: true, rank: rank !== null ? rank + 1 : null, previousTime };
  }

  return { isPR: false, rank: null, previousTime };
}

export async function getLeaderboard(
  segmentId: string,
  options: { limit?: number; filter?: string; userId?: string } = {}
): Promise<LeaderboardEntry[]> {
  const { limit = 10, filter = 'overall', userId } = options;
  const lbKey = `leaderboard:${segmentId}`;

  let userScores: [string, number][];

  if (filter === 'overall') {
    const results = await redis.zrange(lbKey, 0, limit - 1, 'WITHSCORES');
    userScores = chunkPairs(results);
  } else if (filter === 'friends' && userId) {
    const following = await db.getFollowing(userId);
    const scores = await redis.zmscore(lbKey, ...following.map(f => f.id));
    userScores = following
      .map((f, i) => [f.id, scores[i]] as [string, number])
      .filter(([, score]) => score !== null)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit);
  }

  // Enrich with user data
  const entries = await Promise.all(
    userScores.map(async ([oderId, time], index) => {
      const user = await getCachedUser(userId);
      return {
        rank: index + 1,
        user: { id: user.id, username: user.username, profilePhoto: user.profilePhoto },
        elapsedTime: time,
        formattedTime: formatDuration(time),
      };
    })
  );

  return entries;
}
```

### Frontend Leaderboard Component

```tsx
// frontend/src/components/SegmentLeaderboard.tsx
import { useQuery } from '@tanstack/react-query';
import type { LeaderboardEntry } from '@shared/types';

interface Props {
  segmentId: string;
}

export function SegmentLeaderboard({ segmentId }: Props) {
  const [filter, setFilter] = useState<'overall' | 'friends'>('overall');
  const { user } = useAuthStore();

  const { data: leaderboard, isLoading, error } = useQuery({
    queryKey: ['leaderboard', segmentId, filter],
    queryFn: async (): Promise<LeaderboardEntry[]> => {
      const params = new URLSearchParams({ filter });
      const response = await fetch(`/api/segments/${segmentId}/leaderboard?${params}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to load leaderboard');
      return response.json();
    },
    staleTime: 30_000, // Consider fresh for 30 seconds
    refetchOnWindowFocus: true,
  });

  // Find current user's position
  const myEntry = leaderboard?.find(e => e.user.id === user?.id);

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      <div className="flex border-b">
        <FilterTab
          active={filter === 'overall'}
          onClick={() => setFilter('overall')}
        >
          All Athletes
        </FilterTab>
        <FilterTab
          active={filter === 'friends'}
          onClick={() => setFilter('friends')}
        >
          Following
        </FilterTab>
      </div>

      {isLoading ? (
        <LeaderboardSkeleton />
      ) : error ? (
        <ErrorMessage message="Failed to load leaderboard" />
      ) : (
        <>
          <div className="divide-y">
            {leaderboard?.map((entry) => (
              <LeaderboardRow
                key={entry.user.id}
                entry={entry}
                isCurrentUser={entry.user.id === user?.id}
              />
            ))}
          </div>

          {/* Show user's position if not in top 10 */}
          {myEntry && myEntry.rank > 10 && (
            <div className="border-t p-3 bg-orange-50">
              <LeaderboardRow entry={myEntry} isCurrentUser highlight />
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

---

## 7. Activity Feed Integration (5 minutes)

### Backend Feed Generation

```typescript
// backend/src/services/feed.ts
export async function generateFeedEntries(activity: Activity): Promise<void> {
  const { id: activityId, userId, startTime } = activity;
  const timestamp = new Date(startTime).getTime();

  // Get all followers
  const followers = await db.query(
    'SELECT follower_id FROM follows WHERE following_id = $1',
    [userId]
  );

  // Batch update Redis feeds
  const pipeline = redis.pipeline();

  for (const { follower_id } of followers.rows) {
    const feedKey = `feed:${follower_id}`;
    pipeline.zadd(feedKey, timestamp, activityId);
    pipeline.zremrangebyrank(feedKey, 0, -1001); // Keep last 1000
  }

  await pipeline.exec();
}

export async function getFeed(
  userId: string,
  cursor?: string,
  limit = 20
): Promise<FeedResponse> {
  const feedKey = `feed:${userId}`;

  let activityIds: string[];
  if (cursor) {
    activityIds = await redis.zrevrangebyscore(feedKey, cursor, '-inf', 'LIMIT', 0, limit);
  } else {
    activityIds = await redis.zrevrange(feedKey, 0, limit - 1);
  }

  if (activityIds.length === 0) {
    return { activities: [], nextCursor: null };
  }

  // Batch fetch activities with user data
  const activities = await db.query(`
    SELECT a.*,
           u.id as user_id, u.username, u.profile_photo,
           EXISTS(SELECT 1 FROM kudos k WHERE k.activity_id = a.id AND k.user_id = $2) as has_kudos
    FROM activities a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ANY($1)
    ORDER BY a.start_time DESC
  `, [activityIds, userId]);

  const lastTimestamp = await redis.zscore(feedKey, activityIds[activityIds.length - 1]);

  return {
    activities: activities.rows.map(mapActivityWithUser),
    nextCursor: activityIds.length === limit ? lastTimestamp : null,
  };
}
```

### Frontend Feed with Infinite Scroll

```tsx
// frontend/src/routes/index.tsx
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FeedResponse, ActivityWithUser } from '@shared/types';

export function FeedPage() {
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    error,
  } = useInfiniteQuery<FeedResponse>({
    queryKey: ['feed'],
    queryFn: async ({ pageParam }): Promise<FeedResponse> => {
      const params = pageParam ? `?cursor=${pageParam}` : '';
      const response = await fetch(`/api/feed${params}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to load feed');
      return response.json();
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialPageParam: undefined,
    staleTime: 60_000,
  });

  const allActivities = data?.pages.flatMap(p => p.activities) ?? [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allActivities.length + 1 : allActivities.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 450,
    overscan: 3,
  });

  // Trigger load more when approaching end
  useEffect(() => {
    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];

    if (lastItem && lastItem.index >= allActivities.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasNextPage, isFetchingNextPage, allActivities.length]);

  if (isLoading) return <FeedSkeleton />;
  if (error) return <ErrorMessage message="Failed to load feed" />;

  return (
    <div ref={parentRef} className="h-screen overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const activity = allActivities[virtualRow.index];

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                width: '100%',
                padding: '0 1rem',
              }}
            >
              {activity ? (
                <ActivityCard activity={activity} />
              ) : (
                <LoadingCard />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## 8. Shared Utilities (4 minutes)

### Geospatial Calculations

```typescript
// shared/utils/geo.ts
export function haversineDistance(
  point1: { lat: number; lng: number },
  point2: { lat: number; lng: number }
): number {
  const R = 6371000; // Earth's radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const lat1 = toRad(point1.lat);
  const lat2 = toRad(point2.lat);
  const deltaLat = toRad(point2.lat - point1.lat);
  const deltaLng = toRad(point2.lng - point1.lng);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
```

### Duration Formatting

```typescript
// shared/utils/format.ts
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function formatDistance(meters: number): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

export function formatPace(distanceMeters: number, timeSeconds: number): string {
  if (distanceMeters === 0) return '--:--';
  const paceSecondsPerKm = (timeSeconds / distanceMeters) * 1000;
  const minutes = Math.floor(paceSecondsPerKm / 60);
  const seconds = Math.round(paceSecondsPerKm % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')} /km`;
}
```

### Polyline Encoding/Decoding

```typescript
// shared/utils/polyline.ts
export function encodePolyline(points: Array<[number, number]>): string {
  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);

    encoded += encodeSignedNumber(latE5 - prevLat);
    encoded += encodeSignedNumber(lngE5 - prevLng);

    prevLat = latE5;
    prevLng = lngE5;
  }

  return encoded;
}

export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const [latDelta, newIndex1] = decodeSignedNumber(encoded, index);
    const [lngDelta, newIndex2] = decodeSignedNumber(encoded, newIndex1);

    lat += latDelta;
    lng += lngDelta;

    points.push([lat / 1e5, lng / 1e5]);
    index = newIndex2;
  }

  return points;
}
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
