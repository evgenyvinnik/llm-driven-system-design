# Spotify - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Introduction (2 minutes)

"Thank you. Today I'll design Spotify, a music streaming platform. As a full-stack engineer, I'll focus on how the frontend and backend work together to deliver seamless audio playback, real-time queue synchronization, and personalized recommendations.

The key full-stack challenges are:
1. End-to-end audio streaming with CDN integration and playback analytics
2. Player state synchronization across frontend and backend
3. Real-time updates for collaborative playlists
4. Recommendation pipeline from listening history to UI

Let me start by clarifying the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Streaming**: Play music with adaptive quality based on network
2. **Library**: Browse and save tracks, albums, playlists
3. **Playlists**: Create, edit, collaborate with real-time updates
4. **Discovery**: Personalized recommendations (Discover Weekly, Daily Mixes)
5. **Queue**: Manage upcoming tracks with shuffle and repeat

From a full-stack perspective, the streaming pipeline and real-time playlist updates are the most interesting challenges."

### Non-Functional Requirements

"For scale and experience:

- **Playback Start**: Under 200ms from tap to audio
- **Availability**: 99.99% for streaming
- **Scale**: 500M users, 100M songs
- **Sync**: Play state consistent across devices"

---

## High-Level Design (8 minutes)

### Full-Stack Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                              │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────┐│
│  │   PlayerStore   │ │  LibraryStore   │ │     API Client          ││
│  │   (Zustand)     │ │  (Zustand)      │ │  (fetch + React Query)  ││
│  └────────┬────────┘ └────────┬────────┘ └───────────┬─────────────┘│
└───────────│────────────────────│─────────────────────│──────────────┘
            │                    │                     │
            ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CDN (Audio/Images)                           │
│                        └── Signed URLs ──┘                           │
└─────────────────────────────────────────────────────────────────────┘
            │                    │                     │
            ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       API Gateway (Express)                          │
│                  Rate Limiting │ Auth │ Routing                      │
└─────────────────────────────────────────────────────────────────────┘
            │                    │                     │
            ▼                    ▼                     ▼
┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐
│  Playback Service │ │  Catalog Service  │ │    Rec Service    │
│                   │ │                   │ │                   │
│ - Stream URLs     │ │ - Artists/Albums  │ │ - Discover Weekly │
│ - Analytics       │ │ - Playlists       │ │ - Similar tracks  │
│ - Queue sync      │ │ - Library CRUD    │ │ - Radio           │
└─────────┬─────────┘ └─────────┬─────────┘ └─────────┬─────────┘
          │                     │                     │
          ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────────┐│
│  │   PostgreSQL    │ │     Valkey      │ │   Feature Store (ML)    ││
│  │  Catalog/Users  │ │ Sessions/Cache  │ │   Embeddings/History    ││
│  └─────────────────┘ └─────────────────┘ └─────────────────────────┘│
│                               │                                      │
│                               ▼                                      │
│                    ┌─────────────────────┐                          │
│                    │       Kafka         │                          │
│                    │  (Playback Events)  │                          │
│                    └─────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: End-to-End Streaming Flow (12 minutes)

### Shared Type Definitions

```typescript
// shared/types.ts - Used by both frontend and backend
export interface Track {
  id: string
  title: string
  duration_ms: number
  explicit: boolean
  album: {
    id: string
    title: string
    cover_url: string
  }
  artist: {
    id: string
    name: string
  }
  audio_features?: AudioFeatures
}

export interface AudioFeatures {
  tempo: number
  energy: number
  danceability: number
  acousticness: number
  valence: number
}

export interface StreamResponse {
  url: string
  quality: 96 | 160 | 320
  expiresAt: number
}

export interface PlaybackEvent {
  trackId: string
  eventType: 'start' | 'progress' | 'complete' | 'skip' | 'seek'
  position: number  // milliseconds
  timestamp: number
}
```

### Backend: Stream URL Generation

```typescript
// backend/src/routes/playback.ts
import { Router } from 'express'
import { requireAuth } from '../shared/auth.js'
import { redis } from '../shared/cache.js'
import { createSignedUrl } from '../shared/cdn.js'

const router = Router()

router.get('/stream/:trackId', requireAuth, async (req, res) => {
  const { trackId } = req.params
  const userId = req.session.userId

  try {
    // Check cache for existing URL
    const cached = await redis.get(`stream:${userId}:${trackId}`)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (parsed.expiresAt > Date.now()) {
        return res.json(parsed)
      }
    }

    // Determine quality based on subscription
    const user = await redis.hgetall(`user:${userId}`)
    const isPremium = user.subscription === 'premium'
    const connectionType = req.headers['x-connection-type'] || 'wifi'

    const quality = determineQuality(isPremium, connectionType)

    // Generate signed URL
    const expiresAt = Date.now() + 3600 * 1000  // 1 hour
    const url = await createSignedUrl(`tracks/${trackId}_${quality}kbps.ogg`, {
      expiresAt,
      userId,
    })

    const response: StreamResponse = { url, quality, expiresAt }

    // Cache for quick retry
    await redis.setex(
      `stream:${userId}:${trackId}`,
      300,
      JSON.stringify(response)
    )

    res.json(response)
  } catch (error) {
    console.error('Stream URL error:', error)
    res.status(500).json({ error: 'Failed to generate stream URL' })
  }
})

function determineQuality(
  isPremium: boolean,
  connectionType: string
): 96 | 160 | 320 {
  const maxQuality = isPremium ? 320 : 160

  switch (connectionType) {
    case '4g':
    case 'wifi':
      return maxQuality
    case '3g':
      return Math.min(160, maxQuality) as 160
    case '2g':
    case 'slow-2g':
      return 96
    default:
      return maxQuality
  }
}

export { router as playbackRouter }
```

### Frontend: Audio Controller Integration

```tsx
// frontend/src/components/AudioController.tsx
import { useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { api } from '../services/api'
import type { PlaybackEvent } from '../../../shared/types'

export function AudioController() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const {
    currentTrack,
    isPlaying,
    volume,
    isMuted,
    setCurrentTime,
    onTrackEnd,
  } = usePlayerStore()

  // Fetch stream URL when track changes
  useEffect(() => {
    if (!currentTrack) return

    const loadTrack = async () => {
      try {
        const { url } = await api.getStreamUrl(currentTrack.id)

        if (audioRef.current) {
          audioRef.current.src = url
          audioRef.current.load()
          if (isPlaying) {
            await audioRef.current.play()
          }
        }
      } catch (error) {
        console.error('Failed to load track:', error)
      }
    }

    loadTrack()
  }, [currentTrack?.id])

  // Report playback events for analytics
  const reportEvent = useCallback(async (
    eventType: PlaybackEvent['eventType']
  ) => {
    if (!currentTrack || !audioRef.current) return

    const event: PlaybackEvent = {
      trackId: currentTrack.id,
      eventType,
      position: Math.floor(audioRef.current.currentTime * 1000),
      timestamp: Date.now(),
    }

    // Fire and forget
    api.reportPlaybackEvent(event).catch(() => {})
  }, [currentTrack])

  // Track 30-second mark for stream counting
  const hasReportedStream = useRef(false)
  useEffect(() => {
    hasReportedStream.current = false
  }, [currentTrack?.id])

  const handleTimeUpdate = useCallback(() => {
    if (!audioRef.current) return

    const timeMs = audioRef.current.currentTime * 1000
    setCurrentTime(timeMs)

    // Report stream at 30 seconds
    if (!hasReportedStream.current && timeMs >= 30000) {
      hasReportedStream.current = true
      reportEvent('progress')
    }
  }, [setCurrentTime, reportEvent])

  return (
    <audio
      ref={audioRef}
      onTimeUpdate={handleTimeUpdate}
      onEnded={onTrackEnd}
      onPlay={() => reportEvent('start')}
      preload="auto"
    />
  )
}
```

### Backend: Playback Event Processing

```typescript
// backend/src/routes/playback.ts (continued)
import { kafka } from '../shared/queue.js'
import { pool } from '../shared/db.js'

router.post('/events', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const event: PlaybackEvent = req.body

  // Generate idempotency key
  const idempotencyKey = `${userId}_${event.trackId}_${event.timestamp}`

  // Check for duplicate
  const processed = await redis.get(`playback:${idempotencyKey}`)
  if (processed) {
    return res.json({ deduplicated: true })
  }

  // Mark as processing
  const acquired = await redis.set(
    `playback:${idempotencyKey}`,
    'processing',
    'NX', 'EX', 86400
  )
  if (!acquired) {
    return res.json({ deduplicated: true })
  }

  // Send to Kafka for async processing
  await kafka.send('playback_events', {
    userId,
    ...event,
    idempotencyKey,
  })

  res.json({ success: true })
})

// Kafka consumer (separate process)
// backend/src/workers/playback-consumer.ts
async function processPlaybackEvent(message: KafkaMessage) {
  const event = JSON.parse(message.value.toString())

  // Count as stream if 30+ seconds
  if (event.eventType === 'progress' && event.position >= 30000) {
    // Increment stream count
    await pool.query(`
      UPDATE tracks SET stream_count = stream_count + 1
      WHERE id = $1
    `, [event.trackId])

    // Record for royalty attribution
    await pool.query(`
      INSERT INTO playback_events
        (user_id, track_id, event_type, position_ms, timestamp, idempotency_key)
      VALUES ($1, $2, 'stream_counted', $3, $4, $5)
      ON CONFLICT (idempotency_key) DO NOTHING
    `, [event.userId, event.trackId, event.position,
        new Date(event.timestamp), event.idempotencyKey])

    // Update listening history for recommendations
    await pool.query(`
      INSERT INTO listening_history
        (user_id, track_id, played_at, duration_played_ms, completed)
      VALUES ($1, $2, $3, $4, $5)
    `, [event.userId, event.trackId, new Date(event.timestamp),
        event.position, event.eventType === 'complete'])
  }
}
```

---

## Deep Dive: Playlist Management (10 minutes)

### Backend: Playlist API with Idempotency

```typescript
// backend/src/routes/playlists.ts
import { Router } from 'express'
import { requireAuth } from '../shared/auth.js'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'

const router = Router()

// Get playlist with tracks
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params

  // Check cache
  const cached = await redis.get(`playlist:${id}`)
  if (cached) {
    return res.json(JSON.parse(cached))
  }

  const playlist = await pool.query(`
    SELECT p.*,
      u.display_name as owner_name,
      json_agg(
        json_build_object(
          'id', t.id,
          'title', t.title,
          'duration_ms', t.duration_ms,
          'explicit', t.explicit,
          'position', pt.position,
          'added_at', pt.added_at,
          'album', json_build_object(
            'id', al.id,
            'title', al.title,
            'cover_url', al.cover_url
          ),
          'artist', json_build_object(
            'id', ar.id,
            'name', ar.name
          )
        ) ORDER BY pt.position
      ) as tracks
    FROM playlists p
    JOIN users u ON p.owner_id = u.id
    LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    LEFT JOIN tracks t ON pt.track_id = t.id
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN artists ar ON al.artist_id = ar.id
    WHERE p.id = $1
    GROUP BY p.id, u.display_name
  `, [id])

  if (!playlist.rows[0]) {
    return res.status(404).json({ error: 'Playlist not found' })
  }

  // Cache for 5 minutes
  await redis.setex(`playlist:${id}`, 300, JSON.stringify(playlist.rows[0]))

  res.json(playlist.rows[0])
})

// Add track to playlist (idempotent)
router.post('/:id/tracks', requireAuth, async (req, res) => {
  const { id } = req.params
  const { trackId } = req.body
  const userId = req.session.userId
  const idempotencyKey = req.headers['x-idempotency-key'] as string

  // Check playlist ownership/collaboration
  const canEdit = await canEditPlaylist(userId, id)
  if (!canEdit) {
    return res.status(403).json({ error: 'Cannot edit this playlist' })
  }

  // Idempotency check
  if (idempotencyKey) {
    const existing = await redis.get(`playlist_add:${idempotencyKey}`)
    if (existing) {
      return res.json(JSON.parse(existing))
    }
  }

  // Add track with next position
  const result = await pool.query(`
    INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by)
    VALUES (
      $1,
      $2,
      (SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_tracks WHERE playlist_id = $1),
      $3
    )
    ON CONFLICT (playlist_id, track_id) DO NOTHING
    RETURNING *
  `, [id, trackId, userId])

  // Invalidate cache
  await redis.del(`playlist:${id}`)

  const response = {
    success: result.rowCount > 0,
    track: result.rows[0] || null,
  }

  // Store result for idempotency
  if (idempotencyKey) {
    await redis.setex(`playlist_add:${idempotencyKey}`, 300, JSON.stringify(response))
  }

  res.json(response)
})

// Reorder tracks
router.put('/:id/tracks/reorder', requireAuth, async (req, res) => {
  const { id } = req.params
  const { trackId, fromPosition, toPosition } = req.body
  const userId = req.session.userId

  const canEdit = await canEditPlaylist(userId, id)
  if (!canEdit) {
    return res.status(403).json({ error: 'Cannot edit this playlist' })
  }

  // Update positions in a transaction
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    if (fromPosition < toPosition) {
      // Moving down: shift tracks up
      await client.query(`
        UPDATE playlist_tracks
        SET position = position - 1
        WHERE playlist_id = $1 AND position > $2 AND position <= $3
      `, [id, fromPosition, toPosition])
    } else {
      // Moving up: shift tracks down
      await client.query(`
        UPDATE playlist_tracks
        SET position = position + 1
        WHERE playlist_id = $1 AND position >= $2 AND position < $3
      `, [id, toPosition, fromPosition])
    }

    // Set new position
    await client.query(`
      UPDATE playlist_tracks
      SET position = $3
      WHERE playlist_id = $1 AND track_id = $2
    `, [id, trackId, toPosition])

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  // Invalidate cache
  await redis.del(`playlist:${id}`)

  res.json({ success: true })
})

async function canEditPlaylist(userId: string, playlistId: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT 1 FROM playlists
    WHERE id = $1 AND (owner_id = $2 OR is_collaborative = true)
  `, [playlistId, userId])
  return result.rowCount > 0
}

export { router as playlistRouter }
```

### Frontend: Playlist Component with Optimistic Updates

```tsx
// frontend/src/routes/playlist.$id.tsx
import { useParams } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { DndContext, closestCenter, DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '../services/api'
import { usePlayerStore } from '../stores/playerStore'
import { TrackRow } from '../components/TrackRow'

export function PlaylistRoute() {
  const { id } = useParams({ from: '/playlist/$id' })
  const queryClient = useQueryClient()
  const { playQueue } = usePlayerStore()

  // Fetch playlist data
  const { data: playlist, isLoading } = useQuery({
    queryKey: ['playlist', id],
    queryFn: () => api.getPlaylist(id),
  })

  // Reorder mutation with optimistic update
  const reorderMutation = useMutation({
    mutationFn: (params: {
      trackId: string
      fromPosition: number
      toPosition: number
    }) => api.reorderPlaylistTrack(id, params),

    onMutate: async ({ trackId, fromPosition, toPosition }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['playlist', id] })

      // Snapshot previous value
      const previous = queryClient.getQueryData(['playlist', id])

      // Optimistically update
      queryClient.setQueryData(['playlist', id], (old: typeof playlist) => {
        if (!old) return old

        const tracks = [...old.tracks]
        const [moved] = tracks.splice(fromPosition, 1)
        tracks.splice(toPosition, 0, moved)

        // Update positions
        return {
          ...old,
          tracks: tracks.map((t, i) => ({ ...t, position: i + 1 })),
        }
      })

      return { previous }
    },

    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previous) {
        queryClient.setQueryData(['playlist', id], context.previous)
      }
    },

    onSettled: () => {
      // Refetch to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['playlist', id] })
    },
  })

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const tracks = playlist?.tracks || []
    const fromPosition = tracks.findIndex(t => t.id === active.id)
    const toPosition = tracks.findIndex(t => t.id === over.id)

    if (fromPosition !== -1 && toPosition !== -1) {
      reorderMutation.mutate({
        trackId: active.id as string,
        fromPosition,
        toPosition,
      })
    }
  }

  const handlePlayPlaylist = (startIndex = 0) => {
    if (playlist?.tracks) {
      playQueue(playlist.tracks, startIndex)
    }
  }

  if (isLoading) {
    return <PlaylistSkeleton />
  }

  if (!playlist) {
    return <div>Playlist not found</div>
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <header className="flex items-end gap-6 p-6 bg-gradient-to-b from-neutral-700 to-neutral-900">
        <img
          src={playlist.cover_url || '/default-playlist.png'}
          alt=""
          className="w-48 h-48 shadow-2xl"
        />
        <div>
          <span className="text-sm uppercase">Playlist</span>
          <h1 className="text-5xl font-bold mt-2">{playlist.name}</h1>
          <p className="text-neutral-400 mt-4">
            {playlist.owner_name} - {playlist.tracks.length} songs
          </p>
        </div>
      </header>

      {/* Controls */}
      <div className="flex items-center gap-4 p-6">
        <button
          onClick={() => handlePlayPlaylist(0)}
          className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center
            hover:scale-105 transition-transform"
        >
          <PlayIcon className="w-6 h-6 text-black ml-1" />
        </button>
      </div>

      {/* Track list with drag and drop */}
      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={playlist.tracks.map(t => t.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="flex flex-col">
            {playlist.tracks.map((track, index) => (
              <SortableTrackRow
                key={track.id}
                track={track}
                index={index}
                onPlay={() => handlePlayPlaylist(index)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableTrackRow({ track, index, onPlay }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <TrackRow
        track={track}
        index={index}
        onPlay={onPlay}
        dragHandleProps={listeners}
      />
    </div>
  )
}
```

---

## Deep Dive: Recommendations Pipeline (8 minutes)

### Backend: Discover Weekly Generation

```typescript
// backend/src/services/recommendations.ts
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { vectorDb } from '../shared/vectorDb.js'

interface RecommendationResult {
  tracks: Track[]
  generatedAt: number
  algorithm: string
}

export async function generateDiscoverWeekly(
  userId: string
): Promise<RecommendationResult> {
  // Check cache first (valid for 1 week)
  const cached = await redis.get(`discover_weekly:${userId}`)
  if (cached) {
    return JSON.parse(cached)
  }

  // 1. Get user's listening history (last 28 days)
  const history = await pool.query(`
    SELECT track_id, COUNT(*) as play_count,
           AVG(CASE WHEN completed THEN 1.0 ELSE 0.5 END) as engagement
    FROM listening_history
    WHERE user_id = $1 AND played_at > NOW() - INTERVAL '28 days'
    GROUP BY track_id
    ORDER BY play_count DESC
    LIMIT 100
  `, [userId])

  const historyTrackIds = history.rows.map(r => r.track_id)

  // 2. Collaborative filtering: Find similar users
  const userEmbedding = await vectorDb.getUserEmbedding(userId)
  const similarUsers = await vectorDb.findSimilarUsers(userEmbedding, {
    topK: 100,
    exclude: [userId],
  })

  // Get top tracks from similar users
  const collaborativeTracks = await pool.query(`
    SELECT track_id, COUNT(*) as popularity
    FROM listening_history
    WHERE user_id = ANY($1)
      AND track_id != ALL($2)
      AND played_at > NOW() - INTERVAL '7 days'
    GROUP BY track_id
    ORDER BY popularity DESC
    LIMIT 50
  `, [similarUsers.map(u => u.id), historyTrackIds])

  // 3. Content-based: Find similar tracks
  const likedTrackIds = history.rows
    .filter(h => h.engagement > 0.7)
    .map(h => h.track_id)
    .slice(0, 20)

  const trackEmbeddings = await vectorDb.getTrackEmbeddings(likedTrackIds)
  const avgEmbedding = averageVectors(trackEmbeddings)

  const contentBasedTracks = await vectorDb.findSimilarTracks(avgEmbedding, {
    topK: 50,
    exclude: historyTrackIds,
  })

  // 4. Blend results (60% collaborative, 40% content)
  const blended = blendResults(
    collaborativeTracks.rows,
    contentBasedTracks,
    0.6
  )

  // 5. Diversify (max 2 per artist)
  const diversified = diversify(blended, { maxPerArtist: 2, total: 30 })

  // 6. Fetch full track details
  const trackDetails = await pool.query(`
    SELECT t.*,
      json_build_object('id', al.id, 'title', al.title, 'cover_url', al.cover_url) as album,
      json_build_object('id', ar.id, 'name', ar.name) as artist
    FROM tracks t
    JOIN albums al ON t.album_id = al.id
    JOIN artists ar ON al.artist_id = ar.id
    WHERE t.id = ANY($1)
  `, [diversified.map(t => t.track_id)])

  const result: RecommendationResult = {
    tracks: trackDetails.rows,
    generatedAt: Date.now(),
    algorithm: 'hybrid_cf_cb_v1',
  }

  // Cache for 1 week
  await redis.setex(
    `discover_weekly:${userId}`,
    7 * 24 * 3600,
    JSON.stringify(result)
  )

  return result
}

function averageVectors(vectors: number[][]): number[] {
  const dim = vectors[0].length
  const avg = new Array(dim).fill(0)
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      avg[i] += vec[i] / vectors.length
    }
  }
  return avg
}

function blendResults(
  collaborative: Array<{ track_id: string; popularity: number }>,
  contentBased: Array<{ track_id: string; similarity: number }>,
  collaborativeWeight: number
): Array<{ track_id: string; score: number }> {
  const scores = new Map<string, number>()

  // Normalize and add collaborative scores
  const maxCollab = Math.max(...collaborative.map(t => t.popularity))
  for (const t of collaborative) {
    const normalized = t.popularity / maxCollab
    scores.set(t.track_id, (scores.get(t.track_id) || 0) + normalized * collaborativeWeight)
  }

  // Normalize and add content-based scores
  const maxContent = Math.max(...contentBased.map(t => t.similarity))
  for (const t of contentBased) {
    const normalized = t.similarity / maxContent
    scores.set(t.track_id, (scores.get(t.track_id) || 0) + normalized * (1 - collaborativeWeight))
  }

  return Array.from(scores.entries())
    .map(([track_id, score]) => ({ track_id, score }))
    .sort((a, b) => b.score - a.score)
}

function diversify(
  tracks: Array<{ track_id: string; score: number }>,
  options: { maxPerArtist: number; total: number }
): Array<{ track_id: string }> {
  const artistCounts = new Map<string, number>()
  const result: Array<{ track_id: string }> = []

  for (const track of tracks) {
    if (result.length >= options.total) break

    // Would need artist lookup here - simplified
    const artistId = track.track_id.slice(0, 8) // Placeholder

    const count = artistCounts.get(artistId) || 0
    if (count < options.maxPerArtist) {
      result.push(track)
      artistCounts.set(artistId, count + 1)
    }
  }

  return result
}
```

### Frontend: Discover Weekly Display

```tsx
// frontend/src/routes/discover-weekly.tsx
import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'
import { usePlayerStore } from '../stores/playerStore'
import { TrackList } from '../components/TrackList'

export function DiscoverWeeklyRoute() {
  const { playQueue } = usePlayerStore()

  const { data, isLoading, error } = useQuery({
    queryKey: ['discover-weekly'],
    queryFn: () => api.getDiscoverWeekly(),
    staleTime: 1000 * 60 * 60, // 1 hour
  })

  if (isLoading) {
    return <DiscoverWeeklySkeleton />
  }

  if (error) {
    return <div>Failed to load recommendations</div>
  }

  const handlePlay = (startIndex = 0) => {
    if (data?.tracks) {
      playQueue(data.tracks, startIndex)
    }
  }

  // Calculate week dates for display
  const generatedDate = new Date(data?.generatedAt || Date.now())
  const endDate = new Date(generatedDate)
  endDate.setDate(endDate.getDate() + 6)

  return (
    <div className="flex flex-col">
      {/* Header with gradient */}
      <header className="relative p-6 pb-32 bg-gradient-to-b from-purple-800 to-neutral-900">
        <div className="flex items-end gap-6">
          <div className="w-48 h-48 bg-gradient-to-br from-purple-600 to-blue-600
            rounded flex items-center justify-center shadow-2xl">
            <span className="text-6xl">🎵</span>
          </div>
          <div>
            <span className="text-sm uppercase">Made for you</span>
            <h1 className="text-5xl font-bold mt-2">Discover Weekly</h1>
            <p className="text-neutral-300 mt-4">
              Your weekly mixtape of fresh music. Enjoy new discoveries and
              deep cuts chosen just for you. Updated every Monday.
            </p>
            <p className="text-neutral-400 text-sm mt-2">
              {generatedDate.toLocaleDateString()} -{' '}
              {endDate.toLocaleDateString()}
            </p>
          </div>
        </div>
      </header>

      {/* Controls */}
      <div className="flex items-center gap-4 px-6 -mt-20">
        <button
          onClick={() => handlePlay(0)}
          className="w-14 h-14 rounded-full bg-green-500 flex items-center justify-center
            hover:scale-105 transition-transform shadow-lg"
          aria-label="Play Discover Weekly"
        >
          <PlayIcon className="w-6 h-6 text-black ml-1" />
        </button>
      </div>

      {/* Track list */}
      <div className="mt-6">
        <TrackList
          tracks={data?.tracks || []}
          context={{ type: 'discover_weekly', id: 'weekly', name: 'Discover Weekly' }}
        />
      </div>
    </div>
  )
}
```

---

## API Layer Design

### API Client (Frontend)

```typescript
// frontend/src/services/api.ts
import type { Track, Playlist, StreamResponse, PlaybackEvent } from '../../../shared/types'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api'

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.message || `API error: ${response.status}`)
  }

  return response.json()
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    fetchApi('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => fetchApi('/auth/logout', { method: 'POST' }),

  getMe: () => fetchApi<{ user: User }>('/auth/me'),

  // Playback
  getStreamUrl: (trackId: string) =>
    fetchApi<StreamResponse>(`/playback/stream/${trackId}`),

  reportPlaybackEvent: (event: PlaybackEvent) =>
    fetchApi('/playback/events', {
      method: 'POST',
      body: JSON.stringify(event),
    }),

  // Library
  getLibrary: (type: 'tracks' | 'albums' | 'playlists') =>
    fetchApi<{ items: any[] }>(`/library/${type}`),

  saveToLibrary: (type: string, itemId: string) =>
    fetchApi(`/library/${type}/${itemId}`, { method: 'PUT' }),

  removeFromLibrary: (type: string, itemId: string) =>
    fetchApi(`/library/${type}/${itemId}`, { method: 'DELETE' }),

  // Playlists
  getPlaylist: (id: string) => fetchApi<Playlist>(`/playlists/${id}`),

  createPlaylist: (name: string, isPublic = true) =>
    fetchApi<Playlist>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, isPublic }),
    }),

  addTrackToPlaylist: (playlistId: string, trackId: string, idempotencyKey: string) =>
    fetchApi(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ trackId }),
    }),

  reorderPlaylistTrack: (
    playlistId: string,
    params: { trackId: string; fromPosition: number; toPosition: number }
  ) =>
    fetchApi(`/playlists/${playlistId}/tracks/reorder`, {
      method: 'PUT',
      body: JSON.stringify(params),
    }),

  // Recommendations
  getDiscoverWeekly: () =>
    fetchApi<{ tracks: Track[]; generatedAt: number }>('/recommendations/discover-weekly'),

  getDailyMix: (mixId: string) =>
    fetchApi<{ tracks: Track[] }>(`/recommendations/daily-mix/${mixId}`),

  // Search
  search: (query: string, types: string[] = ['track', 'album', 'artist']) =>
    fetchApi<SearchResults>(`/search?q=${encodeURIComponent(query)}&types=${types.join(',')}`),

  // Catalog
  getArtist: (id: string) => fetchApi<Artist>(`/artists/${id}`),
  getAlbum: (id: string) => fetchApi<Album>(`/albums/${id}`),
  getTrack: (id: string) => fetchApi<Track>(`/tracks/${id}`),
}
```

---

## Session Management

### Backend Session Middleware

```typescript
// backend/src/shared/auth.ts
import { redis } from './cache.js'
import { pool } from './db.js'

export async function requireAuth(req, res, next) {
  const sessionId = req.cookies.session

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const session = await redis.hgetall(`session:${sessionId}`)

  if (!session.userId) {
    return res.status(401).json({ error: 'Session expired' })
  }

  // Sliding expiration
  await redis.expire(`session:${sessionId}`, 14400)  // 4 hours

  req.session = {
    userId: session.userId,
    email: session.email,
    isPremium: session.isPremium === 'true',
  }

  next()
}

export async function createSession(userId: string): Promise<string> {
  const user = await pool.query(
    'SELECT id, email, subscription FROM users WHERE id = $1',
    [userId]
  )

  const sessionId = crypto.randomUUID()

  await redis.hset(`session:${sessionId}`, {
    userId: user.rows[0].id,
    email: user.rows[0].email,
    isPremium: user.rows[0].subscription === 'premium' ? 'true' : 'false',
    createdAt: Date.now().toString(),
  })

  await redis.expire(`session:${sessionId}`, 14400)

  return sessionId
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand (frontend) | Redux Toolkit | Simpler API, built-in persistence |
| Audio Delivery | CDN + signed URLs | Direct streaming | Global scale, 90%+ cache hit rate |
| Playlist Sync | Optimistic updates + refetch | WebSocket real-time | Simpler, works for most cases |
| Recommendations | Pre-computed weekly | Real-time | Balance freshness vs compute cost |
| Drag-and-Drop | @dnd-kit | react-beautiful-dnd | Better maintained, more flexible |
| Event Processing | Kafka | Direct DB writes | Throughput, multi-consumer |

---

## Future Enhancements (Full-Stack Focus)

1. **Spotify Connect**: WebSocket-based cross-device playback control
2. **Collaborative Playlist Real-time**: WebSocket updates for simultaneous editing
3. **Offline Mode**: IndexedDB + Service Worker with sync queue
4. **Social Features**: Friend activity feed, listening together
5. **A/B Testing**: Feature flags with analytics to compare recommendation algorithms
6. **Lyrics Sync**: Time-synced lyrics from backend, rendered in frontend

---

## Summary

"To summarize the full-stack architecture:

1. **Streaming pipeline**: Frontend Audio controller fetches signed URLs from backend, reports 30-second marks for royalty attribution via Kafka
2. **Shared types**: TypeScript interfaces used by both frontend and backend for type safety
3. **Playlist management**: Backend handles idempotent writes with cache invalidation, frontend uses optimistic updates with React Query
4. **Recommendations**: Backend generates weekly using collaborative + content-based filtering, cached for 7 days, displayed in frontend with play integration
5. **Session auth**: Redis-based sessions with sliding expiration, shared across services

The architecture prioritizes seamless playback experience while maintaining accurate analytics for royalty payments.

What aspects would you like to explore further?"
