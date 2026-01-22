# TikTok - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"Today I'll design a short-video platform like TikTok, taking a full-stack perspective that emphasizes the integration between frontend and backend systems. The core challenge is building an end-to-end recommendation experience where personalized content appears instantly, user engagement flows seamlessly from UI to data pipeline, and cold start problems are solved through coordinated frontend/backend strategies. I'll focus on shared TypeScript types for API contracts, real-time watch tracking that feeds the recommendation engine, and the complete flow from video upload to appearing in personalized feeds."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **For You Page (FYP)**: Personalized infinite scroll with instant video playback
2. **Upload Flow**: Capture/select, preview, publish with real-time processing status
3. **Engagement**: Like, comment, share with optimistic UI and backend sync
4. **Cold Start**: Onboard new users and boost new videos effectively
5. **Creator Analytics**: Real-time metrics dashboard synced with backend data

### Non-Functional Requirements

- **Latency**: < 100ms for feed API, < 500ms for video start
- **Consistency**: Engagement counts eventually consistent (5-minute window)
- **Type Safety**: Shared types between frontend and backend
- **Real-time**: Processing status updates, live engagement counts

### Full-Stack Integration Challenges

- Shared TypeScript types for API contracts
- Watch time tracking with client-side precision and server-side aggregation
- Optimistic updates with rollback on API failure
- Cold start coordination between onboarding UI and recommendation engine
- Upload progress and transcoding status across the stack

---

## Step 2: End-to-End Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Frontend                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Virtualized │  │   Upload     │  │  Creator Analytics  │    │
│  │    Feed     │  │    Flow      │  │     Dashboard       │    │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘    │
│         │                │                      │               │
│         ▼                ▼                      ▼               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  Zustand Stores                          │  │
│  │   feedStore  │  uploadStore  │  engagementStore  │  user │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ API Layer (shared types)
┌─────────────────────────────────────────────────────────────────┐
│                     Express Backend                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Feed API    │  │  Video API   │  │  Analytics API      │    │
│  │ /api/feed   │  │ /api/videos  │  │  /api/analytics     │    │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────┘    │
│         │                │                      │               │
│         ▼                ▼                      ▼               │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │               Recommendation Engine                       │  │
│  │   Candidate Gen  │  Ranking  │  Cold Start  │  pgvector  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Data Layer                               │
│   PostgreSQL + pgvector  │  Redis  │  MinIO  │  Kafka          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 3: Core Full-Stack Deep Dives

### Deep Dive 1: Shared TypeScript Types & API Contracts (8 minutes)

**Shared Types Package:**

```typescript
// shared/types.ts
// Used by both frontend and backend

export interface User {
  id: number
  username: string
  displayName: string
  avatarUrl: string | null
  role: 'user' | 'creator' | 'moderator' | 'admin'
  createdAt: string
}

export interface Video {
  id: string
  creatorId: number
  creator: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'>
  url: string
  thumbnailUrl: string
  description: string
  hashtags: string[]
  durationSeconds: number
  viewCount: number
  likeCount: number
  commentCount: number
  shareCount: number
  isLiked: boolean        // Personalized per user
  status: 'processing' | 'published' | 'failed' | 'deleted'
  createdAt: string
}

export interface FeedResponse {
  videos: Video[]
  nextCursor: string | null
  source: 'personalized' | 'trending' | 'following'
}

export interface UploadResponse {
  videoId: string
  status: 'processing'
  uploadedAt: string
}

export interface EngagementEvent {
  videoId: string
  watchDurationMs: number
  completionRate: number
  liked: boolean
  shared: boolean
}

export interface AnalyticsData {
  date: string
  views: number
  likes: number
  shares: number
  comments: number
  avgCompletionRate: number
}

// API request/response types
export interface FeedRequest {
  limit?: number
  cursor?: string
  source?: 'fyp' | 'following' | 'trending'
}

export interface UploadRequest {
  description: string
  hashtags: string[]
  visibility: 'public' | 'followers' | 'private'
}

export interface TrackWatchRequest {
  videoId: string
  watchDurationMs: number
  totalDurationMs: number
  completed: boolean
}
```

**Backend API Handler with Type Safety:**

```typescript
// backend/src/routes/feed.ts
import { Router, Request, Response } from 'express'
import { FeedRequest, FeedResponse, Video } from '@shared/types'
import { getPersonalizedFeed, getTrendingFeed } from '../services/recommendation.js'

const router = Router()

router.get('/fyp', async (req: Request, res: Response<FeedResponse>) => {
  const { limit = 20, cursor } = req.query as FeedRequest
  const userId = req.session?.userId

  try {
    let videos: Video[]
    let source: FeedResponse['source']

    if (userId) {
      videos = await getPersonalizedFeed(userId, limit, cursor)
      source = 'personalized'
    } else {
      videos = await getTrendingFeed(limit, cursor)
      source = 'trending'
    }

    // Compute next cursor from last video
    const nextCursor = videos.length === limit
      ? videos[videos.length - 1].id
      : null

    res.json({ videos, nextCursor, source })
  } catch (error) {
    // Circuit breaker fallback
    if (error.message === 'Breaker is open') {
      const videos = await getTrendingFeed(limit, cursor)
      res.json({ videos, nextCursor: null, source: 'trending' })
    } else {
      throw error
    }
  }
})

export default router
```

**Frontend API Client with Types:**

```typescript
// frontend/src/api/feed.ts
import { FeedRequest, FeedResponse } from '@shared/types'

export async function fetchFeed(params: FeedRequest): Promise<FeedResponse> {
  const searchParams = new URLSearchParams()
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.cursor) searchParams.set('cursor', params.cursor)

  const response = await fetch(`/api/feed/fyp?${searchParams}`, {
    credentials: 'include',
  })

  if (!response.ok) {
    throw new Error(`Feed fetch failed: ${response.status}`)
  }

  return response.json()
}

// frontend/src/stores/feedStore.ts
import { create } from 'zustand'
import { Video, FeedResponse } from '@shared/types'
import { fetchFeed } from '../api/feed'

interface FeedState {
  videos: Video[]
  cursor: string | null
  source: FeedResponse['source'] | null
  isLoading: boolean
  hasMore: boolean

  fetchNextPage: () => Promise<void>
  updateVideo: (id: string, updates: Partial<Video>) => void
}

export const useFeedStore = create<FeedState>((set, get) => ({
  videos: [],
  cursor: null,
  source: null,
  isLoading: false,
  hasMore: true,

  fetchNextPage: async () => {
    const { cursor, isLoading, hasMore } = get()
    if (isLoading || !hasMore) return

    set({ isLoading: true })

    try {
      const response = await fetchFeed({ limit: 20, cursor: cursor ?? undefined })

      set(state => ({
        videos: [...state.videos, ...response.videos],
        cursor: response.nextCursor,
        source: response.source,
        hasMore: response.nextCursor !== null,
        isLoading: false,
      }))
    } catch (error) {
      console.error('Feed fetch error:', error)
      set({ isLoading: false })
    }
  },

  updateVideo: (id, updates) => {
    set(state => ({
      videos: state.videos.map(v =>
        v.id === id ? { ...v, ...updates } : v
      ),
    }))
  },
}))
```

---

### Deep Dive 2: End-to-End Watch Tracking (10 minutes)

Watch time is the primary signal for recommendations. The full-stack flow coordinates precise client-side measurement with server-side aggregation.

**Frontend: Track Watch Duration**

```typescript
// frontend/src/hooks/useWatchTracking.ts
import { useRef, useEffect, useCallback } from 'react'
import { TrackWatchRequest } from '@shared/types'
import { trackWatch } from '../api/engagement'

export function useWatchTracking(
  videoId: string,
  isActive: boolean,
  videoDuration: number
) {
  const startTimeRef = useRef<number | null>(null)
  const watchedMsRef = useRef(0)

  // Track when video becomes active/inactive
  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now()
    } else if (startTimeRef.current) {
      // Accumulate watch time
      watchedMsRef.current += Date.now() - startTimeRef.current
      startTimeRef.current = null

      // Send tracking event
      const totalDurationMs = videoDuration * 1000
      sendTrackingEvent({
        videoId,
        watchDurationMs: watchedMsRef.current,
        totalDurationMs,
        completed: watchedMsRef.current >= totalDurationMs * 0.9,
      })

      watchedMsRef.current = 0
    }
  }, [isActive, videoId, videoDuration])

  // Also track on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (startTimeRef.current && isActive) {
        watchedMsRef.current += Date.now() - startTimeRef.current

        // Use sendBeacon for reliable delivery
        navigator.sendBeacon(
          '/api/engagement/track',
          JSON.stringify({
            videoId,
            watchDurationMs: watchedMsRef.current,
            totalDurationMs: videoDuration * 1000,
            completed: false,
          })
        )
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [videoId, isActive, videoDuration])
}

// Batch tracking events to reduce API calls
const pendingEvents: TrackWatchRequest[] = []
let flushTimeout: NodeJS.Timeout | null = null

function sendTrackingEvent(event: TrackWatchRequest) {
  pendingEvents.push(event)

  if (!flushTimeout) {
    flushTimeout = setTimeout(flushEvents, 2000) // Batch every 2 seconds
  }
}

async function flushEvents() {
  flushTimeout = null
  if (pendingEvents.length === 0) return

  const events = [...pendingEvents]
  pendingEvents.length = 0

  try {
    await fetch('/api/engagement/track-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      credentials: 'include',
    })
  } catch (error) {
    // Re-queue failed events
    pendingEvents.unshift(...events)
  }
}
```

**Backend: Aggregate Watch Events**

```typescript
// backend/src/routes/engagement.ts
import { Router } from 'express'
import { TrackWatchRequest } from '@shared/types'
import { redis } from '../shared/cache.js'
import { kafka } from '../shared/queue.js'

const router = Router()

// Single event tracking (for sendBeacon)
router.post('/track', async (req, res) => {
  const event: TrackWatchRequest = req.body
  const userId = req.session?.userId

  await processWatchEvent(userId, event)
  res.status(204).end()
})

// Batch event tracking
router.post('/track-batch', async (req, res) => {
  const { events }: { events: TrackWatchRequest[] } = req.body
  const userId = req.session?.userId

  await Promise.all(events.map(e => processWatchEvent(userId, e)))
  res.status(204).end()
})

async function processWatchEvent(userId: number | undefined, event: TrackWatchRequest) {
  const { videoId, watchDurationMs, totalDurationMs, completed } = event
  const completionRate = watchDurationMs / totalDurationMs

  // 1. Increment view count in Redis (fast path)
  await redis.incr(`views:${videoId}`)

  // 2. Store in watch history if authenticated
  if (userId) {
    await kafka.send('watch-events', {
      userId,
      videoId,
      watchDurationMs,
      completionRate,
      completed,
      timestamp: Date.now(),
    })
  }

  // 3. Update real-time metrics for creator analytics
  await redis.hincrby(`video:${videoId}:metrics`, 'totalWatchMs', watchDurationMs)
  await redis.hincrby(`video:${videoId}:metrics`, 'watchCount', 1)
}

export default router
```

**Background Worker: Update Embeddings from Watch History**

```typescript
// backend/src/workers/embedding-updater.ts
import { kafka } from '../shared/queue.js'
import { pool } from '../shared/db.js'

kafka.subscribe('watch-events', async (message) => {
  const { userId, videoId, completionRate, completed } = message

  // Calculate engagement weight
  let weight = completionRate
  if (completed) weight += 0.2

  // Get video embedding
  const videoResult = await pool.query(
    `SELECT embedding FROM video_embeddings WHERE video_id = $1`,
    [videoId]
  )

  if (videoResult.rows.length === 0) return

  const videoEmbedding = videoResult.rows[0].embedding

  // Update user embedding with exponential moving average
  await pool.query(`
    INSERT INTO user_embeddings (user_id, embedding, updated_at)
    VALUES ($1, $2::vector * $3, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      embedding = user_embeddings.embedding * 0.95 + $2::vector * $3 * 0.05,
      updated_at = NOW()
  `, [userId, videoEmbedding, weight])
})
```

---

### Deep Dive 3: Optimistic Engagement with Backend Sync (8 minutes)

**Frontend: Optimistic Like Flow**

```typescript
// frontend/src/stores/engagementStore.ts
import { create } from 'zustand'
import { useFeedStore } from './feedStore'

interface EngagementState {
  pendingLikes: Map<string, 'liking' | 'unliking'>
  failedLikes: Set<string>

  likeVideo: (videoId: string) => Promise<void>
  unlikeVideo: (videoId: string) => Promise<void>
  retryFailedLike: (videoId: string) => Promise<void>
}

export const useEngagementStore = create<EngagementState>((set, get) => ({
  pendingLikes: new Map(),
  failedLikes: new Set(),

  likeVideo: async (videoId: string) => {
    // Optimistic update
    set(state => {
      const pending = new Map(state.pendingLikes)
      pending.set(videoId, 'liking')
      return { pendingLikes: pending }
    })

    useFeedStore.getState().updateVideo(videoId, {
      isLiked: true,
      likeCount: prev => prev + 1,
    })

    try {
      const response = await fetch(`/api/videos/${videoId}/like`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Idempotency-Key': `like-${videoId}-${Date.now()}`,
        },
      })

      if (!response.ok) throw new Error('Like failed')

      // Success - clear pending state
      set(state => {
        const pending = new Map(state.pendingLikes)
        pending.delete(videoId)
        return { pendingLikes: pending }
      })

    } catch (error) {
      // Rollback optimistic update
      useFeedStore.getState().updateVideo(videoId, {
        isLiked: false,
        likeCount: prev => prev - 1,
      })

      set(state => {
        const pending = new Map(state.pendingLikes)
        pending.delete(videoId)
        const failed = new Set(state.failedLikes)
        failed.add(videoId)
        return { pendingLikes: pending, failedLikes: failed }
      })
    }
  },

  unlikeVideo: async (videoId: string) => {
    // Similar pattern with inverse updates
    set(state => {
      const pending = new Map(state.pendingLikes)
      pending.set(videoId, 'unliking')
      return { pendingLikes: pending }
    })

    useFeedStore.getState().updateVideo(videoId, {
      isLiked: false,
      likeCount: prev => prev - 1,
    })

    try {
      await fetch(`/api/videos/${videoId}/like`, {
        method: 'DELETE',
        credentials: 'include',
      })

      set(state => {
        const pending = new Map(state.pendingLikes)
        pending.delete(videoId)
        return { pendingLikes: pending }
      })
    } catch (error) {
      // Rollback
      useFeedStore.getState().updateVideo(videoId, {
        isLiked: true,
        likeCount: prev => prev + 1,
      })

      set(state => {
        const pending = new Map(state.pendingLikes)
        pending.delete(videoId)
        return { pendingLikes: pending }
      })
    }
  },

  retryFailedLike: async (videoId: string) => {
    set(state => {
      const failed = new Set(state.failedLikes)
      failed.delete(videoId)
      return { failedLikes: failed }
    })
    await get().likeVideo(videoId)
  },
}))
```

**Backend: Idempotent Like Handler**

```typescript
// backend/src/routes/videos.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'

const router = Router()

router.post('/:id/like', async (req, res) => {
  const videoId = req.params.id
  const userId = req.session!.userId
  const idempotencyKey = req.headers['x-idempotency-key'] as string

  // Check idempotency
  if (idempotencyKey) {
    const existing = await redis.get(`idem:like:${idempotencyKey}`)
    if (existing) {
      return res.status(200).json(JSON.parse(existing))
    }
  }

  // Check if already liked
  const existingLike = await pool.query(
    `SELECT id FROM likes WHERE user_id = $1 AND video_id = $2`,
    [userId, videoId]
  )

  if (existingLike.rows.length > 0) {
    return res.status(200).json({ success: true, alreadyLiked: true })
  }

  // Insert like and update count atomically
  await pool.query(`
    BEGIN;
    INSERT INTO likes (user_id, video_id, created_at)
    VALUES ($1, $2, NOW());
    UPDATE videos SET like_count = like_count + 1 WHERE id = $2;
    COMMIT;
  `, [userId, videoId])

  // Store idempotency result
  if (idempotencyKey) {
    await redis.setex(
      `idem:like:${idempotencyKey}`,
      86400,
      JSON.stringify({ success: true })
    )
  }

  // Update watch history for recommendation engine
  await pool.query(`
    UPDATE watch_history
    SET liked = true
    WHERE user_id = $1 AND video_id = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, videoId])

  res.json({ success: true })
})

export default router
```

---

### Deep Dive 4: Cold Start Coordination (8 minutes)

**Frontend: Onboarding Flow**

```typescript
// frontend/src/pages/Onboarding.tsx
import { useState, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { InterestSelector } from '../components/InterestSelector'
import { useUserStore } from '../stores/userStore'

const INTEREST_CATEGORIES = [
  { id: 'comedy', label: 'Comedy', emoji: '😂' },
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'dance', label: 'Dance', emoji: '💃' },
  { id: 'food', label: 'Food', emoji: '🍕' },
  { id: 'sports', label: 'Sports', emoji: '⚽' },
  { id: 'pets', label: 'Pets', emoji: '🐶' },
  { id: 'diy', label: 'DIY', emoji: '🔨' },
  { id: 'beauty', label: 'Beauty', emoji: '💄' },
  { id: 'gaming', label: 'Gaming', emoji: '🎮' },
  { id: 'travel', label: 'Travel', emoji: '✈️' },
]

export function OnboardingPage() {
  const [step, setStep] = useState<'interests' | 'loading' | 'ready'>('interests')
  const { setPreferences, completeOnboarding } = useUserStore()
  const navigate = useNavigate()

  const handleInterestsComplete = useCallback(async (interests: string[]) => {
    setStep('loading')

    try {
      // Send interests to backend to initialize user embedding
      await fetch('/api/users/me/interests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interests }),
        credentials: 'include',
      })

      setPreferences({ selectedInterests: interests })
      completeOnboarding()
      navigate({ to: '/' })
    } catch (error) {
      console.error('Failed to save interests:', error)
      setStep('interests')
    }
  }, [setPreferences, completeOnboarding, navigate])

  if (step === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-black">
        <div className="text-center">
          <div className="animate-spin h-12 w-12 border-4 border-pink-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-white text-lg">Personalizing your feed...</p>
        </div>
      </div>
    )
  }

  return (
    <InterestSelector
      categories={INTEREST_CATEGORIES}
      onComplete={handleInterestsComplete}
      minSelections={3}
    />
  )
}
```

**Backend: Initialize User Embedding from Interests**

```typescript
// backend/src/routes/users.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'

const router = Router()

// Category to hashtag mapping for cold start
const INTEREST_HASHTAGS: Record<string, string[]> = {
  comedy: ['funny', 'comedy', 'humor', 'jokes', 'lol'],
  music: ['music', 'song', 'singing', 'musician', 'cover'],
  dance: ['dance', 'dancing', 'choreography', 'dancer'],
  food: ['food', 'cooking', 'recipe', 'foodie', 'chef'],
  sports: ['sports', 'football', 'basketball', 'workout', 'fitness'],
  pets: ['pets', 'dogs', 'cats', 'animals', 'puppy', 'kitten'],
  diy: ['diy', 'crafts', 'howto', 'tutorial', 'handmade'],
  beauty: ['beauty', 'makeup', 'skincare', 'fashion', 'style'],
  gaming: ['gaming', 'gamer', 'videogames', 'streamer', 'esports'],
  travel: ['travel', 'adventure', 'explore', 'vacation', 'wanderlust'],
}

router.post('/me/interests', async (req, res) => {
  const userId = req.session!.userId
  const { interests }: { interests: string[] } = req.body

  // Get all relevant hashtags
  const relevantHashtags = interests.flatMap(i => INTEREST_HASHTAGS[i] || [])

  // Find videos with these hashtags to compute initial embedding
  const videos = await pool.query(`
    SELECT ve.embedding
    FROM videos v
    JOIN video_embeddings ve ON v.id = ve.video_id
    WHERE v.hashtags && $1::text[]
      AND v.status = 'published'
    ORDER BY v.view_count DESC
    LIMIT 100
  `, [relevantHashtags])

  if (videos.rows.length > 0) {
    // Compute average embedding
    const avgEmbedding = computeAverageEmbedding(videos.rows.map(r => r.embedding))

    // Store as initial user embedding
    await pool.query(`
      INSERT INTO user_embeddings (user_id, embedding, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        embedding = $2,
        updated_at = NOW()
    `, [userId, avgEmbedding])
  }

  // Store interests for analytics
  await pool.query(`
    UPDATE users
    SET interests = $1, onboarded_at = NOW()
    WHERE id = $2
  `, [interests, userId])

  res.json({ success: true })
})

function computeAverageEmbedding(embeddings: number[][]): number[] {
  const dim = embeddings[0].length
  const avg = new Array(dim).fill(0)

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i] / embeddings.length
    }
  }

  return avg
}

export default router
```

**Backend: New Video Boost**

```typescript
// backend/src/workers/new-video-booster.ts
import { kafka } from '../shared/queue.js'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'

kafka.subscribe('video-published', async (message) => {
  const { videoId } = message

  // Get video embedding
  const video = await pool.query(`
    SELECT ve.embedding, v.hashtags
    FROM videos v
    JOIN video_embeddings ve ON v.id = ve.video_id
    WHERE v.id = $1
  `, [videoId])

  if (video.rows.length === 0) return

  const { embedding, hashtags } = video.rows[0]

  // Find target users: those with similar interests
  const targetUsers = await pool.query(`
    SELECT user_id
    FROM user_embeddings
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1
    LIMIT 1000
  `, [embedding])

  // Also find users who engage with these hashtags
  const hashtagUsers = await pool.query(`
    SELECT DISTINCT wh.user_id
    FROM watch_history wh
    JOIN videos v ON wh.video_id = v.id
    WHERE v.hashtags && $1::text[]
      AND wh.completion_rate > 0.5
    LIMIT 500
  `, [hashtags])

  // Combine and dedupe
  const allUserIds = new Set([
    ...targetUsers.rows.map(r => r.user_id),
    ...hashtagUsers.rows.map(r => r.user_id),
  ])

  // Add to exploration pools
  const pipeline = redis.pipeline()
  for (const userId of allUserIds) {
    pipeline.sadd(`exploration:${userId}`, videoId)
    pipeline.expire(`exploration:${userId}`, 3600) // 1 hour
  }
  await pipeline.exec()

  console.log(`Boosted video ${videoId} to ${allUserIds.size} users`)

  // Schedule performance check
  await kafka.send('video-performance-check', {
    videoId,
    checkAt: Date.now() + 3600000,
  })
})
```

---

### Deep Dive 5: Upload Flow with Processing Status (8 minutes)

**Frontend: Upload Component with Progress**

```typescript
// frontend/src/pages/Upload.tsx
import { useState, useCallback, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { UploadRequest, UploadResponse } from '@shared/types'

type UploadStatus = 'idle' | 'uploading' | 'processing' | 'published' | 'error'

export function UploadPage() {
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [videoId, setVideoId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  const handleUpload = useCallback(async (
    file: File,
    metadata: UploadRequest
  ) => {
    setStatus('uploading')
    setProgress(0)

    try {
      // Upload with progress tracking
      const formData = new FormData()
      formData.append('video', file)
      formData.append('description', metadata.description)
      formData.append('hashtags', JSON.stringify(metadata.hashtags))

      const xhr = new XMLHttpRequest()

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          setProgress(Math.round((e.loaded / e.total) * 100))
        }
      })

      const response = await new Promise<UploadResponse>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText))
          } else {
            reject(new Error('Upload failed'))
          }
        }
        xhr.onerror = () => reject(new Error('Network error'))

        xhr.open('POST', '/api/videos')
        xhr.withCredentials = true
        xhr.setRequestHeader('X-Idempotency-Key', crypto.randomUUID())
        xhr.send(formData)
      })

      setVideoId(response.videoId)
      setStatus('processing')

      // Poll for processing status
      await pollProcessingStatus(response.videoId)

      setStatus('published')
      setTimeout(() => navigate({ to: '/' }), 2000)

    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Upload failed')
    }
  }, [navigate])

  const pollProcessingStatus = async (videoId: string) => {
    while (true) {
      const response = await fetch(`/api/videos/${videoId}/status`, {
        credentials: 'include',
      })
      const { status } = await response.json()

      if (status === 'published') return
      if (status === 'failed') throw new Error('Processing failed')

      await new Promise(r => setTimeout(r, 2000)) // Poll every 2 seconds
    }
  }

  return (
    <div className="flex flex-col h-full bg-black">
      {status === 'idle' && (
        <VideoSelector onSelect={(file) => handleUpload(file, formData)} />
      )}

      {status === 'uploading' && (
        <ProgressOverlay
          title="Uploading..."
          progress={progress}
        />
      )}

      {status === 'processing' && (
        <ProgressOverlay
          title="Processing video..."
          message="Your video is being optimized for all devices"
          indeterminate
        />
      )}

      {status === 'published' && (
        <SuccessOverlay
          title="Video published!"
          message="Redirecting to your feed..."
        />
      )}

      {status === 'error' && (
        <ErrorOverlay
          message={error ?? 'Something went wrong'}
          onRetry={() => setStatus('idle')}
        />
      )}
    </div>
  )
}
```

**Backend: Upload Endpoint with Processing Queue**

```typescript
// backend/src/routes/videos.ts
import { Router } from 'express'
import multer from 'multer'
import { pool } from '../shared/db.js'
import { minio } from '../shared/storage.js'
import { kafka } from '../shared/queue.js'
import { redis } from '../shared/cache.js'
import { UploadResponse } from '@shared/types'

const upload = multer({ storage: multer.memoryStorage() })
const router = Router()

router.post('/',
  upload.single('video'),
  requireRole('creator'),
  async (req, res) => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string

    // Check idempotency
    if (idempotencyKey) {
      const existing = await redis.get(`idem:upload:${idempotencyKey}`)
      if (existing) {
        return res.status(200).json(JSON.parse(existing))
      }
    }

    const { description, hashtags: hashtagsJson } = req.body
    const hashtags = JSON.parse(hashtagsJson)
    const userId = req.session!.userId

    // Store raw video
    const rawKey = `raw/${userId}/${Date.now()}-${req.file!.originalname}`
    await minio.putObject('videos', rawKey, req.file!.buffer)

    // Create video record
    const result = await pool.query(`
      INSERT INTO videos (creator_id, raw_url, description, hashtags, status, created_at)
      VALUES ($1, $2, $3, $4, 'processing', NOW())
      RETURNING id
    `, [userId, rawKey, description, hashtags])

    const videoId = result.rows[0].id

    // Queue for transcoding
    await kafka.send('video-transcoding', {
      videoId,
      rawKey,
      resolutions: ['1080p', '720p', '480p', '360p'],
      userId,
    })

    const response: UploadResponse = {
      videoId: String(videoId),
      status: 'processing',
      uploadedAt: new Date().toISOString(),
    }

    // Store idempotency result
    if (idempotencyKey) {
      await redis.setex(
        `idem:upload:${idempotencyKey}`,
        86400,
        JSON.stringify(response)
      )
    }

    res.status(202).json(response)
  }
)

// Status polling endpoint
router.get('/:id/status', async (req, res) => {
  const result = await pool.query(
    `SELECT status FROM videos WHERE id = $1`,
    [req.params.id]
  )

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Video not found' })
  }

  res.json({ status: result.rows[0].status })
})

export default router
```

---

## Step 4: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Type sharing | Shared package | OpenAPI codegen | Simpler, works with TypeScript |
| Watch tracking | Client timer + batch | Server-side only | More accurate, handles tab switches |
| Optimistic UI | Zustand with pending state | React Query mutations | Finer control over rollback |
| Cold start | Interests + implicit learning | Implicit only | Faster personalization convergence |
| Upload status | Polling | WebSocket | Simpler, fewer connections |
| Idempotency | Client-generated UUID | Server nonce | Works offline, no extra roundtrip |

---

## Step 5: Error Handling Across the Stack (2 minutes)

```typescript
// Frontend: Unified error boundary
function useApiError() {
  const [error, setError] = useState<ApiError | null>(null)

  const handleError = useCallback((err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        // Redirect to login
        window.location.href = '/login'
      } else if (err.status === 429) {
        // Rate limited - show toast
        toast.error('Too many requests. Please slow down.')
      } else {
        setError(err)
      }
    }
  }, [])

  return { error, handleError, clearError: () => setError(null) }
}

// Backend: Consistent error responses
interface ApiError {
  error: string
  code: string
  details?: Record<string, unknown>
}

app.use((err: Error, req: Request, res: Response<ApiError>, next: NextFunction) => {
  console.error(err)

  if (err instanceof ValidationError) {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.details,
    })
  }

  if (err instanceof RateLimitError) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      details: { retryAfter: err.retryAfter },
    })
  }

  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  })
})
```

---

## Closing Summary

I've designed a full-stack TikTok-like platform with focus on five integration areas:

1. **Shared TypeScript Types**: API contracts defined once, used in both frontend and backend. Ensures type safety across the network boundary.

2. **End-to-End Watch Tracking**: Client-side timer with batch sending, server-side aggregation in Redis, background worker updates to user embeddings for personalization.

3. **Optimistic Engagement**: Zustand stores with pending state management, idempotent backend handlers, automatic rollback on failure.

4. **Cold Start Coordination**: Frontend interest selector initializes user embedding on backend. New video boost worker finds target users via embedding similarity.

5. **Upload Flow**: XHR with progress tracking, idempotent upload handler, Kafka transcoding queue, status polling until published.

**Full-stack trade-offs:**
- Shared types require build coordination but eliminate drift
- Client-side watch tracking is more accurate but adds complexity
- Polling for upload status is simpler than WebSocket but higher latency
