# TikTok - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"Today I'll design a short-video platform like TikTok, focusing on the frontend experience that makes the For You Page so engaging. The core challenge is building a full-screen, infinite-scroll video feed that feels instant and responsive while efficiently managing memory for potentially unlimited videos. I'll deep dive into virtualized rendering with @tanstack/react-virtual, video preloading strategies, engagement UI patterns, the cold start onboarding experience, and creator analytics dashboards."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **For You Page (FYP)**: Full-screen vertical video scroll with instant transitions
2. **Video Player**: Autoplay, pause on tap, progress indicator, sound toggle
3. **Engagement UI**: Like animation, comments overlay, share sheet
4. **Upload Flow**: Video capture/select, trim, add effects, publish
5. **Creator Analytics**: Video performance charts, audience insights

### Non-Functional Requirements

- **Performance**: 60 FPS scroll, < 100ms video start, < 500ms initial load
- **Memory**: Constant memory footprint regardless of scroll depth
- **Accessibility**: Screen reader support, reduced motion, captions
- **Mobile-First**: Touch gestures, responsive breakpoints, PWA-ready

### Frontend-Specific Challenges

- Virtualization for unbounded video lists
- Video preloading without memory exhaustion
- Optimistic engagement updates with visual feedback
- Cold start UI that captures preferences quickly
- Real-time view/like counters without over-fetching

---

## Step 2: UI Architecture Overview (5 minutes)

### Component Hierarchy

```
<App>
├── <Router>
│   ├── <FeedPage>                    # /
│   │   ├── <VirtualizedFeed>
│   │   │   └── <VideoCard>           # Single video container
│   │   │       ├── <VideoPlayer>     # HTML5 video with controls
│   │   │       ├── <EngagementBar>   # Like, comment, share buttons
│   │   │       └── <VideoInfo>       # Creator, description, hashtags
│   │   └── <CommentsSheet>           # Bottom sheet overlay
│   │
│   ├── <DiscoverPage>                # /discover
│   │   ├── <SearchBar>
│   │   ├── <TrendingHashtags>
│   │   └── <CategoryGrid>
│   │
│   ├── <UploadPage>                  # /upload
│   │   ├── <VideoCapture>
│   │   ├── <VideoTrimmer>
│   │   ├── <EffectsPanel>
│   │   └── <PublishForm>
│   │
│   ├── <ProfilePage>                 # /profile/:userId
│   │   ├── <ProfileHeader>
│   │   └── <VideoGrid>
│   │
│   └── <CreatorStudioPage>           # /creator/analytics
│       ├── <PerformanceChart>
│       ├── <AudienceInsights>
│       └── <VideoAnalyticsTable>
│
├── <BottomNav>
└── <ToastContainer>
```

### State Management (Zustand)

```typescript
// stores/feedStore.ts
interface FeedState {
  videos: Video[]
  currentIndex: number
  isLoading: boolean
  hasMore: boolean

  // Actions
  fetchNextPage: () => Promise<void>
  setCurrentIndex: (index: number) => void
  updateVideo: (id: string, updates: Partial<Video>) => void
}

// stores/engagementStore.ts
interface EngagementState {
  pendingLikes: Set<string>       // Optimistic updates
  pendingComments: Map<string, Comment[]>

  likeVideo: (videoId: string) => Promise<void>
  unlikeVideo: (videoId: string) => Promise<void>
  addComment: (videoId: string, text: string) => Promise<void>
}

// stores/userStore.ts
interface UserState {
  user: User | null
  isNewUser: boolean              // Cold start flag
  preferences: UserPreferences
  watchHistory: WatchedVideo[]

  trackWatch: (videoId: string, duration: number) => void
}
```

---

## Step 3: Core Frontend Deep Dives

### Deep Dive 1: Virtualized Video Feed (12 minutes)

Without virtualization, rendering hundreds of video elements causes memory exhaustion and janky scrolling. We use `@tanstack/react-virtual` to render only visible videos.

**The Problem:**

| Issue | Without Virtualization | With Virtualization |
|-------|------------------------|---------------------|
| DOM nodes (100 videos) | 500+ | ~15 |
| Memory usage | Grows unbounded | Constant ~50MB |
| FPS during scroll | 20-30 fps | 60 fps |
| Initial load | 2-3 seconds | < 500ms |

**Implementation:**

```typescript
// components/VirtualizedFeed.tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useCallback, useEffect } from 'react'
import { useFeedStore } from '../stores/feedStore'

export function VirtualizedFeed() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { videos, fetchNextPage, hasMore, setCurrentIndex } = useFeedStore()

  // Full-screen height for each video
  const containerHeight = typeof window !== 'undefined'
    ? window.innerHeight
    : 800

  const virtualizer = useVirtualizer({
    count: videos.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => containerHeight,
    overscan: 1, // Only 1 extra video - videos are expensive
  })

  // Infinite scroll trigger
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1)
    if (!lastItem) return

    if (lastItem.index >= videos.length - 3 && hasMore) {
      fetchNextPage()
    }
  }, [virtualizer.getVirtualItems(), hasMore, fetchNextPage])

  // Track current video for autoplay
  useEffect(() => {
    const items = virtualizer.getVirtualItems()
    const centerY = containerHeight / 2

    for (const item of items) {
      const itemTop = item.start
      const itemBottom = item.start + item.size
      const scrollTop = containerRef.current?.scrollTop ?? 0

      // Video is "current" when its center is in view
      if (itemTop - scrollTop < centerY && itemBottom - scrollTop > centerY) {
        setCurrentIndex(item.index)
        break
      }
    }
  }, [virtualizer.getVirtualItems(), setCurrentIndex])

  return (
    <div
      ref={containerRef}
      className="h-screen overflow-y-scroll snap-y snap-mandatory"
      style={{ scrollSnapType: 'y mandatory' }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={videos[virtualRow.index].id}
            data-index={virtualRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="snap-start"
          >
            <VideoCard
              video={videos[virtualRow.index]}
              isActive={virtualRow.index === useFeedStore.getState().currentIndex}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Snap Scrolling for TikTok-Style UX:**

```css
/* Full-page video snap behavior */
.feed-container {
  scroll-snap-type: y mandatory;
  overscroll-behavior-y: contain; /* Prevent pull-to-refresh */
}

.video-card {
  scroll-snap-align: start;
  scroll-snap-stop: always; /* Force stop at each video */
}
```

**Why `overscan: 1`:**
- Videos are the heaviest DOM elements (video decoder, large images)
- Rendering 2+ off-screen videos wastes memory significantly
- With snap scrolling, user can only move one video at a time
- Preloading handles the next video's data, not DOM element

---

### Deep Dive 2: Video Player with Preloading (10 minutes)

**Video Player Component:**

```typescript
// components/VideoPlayer.tsx
import { useRef, useEffect, useState, useCallback } from 'react'

interface VideoPlayerProps {
  video: Video
  isActive: boolean
  onProgress: (watched: number, total: number) => void
}

export function VideoPlayer({ video, isActive, onProgress }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(true) // Start muted for autoplay
  const [showControls, setShowControls] = useState(false)

  // Autoplay when video becomes active
  useEffect(() => {
    if (!videoRef.current) return

    if (isActive) {
      videoRef.current.currentTime = 0
      videoRef.current.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false)) // Autoplay blocked
    } else {
      videoRef.current.pause()
      setIsPlaying(false)
    }
  }, [isActive])

  // Track watch progress
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isActive) return

    const handleTimeUpdate = () => {
      onProgress(video.currentTime, video.duration)
    }

    video.addEventListener('timeupdate', handleTimeUpdate)
    return () => video.removeEventListener('timeupdate', handleTimeUpdate)
  }, [isActive, onProgress])

  // Tap to pause/play
  const handleTap = useCallback(() => {
    if (!videoRef.current) return

    if (isPlaying) {
      videoRef.current.pause()
      setIsPlaying(false)
      setShowControls(true)
    } else {
      videoRef.current.play()
      setIsPlaying(true)
      setShowControls(false)
    }
  }, [isPlaying])

  // Double tap to like (detect via timing)
  const lastTapRef = useRef(0)
  const handleDoubleTap = useCallback((e: React.MouseEvent) => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      // Double tap detected - like animation
      e.preventDefault()
      // Trigger heart animation at tap position
    }
    lastTapRef.current = now
  }, [])

  return (
    <div
      className="relative h-full w-full bg-black"
      onClick={handleTap}
      onDoubleClick={handleDoubleTap}
    >
      <video
        ref={videoRef}
        src={video.url}
        className="h-full w-full object-contain"
        loop
        muted={isMuted}
        playsInline
        preload="metadata"
      />

      {/* Pause overlay */}
      {showControls && !isPlaying && (
        <div className="absolute inset-0 flex items-center justify-center">
          <PlayIcon className="h-20 w-20 text-white/80" />
        </div>
      )}

      {/* Progress bar */}
      <ProgressBar
        videoRef={videoRef}
        className="absolute bottom-0 left-0 right-0"
      />

      {/* Sound toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          setIsMuted(!isMuted)
        }}
        className="absolute bottom-4 right-4 rounded-full bg-black/50 p-2"
      >
        {isMuted ? <MutedIcon /> : <SoundIcon />}
      </button>
    </div>
  )
}
```

**Preloading Strategy:**

```typescript
// hooks/useVideoPreload.ts
import { useEffect, useRef } from 'react'
import { useFeedStore } from '../stores/feedStore'

export function useVideoPreload() {
  const { videos, currentIndex } = useFeedStore()
  const preloadedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Preload next 2 videos
    const preloadIndices = [currentIndex + 1, currentIndex + 2]

    for (const index of preloadIndices) {
      const video = videos[index]
      if (!video || preloadedRef.current.has(video.id)) continue

      // Create hidden video element to trigger preload
      const preloadVideo = document.createElement('video')
      preloadVideo.preload = 'auto'
      preloadVideo.src = video.url
      preloadVideo.muted = true

      // Load first 3 seconds
      preloadVideo.addEventListener('loadeddata', () => {
        preloadedRef.current.add(video.id)
      })

      // Cleanup after preload
      setTimeout(() => {
        preloadVideo.src = ''
        preloadVideo.remove()
      }, 5000)
    }

    // Preload thumbnails for next 5 videos
    for (let i = currentIndex + 1; i <= currentIndex + 5; i++) {
      const video = videos[i]
      if (!video) continue

      const img = new Image()
      img.src = video.thumbnailUrl
    }
  }, [currentIndex, videos])
}
```

**Why Preload Only 2 Videos:**
- Mobile data constraints
- Memory limits on phones
- 2 videos covers swipe latency
- Thumbnail preload extends visible range cheaply

---

### Deep Dive 3: Engagement UI with Optimistic Updates (8 minutes)

**Like Button with Animation:**

```typescript
// components/LikeButton.tsx
import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useEngagementStore } from '../stores/engagementStore'

interface LikeButtonProps {
  videoId: string
  isLiked: boolean
  likeCount: number
}

export function LikeButton({ videoId, isLiked, likeCount }: LikeButtonProps) {
  const [showBurst, setShowBurst] = useState(false)
  const { likeVideo, unlikeVideo, pendingLikes } = useEngagementStore()

  // Optimistic state
  const isPending = pendingLikes.has(videoId)
  const optimisticLiked = isPending ? !isLiked : isLiked
  const optimisticCount = isPending
    ? (isLiked ? likeCount - 1 : likeCount + 1)
    : likeCount

  const handleLike = useCallback(async () => {
    if (optimisticLiked) {
      await unlikeVideo(videoId)
    } else {
      setShowBurst(true)
      setTimeout(() => setShowBurst(false), 800)
      await likeVideo(videoId)
    }
  }, [videoId, optimisticLiked, likeVideo, unlikeVideo])

  return (
    <button
      onClick={handleLike}
      className="flex flex-col items-center gap-1"
      disabled={isPending}
    >
      <div className="relative">
        <motion.div
          animate={{
            scale: optimisticLiked ? [1, 1.3, 1] : 1,
          }}
          transition={{ duration: 0.3 }}
        >
          <HeartIcon
            className={`h-8 w-8 ${
              optimisticLiked ? 'fill-red-500 text-red-500' : 'text-white'
            }`}
          />
        </motion.div>

        {/* Burst animation on like */}
        <AnimatePresence>
          {showBurst && (
            <motion.div
              initial={{ scale: 0, opacity: 1 }}
              animate={{ scale: 2, opacity: 0 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex items-center justify-center"
            >
              {[...Array(6)].map((_, i) => (
                <motion.span
                  key={i}
                  className="absolute h-2 w-2 rounded-full bg-red-500"
                  initial={{ x: 0, y: 0 }}
                  animate={{
                    x: Math.cos((i * 60 * Math.PI) / 180) * 30,
                    y: Math.sin((i * 60 * Math.PI) / 180) * 30,
                    opacity: 0,
                  }}
                  transition={{ duration: 0.5 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <span className="text-xs text-white font-semibold">
        {formatCount(optimisticCount)}
      </span>
    </button>
  )
}

function formatCount(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}
```

**Optimistic Update Flow:**

```typescript
// stores/engagementStore.ts
export const useEngagementStore = create<EngagementState>((set, get) => ({
  pendingLikes: new Set(),

  likeVideo: async (videoId: string) => {
    // Mark as pending (triggers optimistic UI)
    set(state => ({
      pendingLikes: new Set(state.pendingLikes).add(videoId)
    }))

    try {
      await api.post(`/api/videos/${videoId}/like`)

      // Update feed store with confirmed state
      useFeedStore.getState().updateVideo(videoId, {
        isLiked: true,
        likeCount: prev => prev + 1
      })
    } catch (error) {
      // Rollback on failure (UI reverts automatically)
      console.error('Like failed:', error)
    } finally {
      // Remove pending state
      set(state => {
        const newPending = new Set(state.pendingLikes)
        newPending.delete(videoId)
        return { pendingLikes: newPending }
      })
    }
  },

  // ... unlikeVideo similar pattern
}))
```

**Double-Tap Heart Animation:**

```typescript
// components/DoubleTapHeart.tsx
import { motion } from 'framer-motion'

export function DoubleTapHeart({ x, y }: { x: number; y: number }) {
  return (
    <motion.div
      className="pointer-events-none absolute z-50"
      style={{ left: x - 50, top: y - 50 }}
      initial={{ scale: 0, opacity: 1 }}
      animate={{ scale: 1.5, opacity: 0 }}
      transition={{ duration: 0.8 }}
    >
      <HeartIcon className="h-24 w-24 fill-white text-white drop-shadow-lg" />
    </motion.div>
  )
}
```

---

### Deep Dive 4: Cold Start Onboarding UI (5 minutes)

**Interest Selection for New Users:**

```typescript
// components/InterestSelector.tsx
import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'

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
  { id: 'fitness', label: 'Fitness', emoji: '💪' },
  { id: 'tech', label: 'Tech', emoji: '📱' },
]

export function InterestSelector({ onComplete }: { onComplete: (interests: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggleInterest = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleContinue = useCallback(() => {
    onComplete(Array.from(selected))
  }, [selected, onComplete])

  return (
    <div className="flex flex-col h-full bg-black px-6 py-8">
      <h1 className="text-2xl font-bold text-white mb-2">
        What are you interested in?
      </h1>
      <p className="text-gray-400 mb-8">
        Select 3 or more to personalize your feed
      </p>

      <div className="flex-1 grid grid-cols-3 gap-3">
        {INTEREST_CATEGORIES.map(category => (
          <motion.button
            key={category.id}
            onClick={() => toggleInterest(category.id)}
            whileTap={{ scale: 0.95 }}
            className={`
              flex flex-col items-center justify-center p-4 rounded-xl
              transition-colors duration-200
              ${selected.has(category.id)
                ? 'bg-pink-500 text-white'
                : 'bg-gray-800 text-gray-300'}
            `}
          >
            <span className="text-3xl mb-2">{category.emoji}</span>
            <span className="text-sm font-medium">{category.label}</span>
          </motion.button>
        ))}
      </div>

      <button
        onClick={handleContinue}
        disabled={selected.size < 3}
        className={`
          mt-6 w-full py-4 rounded-full font-semibold
          transition-all duration-200
          ${selected.size >= 3
            ? 'bg-pink-500 text-white'
            : 'bg-gray-700 text-gray-500 cursor-not-allowed'}
        `}
      >
        Continue ({selected.size}/3 selected)
      </button>
    </div>
  )
}
```

**Implicit Preference Learning UI:**

```typescript
// hooks/useWatchTracking.ts
export function useWatchTracking(videoId: string, isActive: boolean) {
  const startTimeRef = useRef<number | null>(null)
  const { trackWatch } = useUserStore()

  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now()
    } else if (startTimeRef.current) {
      const watchDuration = Date.now() - startTimeRef.current
      trackWatch(videoId, watchDuration)
      startTimeRef.current = null
    }
  }, [isActive, videoId, trackWatch])
}

// Visual feedback for new users
function NewUserFeedbackOverlay({ video }: { video: Video }) {
  const { isNewUser } = useUserStore()

  if (!isNewUser) return null

  return (
    <div className="absolute top-20 left-4 right-4">
      <div className="bg-black/70 rounded-xl p-4 text-white text-sm">
        <p className="font-semibold mb-1">We're learning your taste!</p>
        <p className="text-gray-300">
          Keep scrolling - we'll personalize your feed based on what you watch.
        </p>
      </div>
    </div>
  )
}
```

---

### Deep Dive 5: Creator Analytics Dashboard (5 minutes)

**Performance Chart:**

```typescript
// components/PerformanceChart.tsx
import { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface PerformanceChartProps {
  data: AnalyticsData[]
  metric: 'views' | 'likes' | 'shares' | 'comments'
}

export function PerformanceChart({ data, metric }: PerformanceChartProps) {
  const chartData = useMemo(() => {
    return data.map(d => ({
      date: formatDate(d.date),
      value: d[metric],
    }))
  }, [data, metric])

  const color = {
    views: '#3B82F6',
    likes: '#EF4444',
    shares: '#10B981',
    comments: '#F59E0B',
  }[metric]

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
          <XAxis
            dataKey="date"
            stroke="#9CA3AF"
            fontSize={12}
          />
          <YAxis
            stroke="#9CA3AF"
            fontSize={12}
            tickFormatter={formatCount}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1F2937',
              border: 'none',
              borderRadius: 8,
            }}
            labelStyle={{ color: '#fff' }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

**Video Analytics Table:**

```typescript
// components/VideoAnalyticsTable.tsx
export function VideoAnalyticsTable({ videos }: { videos: VideoAnalytics[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-gray-300">
        <thead className="text-gray-400 border-b border-gray-700">
          <tr>
            <th className="text-left py-3 px-4">Video</th>
            <th className="text-right py-3 px-4">Views</th>
            <th className="text-right py-3 px-4">Avg Watch</th>
            <th className="text-right py-3 px-4">Completion</th>
            <th className="text-right py-3 px-4">Likes</th>
            <th className="text-right py-3 px-4">Shares</th>
          </tr>
        </thead>
        <tbody>
          {videos.map(video => (
            <tr key={video.id} className="border-b border-gray-800 hover:bg-gray-800/50">
              <td className="py-3 px-4">
                <div className="flex items-center gap-3">
                  <img
                    src={video.thumbnailUrl}
                    className="h-12 w-9 object-cover rounded"
                    alt=""
                  />
                  <span className="line-clamp-2">{video.description}</span>
                </div>
              </td>
              <td className="text-right py-3 px-4 font-medium">
                {formatCount(video.views)}
              </td>
              <td className="text-right py-3 px-4">
                {formatDuration(video.avgWatchTime)}
              </td>
              <td className="text-right py-3 px-4">
                <CompletionBadge rate={video.completionRate} />
              </td>
              <td className="text-right py-3 px-4">
                {formatCount(video.likes)}
              </td>
              <td className="text-right py-3 px-4">
                {formatCount(video.shares)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CompletionBadge({ rate }: { rate: number }) {
  const color = rate > 0.7 ? 'green' : rate > 0.4 ? 'yellow' : 'red'
  return (
    <span className={`
      px-2 py-1 rounded text-xs font-medium
      ${color === 'green' && 'bg-green-500/20 text-green-400'}
      ${color === 'yellow' && 'bg-yellow-500/20 text-yellow-400'}
      ${color === 'red' && 'bg-red-500/20 text-red-400'}
    `}>
      {Math.round(rate * 100)}%
    </span>
  )
}
```

---

## Step 4: Responsive Design (3 minutes)

**Mobile-First Layout:**

```css
/* Base mobile styles */
.feed-container {
  @apply h-screen w-screen overflow-hidden;
}

.video-card {
  @apply h-full w-full relative;
}

.engagement-bar {
  @apply absolute right-3 bottom-24 flex flex-col gap-4;
}

/* Tablet landscape */
@media (min-width: 768px) and (orientation: landscape) {
  .feed-container {
    @apply max-w-2xl mx-auto;
  }
}

/* Desktop */
@media (min-width: 1024px) {
  .layout {
    @apply flex;
  }

  .sidebar {
    @apply w-64 flex-shrink-0;
  }

  .feed-container {
    @apply max-w-lg mx-auto;
  }

  .engagement-bar {
    @apply right-[-80px]; /* Move outside video */
  }
}
```

---

## Step 5: Accessibility (2 minutes)

```typescript
// Accessible video controls
function VideoPlayer({ video, isActive }: VideoPlayerProps) {
  return (
    <div
      role="region"
      aria-label={`Video by ${video.creator.username}`}
    >
      <video
        aria-describedby={`video-desc-${video.id}`}
      />

      {/* Hidden description for screen readers */}
      <span id={`video-desc-${video.id}`} className="sr-only">
        {video.description}. {video.duration} seconds long.
        {video.likeCount} likes, {video.commentCount} comments.
      </span>

      {/* Captions toggle */}
      <button
        aria-label="Toggle captions"
        aria-pressed={captionsEnabled}
      >
        <CaptionsIcon />
      </button>
    </div>
  )
}

// Reduced motion preference
function LikeButton() {
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  return (
    <motion.div
      animate={prefersReducedMotion ? {} : { scale: [1, 1.3, 1] }}
    >
      <HeartIcon />
    </motion.div>
  )
}
```

---

## Step 6: Key Design Decisions & Trade-offs (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Virtualization | @tanstack/react-virtual | react-window | Better TypeScript, active maintenance |
| Scroll behavior | Snap mandatory | Free scroll | TikTok-style full-screen experience |
| Preload strategy | 2 videos ahead | More aggressive | Memory constraints on mobile |
| Animation library | Framer Motion | CSS animations | Complex sequences, gesture support |
| State management | Zustand | Redux | Simpler API, less boilerplate |
| Charts | Recharts | D3 | Easier for common chart types |

---

## Closing Summary

I've designed the frontend for a TikTok-like platform with focus on five key areas:

1. **Virtualized Feed**: @tanstack/react-virtual renders only visible videos, maintaining 60 FPS with constant memory. Snap scrolling creates the signature TikTok experience.

2. **Video Player**: Autoplay on visibility, tap-to-pause, double-tap-to-like. Preloads next 2 videos and 5 thumbnails for instant transitions.

3. **Engagement UI**: Optimistic updates with visual feedback. Heart burst animation on like. Real-time count updates without over-fetching.

4. **Cold Start Onboarding**: Interest selector captures explicit preferences. Implicit learning via watch time tracking. Visual feedback explains personalization.

5. **Creator Analytics**: Performance charts with Recharts, video analytics table with completion rate badges, responsive layout for mobile creators.

**Key trade-offs:**
- Aggressive virtualization (overscan: 1) prioritizes memory over scroll smoothness
- Snap scrolling forces single-video viewing but matches user expectations
- Limited preloading respects mobile data but requires fast network
