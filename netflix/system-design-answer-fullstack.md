# Design Netflix - Fullstack System Design Answer

## 45-Minute Interview Format - Fullstack Engineering Focus

---

## Introduction (2 minutes)

"Thanks for having me. I'll design Netflix as a fullstack system, focusing on how the frontend and backend integrate to deliver seamless video streaming, personalized browsing, and cross-device continuity.

Key integration challenges include:
1. **Streaming manifest flow** from CDN to player with quality selection
2. **Progress synchronization** for Continue Watching across devices
3. **Personalization pipeline** from viewing history to homepage rows
4. **A/B testing** that spans both frontend and backend

Let me walk through the end-to-end architecture."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"Fullstack scope:

1. **Streaming Pipeline**: Manifest generation, CDN URL signing, player integration
2. **Progress Tracking**: Real-time position updates, cross-device resume
3. **Personalized Homepage**: Backend row generation, frontend rendering
4. **A/B Testing**: Consistent allocation, feature flags, experiment tracking
5. **Profile System**: Multi-profile accounts with maturity filtering"

### Non-Functional Requirements

"Cross-cutting concerns:

- **Playback Start**: < 2 seconds end-to-end
- **Progress Sync**: < 5 second latency for cross-device updates
- **Homepage Load**: < 1 second for personalized content
- **Consistency**: Same user always sees same experiment variant"

---

## End-to-End Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React)                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ VideoPlayer │  │ BrowsePage  │  │ ProfilePage │             │
│  │ + ABR       │  │ + VideoRows │  │ + Settings  │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│  ┌──────┴────────────────┴────────────────┴──────┐             │
│  │              Zustand Stores                    │             │
│  │  authStore │ browseStore │ playerStore        │             │
│  └──────────────────────┬────────────────────────┘             │
│                         │                                       │
│  ┌──────────────────────┴────────────────────────┐             │
│  │              API Service Layer                 │             │
│  │  streaming.ts │ browse.ts │ profiles.ts       │             │
│  └──────────────────────┬────────────────────────┘             │
└─────────────────────────┼───────────────────────────────────────┘
                          │ HTTP/REST
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Express)                           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    API Gateway                              ││
│  │         Authentication │ Rate Limiting │ Routing            ││
│  └─────────────────────────────────────────────────────────────┘│
│         │                     │                     │           │
│         ▼                     ▼                     ▼           │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐   │
│  │Playback Service│   │Personalization│    │Experiment Svc │   │
│  │ - Manifest    │    │ - Homepage    │    │ - Allocation  │   │
│  │ - Progress    │    │ - Ranking     │    │ - Metrics     │   │
│  │ - CDN URLs    │    │ - My List     │    │ - Analysis    │   │
│  └───────┬───────┘    └───────┬───────┘    └───────┬───────┘   │
│          │                    │                    │            │
│  ┌───────┴────────────────────┴────────────────────┴───────┐   │
│  │                    Data Layer                            │   │
│  │   PostgreSQL (catalog, profiles, experiments)           │   │
│  │   Cassandra (viewing progress, watch history)           │   │
│  │   Redis (sessions, cache, rate limits)                  │   │
│  │   MinIO (video segments, manifests)                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Streaming Pipeline (12 minutes)

### Manifest Generation and Delivery

"The streaming flow connects backend manifest generation with frontend ABR:

```typescript
// Backend: routes/streaming.ts
router.get('/stream/:videoId/manifest', authenticate, async (req, res) => {
  const { videoId } = req.params;
  const { profileId } = req.session;

  // Get video metadata
  const video = await db.query(
    'SELECT * FROM videos WHERE id = $1',
    [videoId]
  );

  if (!video.rows[0]) {
    return res.status(404).json({ error: 'Video not found' });
  }

  // Check maturity level
  const profile = await db.query(
    'SELECT maturity_level FROM profiles WHERE id = $1',
    [profileId]
  );

  const maturityMap = { 'G': 1, 'PG': 2, 'PG-13': 3, 'R': 4, 'TV-MA': 5 };
  if (maturityMap[video.rows[0].rating] > profile.rows[0].maturity_level) {
    return res.status(403).json({ error: 'Content restricted for this profile' });
  }

  // Generate manifest with signed CDN URLs
  const manifest = await generateManifest(videoId);

  // Get resume position if exists
  const progress = await cassandra.execute(
    `SELECT position_seconds FROM viewing_progress
     WHERE profile_id = ? AND content_id = ?`,
    [profileId, videoId]
  );

  // Track streaming start for analytics
  await trackStreamingStart(profileId, videoId);

  res.json({
    manifest,
    resumePosition: progress.rows[0]?.position_seconds || 0,
    video: {
      title: video.rows[0].title,
      duration: video.rows[0].duration_minutes * 60,
    }
  });
});

async function generateManifest(videoId: string): Promise<StreamingManifest> {
  const qualities = [
    { quality: '4k', bitrate: 15000000, width: 3840, height: 2160 },
    { quality: '1080p', bitrate: 5800000, width: 1920, height: 1080 },
    { quality: '720p', bitrate: 3000000, width: 1280, height: 720 },
    { quality: '480p', bitrate: 1050000, width: 854, height: 480 },
    { quality: '360p', bitrate: 560000, width: 640, height: 360 },
  ];

  const sources = await Promise.all(
    qualities.map(async (q) => {
      const path = `videos/${videoId}/${q.quality}/stream.mp4`;
      const signedUrl = await generateSignedUrl(path, 3600); // 1 hour expiry

      return {
        ...q,
        url: signedUrl,
      };
    })
  );

  return {
    videoId,
    sources,
    segmentDuration: 4, // seconds
    generatedAt: new Date().toISOString(),
  };
}

// CDN URL signing with JWT
async function generateSignedUrl(path: string, expiresIn: number): string {
  const token = jwt.sign(
    {
      path,
      exp: Math.floor(Date.now() / 1000) + expiresIn,
    },
    process.env.CDN_SIGNING_KEY
  );

  return `${process.env.CDN_BASE_URL}/${path}?token=${token}`;
}
```"

### Frontend ABR Controller

"The frontend consumes the manifest and handles quality switching:

```typescript
// Frontend: services/streaming.ts
export interface StreamingManifest {
  videoId: string;
  sources: QualityLevel[];
  resumePosition: number;
  video: {
    title: string;
    duration: number;
  };
}

export interface QualityLevel {
  quality: string;
  bitrate: number;
  width: number;
  height: number;
  url: string;
}

export async function fetchManifest(
  videoId: string,
  episodeId?: string
): Promise<StreamingManifest> {
  const url = episodeId
    ? `/api/stream/${videoId}/episodes/${episodeId}/manifest`
    : `/api/stream/${videoId}/manifest`;

  const response = await api.get(url);
  return response.data;
}

// Frontend: hooks/useAdaptiveBitrate.ts
export function useAdaptiveBitrate(
  videoRef: RefObject<HTMLVideoElement>,
  manifest: StreamingManifest | null
) {
  const [currentQuality, setCurrentQuality] = useState<string>('auto');
  const [bandwidthEstimate, setBandwidthEstimate] = useState<number>(5000000);

  // Bandwidth estimation based on download times
  const measureBandwidth = useCallback((downloadTime: number, bytes: number) => {
    const instantBandwidth = (bytes * 8) / downloadTime;
    // Exponential moving average for smoothing
    setBandwidthEstimate(prev => prev * 0.7 + instantBandwidth * 0.3);
  }, []);

  // Auto quality selection
  const selectQuality = useCallback(() => {
    if (!manifest || currentQuality !== 'auto') return;

    const bufferLevel = videoRef.current
      ? videoRef.current.buffered.length > 0
        ? videoRef.current.buffered.end(0) - videoRef.current.currentTime
        : 0
      : 0;

    // Find highest quality we can sustain (80% headroom)
    const suitable = manifest.sources
      .filter(s => s.bitrate < bandwidthEstimate * 0.8)
      .sort((a, b) => b.bitrate - a.bitrate);

    // If buffer is low, be more conservative
    if (bufferLevel < 5) {
      return suitable.find(s => s.bitrate < bandwidthEstimate * 0.5)
        || suitable[suitable.length - 1];
    }

    return suitable[0] || manifest.sources[manifest.sources.length - 1];
  }, [manifest, currentQuality, bandwidthEstimate]);

  return {
    currentQuality,
    setCurrentQuality,
    bandwidthEstimate,
    selectQuality,
    measureBandwidth,
  };
}
```"

### Progress Synchronization

"Progress updates flow from player to backend with debouncing:

```typescript
// Frontend: stores/playerStore.ts
interface PlayerState {
  // ... other state
  saveProgress: (videoId: string, position: number, duration: number) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  lastSavedPosition: 0,
  saveTimeout: null,

  saveProgress: (videoId, position, duration) => {
    const { lastSavedPosition, saveTimeout } = get();

    // Only save if moved at least 10 seconds
    if (Math.abs(position - lastSavedPosition) < 10) return;

    // Debounce to avoid excessive API calls
    if (saveTimeout) clearTimeout(saveTimeout);

    const timeout = setTimeout(async () => {
      try {
        await api.post('/api/stream/progress', {
          videoId,
          position: Math.floor(position),
          duration: Math.floor(duration),
        });
        set({ lastSavedPosition: position });
      } catch (error) {
        console.error('Failed to save progress:', error);
        // Will retry on next update
      }
    }, 2000);

    set({ saveTimeout: timeout });
  },
}));

// Backend: routes/streaming.ts
router.post('/stream/progress', authenticate, async (req, res) => {
  const { videoId, position, duration } = req.body;
  const { profileId } = req.session;

  // Determine if completed (>95%)
  const completed = position / duration > 0.95;

  // Update Cassandra (high-write workload)
  await cassandra.execute(
    `INSERT INTO viewing_progress
     (profile_id, content_id, content_type, video_id, position_seconds,
      duration_seconds, progress_percent, completed, last_watched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      profileId,
      videoId,
      'movie',
      videoId,
      position,
      duration,
      Math.round((position / duration) * 100),
      completed,
      new Date(),
    ]
  );

  // If completed, add to watch history for recommendations
  if (completed) {
    const video = await db.query(
      'SELECT title, genres FROM videos WHERE id = $1',
      [videoId]
    );

    await cassandra.execute(
      `INSERT INTO watch_history
       (profile_id, content_id, content_type, video_id, title, genres, watched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId,
        videoId,
        'movie',
        videoId,
        video.rows[0].title,
        new Set(video.rows[0].genres),
        new Date(),
      ]
    );

    // Update genre preferences (counter table)
    for (const genre of video.rows[0].genres) {
      await cassandra.execute(
        'UPDATE genre_preferences SET watch_count = watch_count + 1 WHERE profile_id = ? AND genre = ?',
        [profileId, genre]
      );
    }
  }

  // Invalidate homepage cache
  await redis.del(`homepage:${profileId}`);

  res.json({ saved: true, completed });
});
```"

---

## Deep Dive: Personalization Pipeline (10 minutes)

### Homepage Row Generation

"Backend generates personalized rows, frontend renders them:

```typescript
// Backend: routes/browse.ts
router.get('/browse/homepage', authenticate, async (req, res) => {
  const { profileId } = req.session;

  // Check cache first
  const cached = await redis.get(`homepage:${profileId}`);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // Get profile for maturity filtering
  const profile = await db.query(
    'SELECT * FROM profiles WHERE id = $1',
    [profileId]
  );

  // Generate rows in parallel
  const [
    continueWatching,
    trending,
    topGenres,
    recentlyWatched,
    myList,
  ] = await Promise.all([
    getContinueWatching(profileId),
    getTrending(profile.rows[0].language),
    getTopGenres(profileId),
    getRecentlyWatched(profileId),
    getMyList(profileId),
  ]);

  const rows: ContentRow[] = [];

  // Continue Watching (always first if non-empty)
  if (continueWatching.length > 0) {
    rows.push({
      id: 'continue-watching',
      title: 'Continue Watching',
      type: 'continue_watching',
      items: continueWatching,
    });
  }

  // My List
  if (myList.length > 0) {
    rows.push({
      id: 'my-list',
      title: 'My List',
      type: 'my_list',
      items: myList,
    });
  }

  // Trending Now
  rows.push({
    id: 'trending',
    title: 'Trending Now',
    type: 'trending',
    items: trending,
  });

  // Genre rows based on viewing history
  for (const genre of topGenres.slice(0, 3)) {
    const genreVideos = await getTopByGenre(
      genre.genre,
      profileId,
      profile.rows[0].maturity_level
    );
    rows.push({
      id: `genre-${genre.genre.toLowerCase()}`,
      title: `${genre.genre} Movies`,
      type: 'genre',
      items: genreVideos,
    });
  }

  // "Because You Watched" rows
  for (const video of recentlyWatched.slice(0, 2)) {
    const similar = await getSimilarVideos(
      video.video_id,
      profile.rows[0].maturity_level
    );
    if (similar.length > 0) {
      rows.push({
        id: `because-${video.video_id}`,
        title: `Because You Watched ${video.title}`,
        type: 'because_you_watched',
        items: similar,
      });
    }
  }

  // Apply A/B test treatments (row order, artwork, etc.)
  const finalRows = await applyExperiments(profileId, rows);

  // Cache for 5 minutes
  await redis.setex(
    `homepage:${profileId}`,
    300,
    JSON.stringify({ rows: finalRows })
  );

  res.json({ rows: finalRows });
});

// Get Continue Watching with progress
async function getContinueWatching(profileId: string): Promise<ContinueWatchingItem[]> {
  const progress = await cassandra.execute(
    `SELECT content_id, video_id, position_seconds, duration_seconds,
            progress_percent, last_watched_at
     FROM viewing_progress
     WHERE profile_id = ?
     AND completed = false
     ORDER BY last_watched_at DESC
     LIMIT 20`,
    [profileId]
  );

  // Filter to items with meaningful progress (>5%)
  const filtered = progress.rows.filter(p => p.progress_percent > 5);

  // Enrich with video metadata from PostgreSQL
  const videoIds = filtered.map(p => p.video_id);
  const videos = await db.query(
    `SELECT id, title, thumbnail_url, duration_minutes, rating, type
     FROM videos WHERE id = ANY($1)`,
    [videoIds]
  );

  const videoMap = new Map(videos.rows.map(v => [v.id, v]));

  return filtered.map(p => ({
    ...videoMap.get(p.video_id),
    resumePosition: p.position_seconds,
    progressPercent: p.progress_percent,
    lastWatchedAt: p.last_watched_at,
  }));
}
```"

### Frontend Homepage Rendering

"Frontend fetches and renders the personalized rows:

```typescript
// Frontend: stores/browseStore.ts
interface BrowseState {
  rows: ContentRow[];
  isLoading: boolean;
  error: string | null;
  fetchHomepage: () => Promise<void>;
}

export const useBrowseStore = create<BrowseState>((set) => ({
  rows: [],
  isLoading: false,
  error: null,

  fetchHomepage: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.get('/api/browse/homepage');
      set({ rows: response.data.rows, isLoading: false });
    } catch (error) {
      set({
        error: 'Failed to load content. Please try again.',
        isLoading: false
      });
    }
  },
}));

// Frontend: routes/browse.tsx
export function BrowsePage() {
  const { rows, isLoading, error, fetchHomepage } = useBrowseStore();
  const { activeProfile } = useAuthStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (activeProfile) {
      fetchHomepage();
    }
  }, [activeProfile?.id]);

  const handleVideoSelect = (video: Video) => {
    navigate({ to: '/watch/$videoId', params: { videoId: video.id } });
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (error) {
    return <ErrorMessage message={error} onRetry={fetchHomepage} />;
  }

  // Find featured content for hero banner
  const featuredVideo = rows[0]?.items[0];

  return (
    <div className="min-h-screen bg-black">
      <Navbar />

      {featuredVideo && (
        <HeroBanner
          video={featuredVideo}
          onPlay={(id) => navigate({ to: '/watch/$videoId', params: { videoId: id } })}
          onInfo={(id) => setDetailModal(id)}
        />
      )}

      <div className="relative -mt-32 z-10">
        {rows.map((row) => (
          row.type === 'continue_watching' ? (
            <ContinueWatchingRow
              key={row.id}
              title={row.title}
              items={row.items}
              onVideoSelect={handleVideoSelect}
            />
          ) : (
            <VideoRow
              key={row.id}
              title={row.title}
              videos={row.items}
              onVideoSelect={handleVideoSelect}
            />
          )
        ))}
      </div>
    </div>
  );
}

// ContinueWatchingRow with progress indicators
function ContinueWatchingRow({ title, items, onVideoSelect }) {
  return (
    <VideoRow
      title={title}
      videos={items}
      onVideoSelect={onVideoSelect}
      renderCard={(video) => (
        <VideoCard
          video={video}
          progress={video.progressPercent}
          onClick={() => onVideoSelect(video)}
        />
      )}
    />
  );
}
```"

---

## Deep Dive: A/B Testing Integration (8 minutes)

### Consistent Experiment Allocation

"Allocation spans both backend and frontend:

```typescript
// Backend: services/experiments.ts
import murmurhash from 'murmurhash';

interface Experiment {
  id: string;
  name: string;
  allocation: number; // 0-100 percentage
  variants: Variant[];
  status: 'draft' | 'running' | 'completed';
}

interface Variant {
  id: string;
  name: string;
  weight: number; // Relative weight within experiment
  config: Record<string, any>;
}

export async function getExperimentVariant(
  profileId: string,
  experimentId: string
): Promise<Variant | null> {
  // Check cache first
  const cacheKey = `exp:${profileId}:${experimentId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Fetch experiment
  const result = await db.query(
    `SELECT * FROM experiments WHERE id = $1 AND status = 'running'`,
    [experimentId]
  );

  const experiment = result.rows[0];
  if (!experiment) return null;

  // Consistent hash for stable allocation
  const hash = murmurhash.v3(`${profileId}:${experimentId}`);
  const bucket = hash % 100;

  // Check if in experiment population
  if (bucket >= experiment.allocation_percent) {
    return null; // Control group (not in experiment)
  }

  // Determine variant based on weights
  const variants = experiment.variants as Variant[];
  let accumulated = 0;

  for (const variant of variants) {
    accumulated += variant.weight;
    const threshold = (experiment.allocation_percent * accumulated) / 100;

    if (bucket < threshold) {
      // Cache for session duration
      await redis.setex(cacheKey, 86400, JSON.stringify(variant));
      return variant;
    }
  }

  return variants[0]; // Fallback to first variant
}

// Apply experiments to homepage rows
export async function applyExperiments(
  profileId: string,
  rows: ContentRow[]
): Promise<ContentRow[]> {
  // Experiment: Row ordering
  const rowOrderVariant = await getExperimentVariant(profileId, 'row_order_test');
  if (rowOrderVariant?.config.prioritizeGenres) {
    // Move genre rows higher
    rows.sort((a, b) => {
      if (a.type === 'genre' && b.type !== 'genre') return -1;
      if (a.type !== 'genre' && b.type === 'genre') return 1;
      return 0;
    });
  }

  // Experiment: Artwork style
  const artworkVariant = await getExperimentVariant(profileId, 'artwork_style_test');
  if (artworkVariant?.config.usePersonalizedArtwork) {
    for (const row of rows) {
      for (const item of row.items) {
        item.thumbnailUrl = await getPersonalizedArtwork(item.id, profileId);
      }
    }
  }

  return rows;
}

// Backend: routes/experiments.ts
router.get('/experiments/allocations', authenticate, async (req, res) => {
  const { profileId } = req.session;

  // Get all running experiments
  const experiments = await db.query(
    `SELECT id, name FROM experiments WHERE status = 'running'`
  );

  // Get allocations for each
  const allocations: Record<string, string | null> = {};

  for (const exp of experiments.rows) {
    const variant = await getExperimentVariant(profileId, exp.id);
    allocations[exp.name] = variant?.name || null;
  }

  res.json({ allocations });
});
```"

### Frontend Experiment Integration

"Frontend uses allocations for UI decisions:

```typescript
// Frontend: hooks/useExperiments.ts
interface ExperimentAllocations {
  [experimentName: string]: string | null;
}

export function useExperiments() {
  const [allocations, setAllocations] = useState<ExperimentAllocations>({});
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchAllocations();
    }
  }, [isAuthenticated]);

  const fetchAllocations = async () => {
    const response = await api.get('/api/experiments/allocations');
    setAllocations(response.data.allocations);
  };

  const isInVariant = (experimentName: string, variantName: string): boolean => {
    return allocations[experimentName] === variantName;
  };

  const getVariant = (experimentName: string): string | null => {
    return allocations[experimentName] || null;
  };

  return { allocations, isInVariant, getVariant };
}

// Usage in components
function VideoCard({ video, onClick }) {
  const { isInVariant } = useExperiments();

  // Experiment: Show match percentage or not
  const showMatchScore = isInVariant('match_score_test', 'show_score');

  return (
    <div onClick={onClick}>
      <img src={video.thumbnailUrl} alt={video.title} />
      {showMatchScore && video.matchScore && (
        <span className="text-green-400">{video.matchScore}% Match</span>
      )}
    </div>
  );
}

// Track experiment impressions
function HeroBanner({ video }) {
  const { getVariant } = useExperiments();

  useEffect(() => {
    // Track which variant user saw
    const variant = getVariant('hero_cta_test');
    if (variant) {
      api.post('/api/analytics/impression', {
        experiment: 'hero_cta_test',
        variant,
        videoId: video.id,
      });
    }
  }, [video.id]);

  // Render different CTA based on variant
  const ctaVariant = getVariant('hero_cta_test');
  const ctaText = ctaVariant === 'play_now' ? 'Play Now' : 'Watch';

  return (
    <button onClick={() => onPlay(video.id)}>
      {ctaText}
    </button>
  );
}
```"

---

## Shared Type Definitions (5 minutes)

"Shared types ensure frontend and backend stay in sync:

```typescript
// shared/types.ts (could be in a shared package)

// Video types
export interface Video {
  id: string;
  title: string;
  type: 'movie' | 'series';
  releaseYear: number;
  durationMinutes: number;
  rating: string;
  genres: string[];
  description: string;
  thumbnailUrl: string;
  backdropUrl: string;
  previewUrl?: string;
}

export interface Episode {
  id: string;
  seasonId: string;
  episodeNumber: number;
  title: string;
  durationMinutes: number;
  description: string;
}

// Profile types
export interface Profile {
  id: string;
  accountId: string;
  name: string;
  avatarUrl: string;
  isKids: boolean;
  maturityLevel: number;
  language: string;
}

// Streaming types
export interface StreamingManifest {
  videoId: string;
  sources: QualityLevel[];
  segmentDuration: number;
  generatedAt: string;
}

export interface QualityLevel {
  quality: string;
  bitrate: number;
  width: number;
  height: number;
  url: string;
}

// Browse types
export interface ContentRow {
  id: string;
  title: string;
  type: 'continue_watching' | 'my_list' | 'trending' | 'genre' | 'because_you_watched';
  items: (Video | ContinueWatchingItem)[];
}

export interface ContinueWatchingItem extends Video {
  resumePosition: number;
  progressPercent: number;
  lastWatchedAt: string;
}

// Experiment types
export interface Experiment {
  id: string;
  name: string;
  description: string;
  allocationPercent: number;
  variants: Variant[];
  status: 'draft' | 'running' | 'completed';
  startDate: string;
  endDate?: string;
}

export interface Variant {
  id: string;
  name: string;
  weight: number;
  config: Record<string, unknown>;
}

// API response types
export interface ApiResponse<T> {
  data: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
```"

---

## Error Handling Strategy (3 minutes)

### Backend Error Handling

```typescript
// Backend: middleware/errorHandler.ts
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error('Error:', err.message, err.stack);

  // Known error types
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, fields: err.fields });
  }

  if (err instanceof AuthenticationError) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (err instanceof AuthorizationError) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }

  // Circuit breaker fallbacks
  if (err.message.includes('Circuit breaker is OPEN')) {
    return res.status(503).json({
      error: 'Service temporarily unavailable',
      retryAfter: 30,
    });
  }

  // Generic server error
  res.status(500).json({ error: 'Internal server error' });
}
```

### Frontend Error Handling

```typescript
// Frontend: components/ErrorBoundary.tsx
export class ErrorBoundary extends Component<Props, State> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log to monitoring service
    console.error('React error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-screen bg-black text-white">
          <h1 className="text-2xl mb-4">Something went wrong</h1>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 bg-red-600 rounded"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// API error handling
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }

    if (error.response?.status === 503) {
      // Service unavailable - show retry UI
      return Promise.reject(new ServiceUnavailableError(error.response.data));
    }

    return Promise.reject(error);
  }
);
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Progress Storage | Cassandra | PostgreSQL | High-write throughput for position updates |
| Session Storage | Redis | JWT | Immediate revocation, debugging visibility |
| Homepage Caching | Redis (5 min TTL) | No cache | Balance freshness vs. personalization latency |
| Shared Types | Duplicated files | Monorepo package | Simpler project structure for learning |
| Experiment Allocation | Server-side | Client-side | Consistent allocation, no flickering |
| CDN URLs | Signed JWT | Pre-signed S3 | Flexibility, custom expiration |

---

## Summary

"I've designed Netflix's fullstack architecture with:

1. **Streaming pipeline** with backend manifest generation and frontend ABR controller
2. **Progress synchronization** using Cassandra for high-write workloads with debounced frontend updates
3. **Personalization pipeline** generating rows server-side with Redis caching and frontend rendering
4. **A/B testing** with consistent MurmurHash allocation and frontend experiment hooks
5. **Shared type definitions** ensuring type safety across the stack
6. **Error handling** with backend middleware, circuit breakers, and frontend error boundaries

The architecture prioritizes cross-device consistency, low-latency personalization, and reliable playback across varying network conditions.

What aspect would you like me to elaborate on?"
