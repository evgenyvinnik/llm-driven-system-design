# Apple Music - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Music as a fullstack system, focusing on the end-to-end flows that connect the React frontend to the backend services. The key technical challenges span both layers: adaptive streaming with quality negotiation between client and server, library synchronization that handles offline changes with conflict resolution, and personalized recommendations that update dynamically as users listen.

For a music streaming platform, I'll demonstrate how frontend state management coordinates with backend APIs to deliver gapless playback, instant library updates through optimistic UI, and real-time sync across devices."

## Requirements Clarification (3 minutes)

### Functional Requirements (End-to-End)
- **Streaming**: Quality negotiation, gapless transitions, network adaptation
- **Library Sync**: Add/remove with optimistic UI, cross-device synchronization
- **Search**: Instant autocomplete with backend catalog queries
- **Recommendations**: Personalized sections updated by listening behavior
- **Playlists**: CRUD with collaborative editing support

### Non-Functional Requirements
- **E2E Latency**: < 200ms for stream start (URL fetch + buffer)
- **Sync Consistency**: Library changes visible across devices in < 5 seconds
- **Offline Resilience**: Queue changes locally, sync on reconnect
- **Error Recovery**: Graceful degradation with retry mechanisms

### Integration Points
- Frontend audio player with backend stream URL generation
- Library store with delta sync API
- Search UI with catalog search endpoint
- Recommendation cards with personalization API

## System Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   Player    │  │   Library   │  │   Search    │  │  Discovery  │ │
│  │   Store     │  │   Store     │  │     UI      │  │   Cards     │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                │                │                │         │
│         └────────────────┴────────────────┴────────────────┘         │
│                                   │                                   │
│                           TanStack Query                              │
│                                   │                                   │
└───────────────────────────────────┼───────────────────────────────────┘
                                    │ HTTP/REST
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│                         Backend (Express)                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Streaming  │  │   Library   │  │   Catalog   │  │  Discovery  │   │
│  │   Routes    │  │   Routes    │  │   Routes    │  │   Routes    │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘   │
│         │                │                │                │           │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐   │
│  │                       Shared Services                           │   │
│  │   Auth │ Rate Limit │ Cache │ Metrics │ Logger                 │   │
│  └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
              │PostgreSQL │  │   Redis   │  │   MinIO   │
              │(catalog,  │  │(sessions, │  │ (audio,   │
              │ library)  │  │  cache)   │  │ artwork)  │
              └───────────┘  └───────────┘  └───────────┘
```

## Deep Dive: Streaming Flow (8 minutes)

### End-to-End Sequence

```
┌────────┐       ┌────────┐       ┌────────┐       ┌────────┐       ┌────────┐
│Frontend│       │  API   │       │Streaming│      │  MinIO │       │  CDN   │
│ Player │       │Gateway │       │ Service │      │        │       │        │
└───┬────┘       └───┬────┘       └────┬────┘      └───┬────┘       └───┬────┘
    │                │                 │               │               │
    │ GET /stream/   │                 │               │               │
    │   {trackId}    │                 │               │               │
    ├───────────────►│                 │               │               │
    │                │ Forward +       │               │               │
    │                │ auth context    │               │               │
    │                ├────────────────►│               │               │
    │                │                 │ Check sub,    │               │
    │                │                 │ select quality│               │
    │                │                 ├───────────────┤               │
    │                │                 │               │               │
    │                │                 │ Generate      │               │
    │                │                 │ signed URL    │               │
    │                │                 ├──────────────►│               │
    │                │                 │               │ presignedUrl  │
    │                │                 │◄──────────────┤               │
    │ {url, quality} │                 │               │               │
    │◄───────────────┼─────────────────┤               │               │
    │                │                 │               │               │
    │ Fetch audio    │                 │               │               │
    ├────────────────┼─────────────────┼───────────────┼──────────────►│
    │                │                 │               │               │
    │ Audio stream   │                 │               │               │
    │◄───────────────┼─────────────────┼───────────────┼───────────────┤
    │                │                 │               │               │
```

### Frontend: Audio Player with Quality Selection

```typescript
// hooks/useStreamPlayer.ts
export function useStreamPlayer() {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const nextAudioRef = useRef<HTMLAudioElement>(new Audio());

  const { currentTrack, isPlaying, queue, queueIndex } = usePlayerStore();
  const queryClient = useQueryClient();

  // Fetch stream URL from backend
  const { data: streamInfo, isLoading } = useQuery({
    queryKey: ['stream', currentTrack?.id],
    queryFn: async () => {
      if (!currentTrack) return null;

      const response = await api.get(`/stream/${currentTrack.id}`, {
        headers: {
          'X-Network-Type': getNetworkType(), // wifi, 4g, 3g
          'X-Preferred-Quality': localStorage.getItem('preferredQuality') || 'high'
        }
      });

      return response.data;
    },
    enabled: !!currentTrack,
    staleTime: 30 * 60 * 1000 // 30 min
  });

  // Load audio when stream URL received
  useEffect(() => {
    if (!streamInfo?.url) return;

    audioRef.current.src = streamInfo.url;
    audioRef.current.load();

    if (isPlaying) {
      audioRef.current.play();
    }

    // Prefetch next track for gapless playback
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) {
      queryClient.prefetchQuery({
        queryKey: ['stream', queue[nextIndex].id],
        queryFn: () => api.get(`/stream/${queue[nextIndex].id}`)
      });
    }
  }, [streamInfo?.url]);

  // Track ended - transition to next
  useEffect(() => {
    const audio = audioRef.current;

    const handleEnded = () => {
      const nextTrack = queue[queueIndex + 1];
      if (nextTrack) {
        // Use prefetched stream URL
        const cachedStream = queryClient.getQueryData(['stream', nextTrack.id]);
        if (cachedStream) {
          nextAudioRef.current.src = cachedStream.url;
          nextAudioRef.current.play();

          // Swap refs
          [audioRef.current, nextAudioRef.current] = [nextAudioRef.current, audioRef.current];
        }

        usePlayerStore.getState().next();
      }
    };

    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [queueIndex, queue]);

  return { streamInfo, isLoading };
}
```

### Backend: Streaming Service

```typescript
// backend/src/routes/streaming.ts
router.get('/stream/:trackId', requireAuth, async (req, res) => {
  const { trackId } = req.params;
  const userId = req.session.userId;
  const networkType = req.headers['x-network-type'] || 'wifi';
  const preferredQuality = req.headers['x-preferred-quality'] || 'high';

  const startTime = Date.now();

  try {
    // Get user subscription tier
    const user = await db.query(
      'SELECT subscription_tier, preferred_quality FROM users WHERE id = $1',
      [userId]
    );

    // Determine max quality based on subscription
    const maxQuality = getMaxQuality(user.rows[0].subscription_tier);

    // Select quality based on network and preferences
    const selectedQuality = selectQuality(
      preferredQuality,
      networkType,
      maxQuality
    );

    // Get audio file for selected quality
    const audioFile = await db.query(`
      SELECT id, minio_key, bitrate, format, sample_rate
      FROM audio_files
      WHERE track_id = $1 AND quality = $2
    `, [trackId, selectedQuality]);

    if (!audioFile.rows[0]) {
      return res.status(404).json({ error: 'Audio file not found' });
    }

    // Generate presigned URL (1 hour expiry)
    const presignedUrl = await minio.presignedGetObject(
      'audio-files',
      audioFile.rows[0].minio_key,
      3600
    );

    // Record metrics
    const latency = (Date.now() - startTime) / 1000;
    metrics.streamStartLatency.observe(latency);
    metrics.streamsTotal.inc({
      quality: selectedQuality,
      tier: user.rows[0].subscription_tier
    });

    // Log stream event
    logger.info({
      event: 'stream_started',
      userId,
      trackId,
      quality: selectedQuality,
      networkType,
      latencyMs: Date.now() - startTime
    });

    res.json({
      url: presignedUrl,
      quality: selectedQuality,
      format: audioFile.rows[0].format,
      bitrate: audioFile.rows[0].bitrate,
      expiresAt: Date.now() + 3600000
    });
  } catch (error) {
    logger.error({ error, trackId, userId }, 'Stream URL generation failed');
    res.status(500).json({ error: 'Failed to generate stream URL' });
  }
});

function selectQuality(
  preferred: string,
  network: string,
  max: string
): string {
  const qualities = ['256_aac', 'lossless', 'hi_res_lossless'];
  const preferredIndex = qualities.indexOf(preferred);
  const maxIndex = qualities.indexOf(max);

  const networkMax: Record<string, string> = {
    'wifi': 'hi_res_lossless',
    '5g': 'lossless',
    '4g': '256_aac',
    '3g': '256_aac'
  };

  const networkIndex = qualities.indexOf(networkMax[network] || '256_aac');

  return qualities[Math.min(preferredIndex, maxIndex, networkIndex)];
}
```

## Deep Dive: Library Sync Flow (8 minutes)

### End-to-End Sync Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Device A                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         Library Store                                │   │
│  │  syncToken: 42  │  tracks: [...]  │  pendingChanges: []             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                          User adds track                                    │
│                                    │                                        │
│                           ┌────────┴────────┐                              │
│                           │ Optimistic      │                              │
│                           │ Update UI       │                              │
│                           └────────┬────────┘                              │
│                                    │                                        │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │ POST /library
                                     ▼
                        ┌─────────────────────────┐
                        │      Backend API        │
                        │                         │
                        │  Transaction:           │
                        │  1. Insert library_item │
                        │  2. Insert sync_change  │
                        │  3. Notify devices      │
                        └────────────┬────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
       ┌────────────┐         ┌────────────┐         ┌────────────┐
       │ PostgreSQL │         │   Redis    │         │   Push     │
       │            │         │  (cache    │         │  Service   │
       │ library_   │         │  invalidate)│        │            │
       │ changes    │         │            │         │            │
       └────────────┘         └────────────┘         └─────┬──────┘
                                                           │
                                     ┌─────────────────────┘
                                     │ Push notification
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                              Device B                                       │
│                                    │                                        │
│                           ┌────────┴────────┐                              │
│                           │ Receive push    │                              │
│                           │ "library_changed"│                             │
│                           └────────┬────────┘                              │
│                                    │                                        │
│                           ┌────────┴────────┐                              │
│                           │ GET /library/   │                              │
│                           │ sync?token=35   │                              │
│                           └────────┬────────┘                              │
│                                    │                                        │
│                           ┌────────┴────────┐                              │
│                           │ Apply delta     │                              │
│                           │ changes to UI   │                              │
│                           └─────────────────┘                              │
└────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Library Store with Optimistic Updates

```typescript
// stores/libraryStore.ts
interface LibraryState {
  tracks: Track[];
  albums: Album[];
  syncToken: number | null;
  isSyncing: boolean;
  pendingChanges: LibraryChange[];
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      tracks: [],
      albums: [],
      syncToken: null,
      isSyncing: false,
      pendingChanges: [],

      addToLibrary: async (item: LibraryItem) => {
        const optimisticId = crypto.randomUUID();

        // 1. Optimistic update - instant UI feedback
        set((state) => ({
          [item.type + 's']: [...state[item.type + 's'], { ...item, _optimistic: true }],
          pendingChanges: [
            ...state.pendingChanges,
            { id: optimisticId, action: 'add', item }
          ]
        }));

        try {
          // 2. Send to backend
          const response = await api.post('/library', {
            itemType: item.type,
            itemId: item.id
          });

          // 3. Confirm and update sync token
          set((state) => ({
            [item.type + 's']: state[item.type + 's'].map((i) =>
              i.id === item.id ? { ...i, _optimistic: false } : i
            ),
            syncToken: response.syncToken,
            pendingChanges: state.pendingChanges.filter(c => c.id !== optimisticId)
          }));
        } catch (error) {
          // 4. Rollback on failure
          set((state) => ({
            [item.type + 's']: state[item.type + 's'].filter(i => i.id !== item.id),
            pendingChanges: state.pendingChanges.filter(c => c.id !== optimisticId)
          }));

          throw error;
        }
      },

      syncLibrary: async () => {
        const { syncToken, pendingChanges } = get();

        // Don't sync if we have pending local changes
        if (pendingChanges.length > 0) {
          return;
        }

        set({ isSyncing: true });

        try {
          const response = await api.get('/library/sync', {
            params: { syncToken }
          });

          // Apply delta changes
          set((state) => {
            let tracks = [...state.tracks];
            let albums = [...state.albums];

            for (const change of response.changes) {
              if (change.changeType === 'add') {
                if (change.itemType === 'track') {
                  // Avoid duplicates
                  if (!tracks.find(t => t.id === change.itemId)) {
                    tracks.push(change.data);
                  }
                } else if (change.itemType === 'album') {
                  if (!albums.find(a => a.id === change.itemId)) {
                    albums.push(change.data);
                  }
                }
              } else if (change.changeType === 'remove') {
                if (change.itemType === 'track') {
                  tracks = tracks.filter(t => t.id !== change.itemId);
                } else if (change.itemType === 'album') {
                  albums = albums.filter(a => a.id !== change.itemId);
                }
              }
            }

            return {
              tracks,
              albums,
              syncToken: response.syncToken,
              isSyncing: false
            };
          });
        } catch {
          set({ isSyncing: false });
        }
      }
    }),
    {
      name: 'apple-music-library',
      partialize: (state) => ({
        tracks: state.tracks,
        albums: state.albums,
        syncToken: state.syncToken,
        pendingChanges: state.pendingChanges
      })
    }
  )
);

// Hook to sync on visibility change
export function useLibrarySync() {
  const syncLibrary = useLibraryStore((s) => s.syncLibrary);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        syncLibrary();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    // Also sync on mount
    syncLibrary();

    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [syncLibrary]);
}
```

### Backend: Library Sync Endpoint

```typescript
// backend/src/routes/library.ts
router.post('/', requireAuth, async (req, res) => {
  const { itemType, itemId } = req.body;
  const userId = req.session.userId;

  try {
    await db.transaction(async (tx) => {
      // 1. Add to library (idempotent)
      await tx.query(`
        INSERT INTO library_items (user_id, item_type, item_id, added_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id, item_type, item_id) DO NOTHING
      `, [userId, itemType, itemId]);

      // 2. Record change for sync
      await tx.query(`
        INSERT INTO library_changes
          (user_id, change_type, item_type, item_id, data, sync_token)
        VALUES ($1, 'add', $2, $3, $4, nextval('sync_token_seq'))
      `, [userId, itemType, itemId, JSON.stringify({ itemId, itemType })]);
    });

    // 3. Get new sync token
    const tokenResult = await db.query(
      "SELECT currval('sync_token_seq') as token"
    );

    // 4. Invalidate cache
    await redis.del(`library:${userId}`);

    // 5. Notify other devices
    await pushService.notifyUser(userId, {
      type: 'library_changed',
      syncToken: tokenResult.rows[0].token
    });

    // 6. Record metrics
    metrics.libraryOperations.inc({ operation: 'add', item_type: itemType });

    res.json({ success: true, syncToken: tokenResult.rows[0].token });
  } catch (error) {
    logger.error({ error, userId, itemType, itemId }, 'Failed to add to library');
    res.status(500).json({ error: 'Failed to add to library' });
  }
});

router.get('/sync', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const clientSyncToken = parseInt(req.query.syncToken as string) || 0;

  try {
    // Get all changes since client's last sync
    const changes = await db.query(`
      SELECT
        lc.change_type,
        lc.item_type,
        lc.item_id,
        lc.sync_token,
        lc.created_at,
        CASE
          WHEN lc.item_type = 'track' THEN row_to_json(t.*)
          WHEN lc.item_type = 'album' THEN row_to_json(al.*)
        END as data
      FROM library_changes lc
      LEFT JOIN tracks t ON lc.item_type = 'track' AND lc.item_id = t.id
      LEFT JOIN albums al ON lc.item_type = 'album' AND lc.item_id = al.id
      WHERE lc.user_id = $1 AND lc.sync_token > $2
      ORDER BY lc.sync_token ASC
      LIMIT 1000
    `, [userId, clientSyncToken]);

    // Get current max sync token for this user
    const tokenResult = await db.query(`
      SELECT COALESCE(MAX(sync_token), 0) as token
      FROM library_changes
      WHERE user_id = $1
    `, [userId]);

    res.json({
      changes: changes.rows.map(row => ({
        changeType: row.change_type,
        itemType: row.item_type,
        itemId: row.item_id,
        data: row.data,
        timestamp: row.created_at
      })),
      syncToken: tokenResult.rows[0].token,
      hasMore: changes.rows.length >= 1000
    });
  } catch (error) {
    logger.error({ error, userId }, 'Library sync failed');
    res.status(500).json({ error: 'Sync failed' });
  }
});
```

## Deep Dive: Recommendation Flow (5 minutes)

### Frontend: For You Page

```tsx
// pages/ForYouPage.tsx
export function ForYouPage() {
  const { data: sections, isLoading } = useQuery({
    queryKey: ['forYou'],
    queryFn: () => api.get('/discover/for-you'),
    staleTime: 5 * 60 * 1000 // 5 min
  });

  if (isLoading) {
    return <ForYouSkeleton />;
  }

  return (
    <div className="space-y-8 p-6">
      {sections?.map((section) => (
        <section key={section.title}>
          <h2 className="text-2xl font-bold text-white mb-4">
            {section.title}
          </h2>

          {section.type === 'albums' && (
            <div className="grid grid-cols-5 gap-4">
              {section.items.map((album) => (
                <AlbumCard key={album.id} album={album} />
              ))}
            </div>
          )}

          {section.type === 'playlist' && (
            <PlaylistRow items={section.items} />
          )}

          {section.type === 'songs' && (
            <TrackList tracks={section.items} />
          )}
        </section>
      ))}
    </div>
  );
}
```

### Backend: Recommendation Engine

```typescript
// backend/src/routes/discover.ts
router.get('/for-you', requireAuth, async (req, res) => {
  const userId = req.session.userId;

  try {
    const sections = [];

    // 1. Heavy Rotation - most played albums recently
    const heavyRotation = await db.query(`
      SELECT
        al.id, al.title, al.artwork_url,
        a.name AS artist_name,
        COUNT(*) AS play_count
      FROM listening_history lh
      JOIN tracks t ON lh.track_id = t.id
      JOIN albums al ON t.album_id = al.id
      JOIN artists a ON al.artist_id = a.id
      WHERE lh.user_id = $1
        AND lh.played_at > NOW() - INTERVAL '14 days'
        AND lh.completed = true
      GROUP BY al.id, al.title, al.artwork_url, a.name
      ORDER BY play_count DESC
      LIMIT 10
    `, [userId]);

    if (heavyRotation.rows.length > 0) {
      sections.push({
        title: 'Heavy Rotation',
        type: 'albums',
        items: heavyRotation.rows
      });
    }

    // 2. Get user's top genres
    const topGenres = await db.query(`
      SELECT tg.genre, COUNT(*) as count
      FROM listening_history lh
      JOIN track_genres tg ON lh.track_id = tg.track_id
      WHERE lh.user_id = $1
        AND lh.played_at > NOW() - INTERVAL '30 days'
      GROUP BY tg.genre
      ORDER BY count DESC
      LIMIT 3
    `, [userId]);

    // 3. Generate genre mixes
    for (const { genre } of topGenres.rows) {
      const mix = await generateGenreMix(userId, genre);
      sections.push({
        title: `${genre} Mix`,
        type: 'playlist',
        items: mix
      });
    }

    // 4. New releases from library artists
    const newReleases = await db.query(`
      SELECT DISTINCT ON (al.id)
        al.id, al.title, al.artwork_url, al.release_date,
        a.name AS artist_name
      FROM albums al
      JOIN artists a ON al.artist_id = a.id
      WHERE a.id IN (
        SELECT DISTINCT t.artist_id
        FROM library_items li
        JOIN tracks t ON li.item_id = t.id
        WHERE li.user_id = $1 AND li.item_type = 'track'
      )
      AND al.release_date > NOW() - INTERVAL '30 days'
      ORDER BY al.id, al.release_date DESC
      LIMIT 10
    `, [userId]);

    if (newReleases.rows.length > 0) {
      sections.push({
        title: 'New Releases',
        type: 'albums',
        items: newReleases.rows
      });
    }

    res.json(sections);
  } catch (error) {
    logger.error({ error, userId }, 'Failed to generate recommendations');
    res.status(500).json({ error: 'Failed to generate recommendations' });
  }
});

async function generateGenreMix(userId: string, genre: string) {
  // Find tracks in genre not recently played
  const tracks = await db.query(`
    SELECT t.id, t.title, t.duration_ms,
           a.name as artist_name,
           al.artwork_url
    FROM tracks t
    JOIN track_genres tg ON t.id = tg.track_id
    JOIN artists a ON t.artist_id = a.id
    JOIN albums al ON t.album_id = al.id
    WHERE tg.genre = $1
      AND t.id NOT IN (
        SELECT track_id FROM listening_history
        WHERE user_id = $2
          AND played_at > NOW() - INTERVAL '7 days'
      )
    ORDER BY t.play_count DESC
    LIMIT 25
  `, [genre, userId]);

  return tracks.rows;
}
```

## Error Handling and Recovery (3 minutes)

### Frontend: Retry with Exponential Backoff

```typescript
// utils/api.ts
const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true
});

// Retry logic for network errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;

    // Don't retry if already retried 3 times
    if (config._retryCount >= 3) {
      return Promise.reject(error);
    }

    // Only retry on network errors or 5xx
    if (!error.response || error.response.status >= 500) {
      config._retryCount = (config._retryCount || 0) + 1;

      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, config._retryCount - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));

      return api(config);
    }

    return Promise.reject(error);
  }
);
```

### Backend: Circuit Breaker for External Services

```typescript
// shared/circuitBreaker.ts
import CircuitBreaker from 'opossum';

const minioBreaker = new CircuitBreaker(
  async (bucket: string, key: string, expiry: number) => {
    return minio.presignedGetObject(bucket, key, expiry);
  },
  {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
  }
);

minioBreaker.on('open', () => {
  logger.warn('MinIO circuit breaker opened');
  metrics.circuitBreakerState.set({ service: 'minio' }, 1);
});

minioBreaker.on('close', () => {
  logger.info('MinIO circuit breaker closed');
  metrics.circuitBreakerState.set({ service: 'minio' }, 0);
});

export async function getPresignedUrl(
  bucket: string,
  key: string,
  expiry: number
): Promise<string> {
  try {
    return await minioBreaker.fire(bucket, key, expiry);
  } catch (error) {
    // Fallback to cached URL if available
    const cached = await redis.get(`url:${bucket}:${key}`);
    if (cached) {
      return cached;
    }
    throw error;
  }
}
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| Data Fetching | TanStack Query | Redux Toolkit Query | Better cache control, simpler setup |
| Optimistic Updates | Zustand + rollback | Server-first | Instant feedback, better UX |
| Sync Strategy | Delta with tokens | Full refresh | Bandwidth efficient |
| Audio Delivery | Presigned URLs | Proxy streaming | CDN offload, simpler backend |
| Quality Selection | Server decides | Client decides | Subscription enforcement |
| Session Storage | Redis | JWT | Instant revocation |

### Why Optimistic Updates with Rollback

1. **Instant Feedback**: User sees change immediately (< 50ms)
2. **Network Resilient**: Works on slow connections
3. **Rollback Safety**: Revert on failure with user notification
4. **Trade-off**: Complexity in handling conflicts

### Why Server-Side Quality Selection

The server determines streaming quality because:
- **Subscription Enforcement**: Only premium users get lossless
- **Fraud Prevention**: Client can't lie about network type
- **Trade-off**: Extra round-trip for quality info

## Observability (3 minutes)

### End-to-End Request Tracing

```typescript
// middleware/tracing.ts
import { v4 as uuidv4 } from 'uuid';

export function tracingMiddleware(req: Request, res: Response, next: NextFunction) {
  // Get or generate request ID
  const requestId = req.headers['x-request-id'] as string || uuidv4();

  // Attach to request for logging
  req.requestId = requestId;

  // Add to response headers
  res.setHeader('X-Request-Id', requestId);

  // Create child logger
  req.log = logger.child({ requestId, userId: req.session?.userId });

  // Log request start
  const startTime = Date.now();
  req.log.info({
    method: req.method,
    path: req.path,
    query: req.query
  }, 'Request started');

  // Log response
  res.on('finish', () => {
    req.log.info({
      statusCode: res.statusCode,
      durationMs: Date.now() - startTime
    }, 'Request completed');
  });

  next();
}
```

### Frontend Error Boundary with Reporting

```tsx
// components/ErrorBoundary.tsx
export class ErrorBoundary extends Component<Props, State> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Report to backend
    api.post('/errors', {
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      url: window.location.href,
      userAgent: navigator.userAgent
    }).catch(() => {}); // Don't fail on reporting failure
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen">
          <h1 className="text-2xl font-bold text-white mb-4">
            Something went wrong
          </h1>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-pink-500 text-white rounded-lg"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

## Closing Summary (1 minute)

"Apple Music as a fullstack system is built around three key end-to-end flows:

1. **Streaming Flow** - The frontend requests a stream URL with network context, the backend selects quality based on subscription and network, generates a presigned CDN URL, and the frontend prefetches the next track for gapless transitions.

2. **Library Sync Flow** - Optimistic updates give instant feedback, the backend records changes with monotonically increasing sync tokens, and other devices receive push notifications to trigger delta sync.

3. **Recommendation Flow** - The backend aggregates listening history into personalized sections, the frontend caches results with TanStack Query, and stale-while-revalidate keeps recommendations fresh without blocking.

The main fullstack trade-off is between consistency and responsiveness. We choose optimistic updates with rollback for library operations to maximize perceived speed, while sync tokens ensure eventual consistency across all devices."

## Future Enhancements

1. **Real-time Sync** - WebSocket connections for instant library updates without push
2. **Collaborative Playlists** - Operational transformation for concurrent edits
3. **Offline Downloads** - Service worker with IndexedDB for cached audio files
4. **Audio Fingerprinting** - Upload matching to catalog tracks
5. **Social Features** - Friend activity feed with listening history
