# Spotify - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thank you. Today I'll design Spotify, a music streaming platform. As a frontend engineer, I'll focus on the core challenges of building an audio player experience, managing complex playback state, and delivering personalized recommendations in an intuitive interface.

The key frontend challenges are:
1. Building a persistent audio player with queue management and shuffle/repeat
2. Designing responsive library and playlist views with virtualized lists
3. Real-time playback state sync across components
4. Offline-first architecture for downloaded content

Let me start by clarifying the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Playback**: Full-featured audio player with queue, shuffle, repeat modes
2. **Library**: Browse saved tracks, albums, artists with search and filtering
3. **Playlists**: Create, edit, reorder tracks with drag-and-drop
4. **Discovery**: Browse personalized recommendations (Discover Weekly, Daily Mixes)
5. **Now Playing**: Immersive full-screen view with album art and lyrics

From a frontend perspective, the player experience and library management are the most interesting challenges."

### Non-Functional Requirements

"For user experience:

- **Playback Start**: Under 200ms perceived latency
- **Smooth Scrolling**: 60 FPS in library views with thousands of tracks
- **Responsive**: Adapt layout from mobile (320px) to desktop (1920px+)
- **Accessibility**: Full keyboard navigation, screen reader support
- **Offline**: Seamless transition between online and downloaded content"

---

## High-Level Design (8 minutes)

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           App Shell                                  │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                        Header Bar                                ││
│  │   Logo │ Search │ Navigation │ Profile                          ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ┌───────────────┐ ┌───────────────────────────────────────────────┐│
│  │               │ │                                               ││
│  │   Sidebar     │ │              Main Content                     ││
│  │               │ │                                               ││
│  │ - Home        │ │   ┌─────────────────────────────────────────┐ ││
│  │ - Search      │ │   │                                         │ ││
│  │ - Library     │ │   │   Route Content                         │ ││
│  │ ─────────     │ │   │   (Home/Search/Playlist/Album/Artist)   │ ││
│  │ - Playlists   │ │   │                                         │ ││
│  │ - Artists     │ │   │                                         │ ││
│  │ - Albums      │ │   └─────────────────────────────────────────┘ ││
│  │               │ │                                               ││
│  └───────────────┘ └───────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                     Now Playing Bar                              ││
│  │  [Album] Track Info │ Controls │ Progress │ Volume │ Queue      ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

```typescript
// Core dependencies
- React 19 with TypeScript
- TanStack Router for file-based routing
- Zustand for global state (player, library, queue)
- @tanstack/react-virtual for virtualized lists
- Tailwind CSS for styling
- Web Audio API for advanced playback features
```

---

## Deep Dive: Player Store Architecture (12 minutes)

### Zustand Store Design

```typescript
interface Track {
  id: string
  title: string
  duration_ms: number
  album: {
    id: string
    title: string
    cover_url: string
  }
  artist: {
    id: string
    name: string
  }
  explicit: boolean
}

interface PlayerState {
  // Playback state
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number      // milliseconds
  duration: number         // milliseconds
  volume: number          // 0-1
  isMuted: boolean

  // Queue management
  queue: Track[]
  queueIndex: number
  originalQueue: Track[]  // For shuffle restore

  // Playback modes
  shuffleEnabled: boolean
  repeatMode: 'off' | 'all' | 'one'

  // UI state
  isQueueVisible: boolean
  isNowPlayingExpanded: boolean
}

interface PlayerActions {
  // Playback controls
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (position: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void

  // Queue controls
  playTrack: (track: Track, context?: PlayContext) => void
  playQueue: (tracks: Track[], startIndex?: number) => void
  addToQueue: (tracks: Track[]) => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  skipNext: () => void
  skipPrevious: () => void

  // Mode toggles
  toggleShuffle: () => void
  cycleRepeatMode: () => void

  // Internal
  setCurrentTime: (time: number) => void
  onTrackEnd: () => void
}

type PlayContext = {
  type: 'album' | 'playlist' | 'artist' | 'search' | 'library'
  id: string
  name: string
}
```

### Player Store Implementation

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const usePlayerStore = create<PlayerState & PlayerActions>()(
  persist(
    (set, get) => ({
      // Initial state
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 1,
      isMuted: false,
      queue: [],
      queueIndex: -1,
      originalQueue: [],
      shuffleEnabled: false,
      repeatMode: 'off',
      isQueueVisible: false,
      isNowPlayingExpanded: false,

      // Playback controls
      play: () => set({ isPlaying: true }),
      pause: () => set({ isPlaying: false }),
      toggle: () => set(state => ({ isPlaying: !state.isPlaying })),

      seek: (position) => {
        set({ currentTime: position })
        // Audio element controlled via ref in AudioController
      },

      setVolume: (volume) => set({ volume, isMuted: false }),
      toggleMute: () => set(state => ({ isMuted: !state.isMuted })),

      // Play a single track
      playTrack: (track, context) => {
        set({
          currentTrack: track,
          queue: [track],
          queueIndex: 0,
          originalQueue: [track],
          isPlaying: true,
          currentTime: 0,
        })
      },

      // Play a queue of tracks
      playQueue: (tracks, startIndex = 0) => {
        const { shuffleEnabled } = get()
        let queue = [...tracks]
        let index = startIndex

        if (shuffleEnabled) {
          // Fisher-Yates shuffle, keeping startIndex track first
          const startTrack = queue[startIndex]
          queue.splice(startIndex, 1)
          for (let i = queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue[i], queue[j]] = [queue[j], queue[i]]
          }
          queue.unshift(startTrack)
          index = 0
        }

        set({
          currentTrack: queue[index],
          queue,
          queueIndex: index,
          originalQueue: tracks,
          isPlaying: true,
          currentTime: 0,
        })
      },

      // Skip to next track
      skipNext: () => {
        const { queue, queueIndex, repeatMode } = get()

        if (queue.length === 0) return

        let nextIndex = queueIndex + 1

        if (repeatMode === 'one') {
          // Repeat current track
          set({ currentTime: 0 })
          return
        }

        if (nextIndex >= queue.length) {
          if (repeatMode === 'all') {
            nextIndex = 0
          } else {
            // Stop at end
            set({ isPlaying: false })
            return
          }
        }

        set({
          queueIndex: nextIndex,
          currentTrack: queue[nextIndex],
          currentTime: 0,
          isPlaying: true,
        })
      },

      // Skip to previous track (or restart if > 3 seconds in)
      skipPrevious: () => {
        const { queue, queueIndex, currentTime } = get()

        if (queue.length === 0) return

        // If more than 3 seconds in, restart current track
        if (currentTime > 3000) {
          set({ currentTime: 0 })
          return
        }

        const prevIndex = queueIndex > 0 ? queueIndex - 1 : queue.length - 1

        set({
          queueIndex: prevIndex,
          currentTrack: queue[prevIndex],
          currentTime: 0,
          isPlaying: true,
        })
      },

      // Toggle shuffle
      toggleShuffle: () => {
        const { shuffleEnabled, queue, queueIndex, originalQueue, currentTrack } = get()

        if (shuffleEnabled) {
          // Restore original order
          const currentIndex = originalQueue.findIndex(t => t.id === currentTrack?.id)
          set({
            shuffleEnabled: false,
            queue: originalQueue,
            queueIndex: currentIndex >= 0 ? currentIndex : 0,
          })
        } else {
          // Shuffle remaining tracks
          const remaining = queue.slice(queueIndex + 1)
          for (let i = remaining.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [remaining[i], remaining[j]] = [remaining[j], remaining[i]]
          }
          const newQueue = [...queue.slice(0, queueIndex + 1), ...remaining]
          set({
            shuffleEnabled: true,
            queue: newQueue,
          })
        }
      },

      cycleRepeatMode: () => {
        const modes: Array<'off' | 'all' | 'one'> = ['off', 'all', 'one']
        set(state => ({
          repeatMode: modes[(modes.indexOf(state.repeatMode) + 1) % 3]
        }))
      },

      onTrackEnd: () => {
        get().skipNext()
      },

      setCurrentTime: (time) => set({ currentTime: time }),
    }),
    {
      name: 'spotify-player',
      partialize: (state) => ({
        volume: state.volume,
        shuffleEnabled: state.shuffleEnabled,
        repeatMode: state.repeatMode,
      }),
    }
  )
)
```

### Audio Controller Component

```tsx
import { useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export function AudioController() {
  const audioRef = useRef<HTMLAudioElement>(null)
  const streamUrlRef = useRef<string | null>(null)

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

    const fetchStreamUrl = async () => {
      try {
        const response = await fetch(`/api/playback/stream/${currentTrack.id}`)
        const { url } = await response.json()
        streamUrlRef.current = url

        if (audioRef.current) {
          audioRef.current.src = url
          audioRef.current.load()
          if (isPlaying) {
            audioRef.current.play()
          }
        }
      } catch (error) {
        console.error('Failed to get stream URL:', error)
      }
    }

    fetchStreamUrl()
  }, [currentTrack?.id])

  // Handle play/pause
  useEffect(() => {
    if (!audioRef.current) return

    if (isPlaying) {
      audioRef.current.play().catch(() => {
        // Auto-play blocked, update state
        usePlayerStore.getState().pause()
      })
    } else {
      audioRef.current.pause()
    }
  }, [isPlaying])

  // Handle volume
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume
    }
  }, [volume, isMuted])

  // Time update handler
  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime * 1000)
    }
  }, [setCurrentTime])

  // Report playback event for analytics
  const reportPlayback = useCallback(async (eventType: string, position: number) => {
    if (!currentTrack) return

    await fetch('/api/playback/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: currentTrack.id,
        event: eventType,
        position: Math.floor(position),
      }),
    }).catch(() => {}) // Fire and forget
  }, [currentTrack])

  // Track 30-second mark for stream counting
  const hasReportedStream = useRef(false)
  useEffect(() => {
    hasReportedStream.current = false
  }, [currentTrack?.id])

  const handleTimeUpdateWithAnalytics = useCallback(() => {
    handleTimeUpdate()

    if (audioRef.current && !hasReportedStream.current) {
      const position = audioRef.current.currentTime
      if (position >= 30) {
        hasReportedStream.current = true
        reportPlayback('stream_counted', position * 1000)
      }
    }
  }, [handleTimeUpdate, reportPlayback])

  return (
    <audio
      ref={audioRef}
      onTimeUpdate={handleTimeUpdateWithAnalytics}
      onEnded={onTrackEnd}
      onPlay={() => reportPlayback('play', audioRef.current?.currentTime ?? 0)}
      onPause={() => reportPlayback('pause', audioRef.current?.currentTime ?? 0)}
      preload="auto"
    />
  )
}
```

---

## Deep Dive: Now Playing Bar (8 minutes)

### Component Structure

```tsx
import { usePlayerStore } from '../stores/playerStore'
import { formatDuration } from '../utils/format'
import {
  PlayIcon, PauseIcon, SkipNextIcon, SkipPreviousIcon,
  ShuffleIcon, RepeatIcon, RepeatOneIcon, VolumeIcon,
  VolumeMuteIcon, QueueIcon
} from './icons'

export function NowPlayingBar() {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    shuffleEnabled,
    repeatMode,
    toggle,
    skipNext,
    skipPrevious,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeatMode,
  } = usePlayerStore()

  if (!currentTrack) {
    return (
      <div className="fixed bottom-0 left-0 right-0 h-20 bg-neutral-900 border-t border-neutral-800">
        <div className="flex items-center justify-center h-full text-neutral-500">
          Select a track to play
        </div>
      </div>
    )
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <footer
      className="fixed bottom-0 left-0 right-0 h-20 bg-neutral-900 border-t border-neutral-800 px-4"
      role="region"
      aria-label="Now playing"
    >
      <div className="flex items-center h-full max-w-screen-2xl mx-auto">
        {/* Track info */}
        <div className="flex items-center gap-3 w-72 min-w-0">
          <img
            src={currentTrack.album.cover_url}
            alt={`${currentTrack.album.title} cover`}
            className="w-14 h-14 rounded"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {currentTrack.title}
            </p>
            <p className="text-xs text-neutral-400 truncate">
              {currentTrack.artist.name}
            </p>
          </div>
        </div>

        {/* Playback controls */}
        <div className="flex-1 flex flex-col items-center justify-center gap-1">
          <div className="flex items-center gap-4">
            <button
              onClick={toggleShuffle}
              className={`p-2 rounded-full hover:bg-neutral-800 transition-colors
                ${shuffleEnabled ? 'text-green-500' : 'text-neutral-400'}`}
              aria-label={shuffleEnabled ? 'Disable shuffle' : 'Enable shuffle'}
              aria-pressed={shuffleEnabled}
            >
              <ShuffleIcon className="w-5 h-5" />
            </button>

            <button
              onClick={skipPrevious}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
              aria-label="Previous track"
            >
              <SkipPreviousIcon className="w-5 h-5" />
            </button>

            <button
              onClick={toggle}
              className="w-10 h-10 flex items-center justify-center rounded-full
                bg-white text-black hover:scale-105 transition-transform"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <PauseIcon className="w-5 h-5" />
              ) : (
                <PlayIcon className="w-5 h-5 ml-0.5" />
              )}
            </button>

            <button
              onClick={skipNext}
              className="p-2 text-neutral-400 hover:text-white transition-colors"
              aria-label="Next track"
            >
              <SkipNextIcon className="w-5 h-5" />
            </button>

            <button
              onClick={cycleRepeatMode}
              className={`p-2 rounded-full hover:bg-neutral-800 transition-colors
                ${repeatMode !== 'off' ? 'text-green-500' : 'text-neutral-400'}`}
              aria-label={`Repeat: ${repeatMode}`}
            >
              {repeatMode === 'one' ? (
                <RepeatOneIcon className="w-5 h-5" />
              ) : (
                <RepeatIcon className="w-5 h-5" />
              )}
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex items-center gap-2 w-full max-w-xl">
            <span className="text-xs text-neutral-400 w-10 text-right">
              {formatDuration(currentTime)}
            </span>
            <ProgressSlider
              value={progress}
              onChange={(pct) => seek((pct / 100) * duration)}
              aria-label="Playback progress"
            />
            <span className="text-xs text-neutral-400 w-10">
              {formatDuration(duration)}
            </span>
          </div>
        </div>

        {/* Volume and queue */}
        <div className="flex items-center gap-3 w-72 justify-end">
          <button
            onClick={toggleMute}
            className="p-2 text-neutral-400 hover:text-white transition-colors"
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted || volume === 0 ? (
              <VolumeMuteIcon className="w-5 h-5" />
            ) : (
              <VolumeIcon className="w-5 h-5" />
            )}
          </button>
          <VolumeSlider
            value={isMuted ? 0 : volume * 100}
            onChange={(pct) => setVolume(pct / 100)}
            aria-label="Volume"
          />
          <button
            onClick={() => usePlayerStore.setState(s => ({
              isQueueVisible: !s.isQueueVisible
            }))}
            className="p-2 text-neutral-400 hover:text-white transition-colors"
            aria-label="Show queue"
          >
            <QueueIcon className="w-5 h-5" />
          </button>
        </div>
      </div>
    </footer>
  )
}
```

### Progress Slider Component

```tsx
interface SliderProps {
  value: number
  onChange: (value: number) => void
  'aria-label': string
}

function ProgressSlider({ value, onChange, 'aria-label': ariaLabel }: SliderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [hoverValue, setHoverValue] = useState<number | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true)
    updateValue(e)
  }

  const updateValue = (e: MouseEvent | React.MouseEvent) => {
    if (!trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
    onChange(pct)
  }

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => updateValue(e)
    const handleMouseUp = () => setIsDragging(false)

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  const displayValue = hoverValue ?? value

  return (
    <div
      ref={trackRef}
      className="group relative flex-1 h-1 bg-neutral-600 rounded-full cursor-pointer"
      onMouseDown={handleMouseDown}
      onMouseMove={(e) => {
        if (!trackRef.current) return
        const rect = trackRef.current.getBoundingClientRect()
        setHoverValue(((e.clientX - rect.left) / rect.width) * 100)
      }}
      onMouseLeave={() => setHoverValue(null)}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
    >
      <div
        className="absolute left-0 top-0 h-full bg-white group-hover:bg-green-500 rounded-full transition-colors"
        style={{ width: `${displayValue}%` }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full
          opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ left: `calc(${displayValue}% - 6px)` }}
      />
    </div>
  )
}
```

---

## Deep Dive: Virtualized Track List (8 minutes)

### Library View with Virtual Scrolling

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { formatDuration } from '../utils/format'

interface Track {
  id: string
  title: string
  artist: { id: string; name: string }
  album: { id: string; title: string; cover_url: string }
  duration_ms: number
  explicit: boolean
}

interface TrackListProps {
  tracks: Track[]
  context: { type: string; id: string; name: string }
}

export function TrackList({ tracks, context }: TrackListProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const { currentTrack, isPlaying, playQueue } = usePlayerStore()

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56, // Row height
    overscan: 10, // Render extra items above/below viewport
  })

  const handlePlayTrack = useCallback((index: number) => {
    playQueue(tracks, index)
  }, [tracks, playQueue])

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      {/* Header row */}
      <div className="sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800
        grid grid-cols-[16px_minmax(200px,4fr)_minmax(150px,2fr)_minmax(100px,1fr)_60px]
        gap-4 px-4 py-2 text-xs text-neutral-400 uppercase tracking-wider">
        <span>#</span>
        <span>Title</span>
        <span>Album</span>
        <span>Date Added</span>
        <span className="text-right">Duration</span>
      </div>

      {/* Virtual list container */}
      <div
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const track = tracks[virtualItem.index]
          const isCurrentTrack = currentTrack?.id === track.id
          const isPlayingThis = isCurrentTrack && isPlaying

          return (
            <div
              key={track.id}
              className={`absolute left-0 right-0 grid
                grid-cols-[16px_minmax(200px,4fr)_minmax(150px,2fr)_minmax(100px,1fr)_60px]
                gap-4 px-4 py-2 items-center hover:bg-neutral-800/50 group cursor-pointer
                ${isCurrentTrack ? 'bg-neutral-800/30' : ''}`}
              style={{
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              onClick={() => handlePlayTrack(virtualItem.index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  handlePlayTrack(virtualItem.index)
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Play ${track.title} by ${track.artist.name}`}
            >
              {/* Track number / playing indicator */}
              <span className="text-sm text-neutral-400">
                {isPlayingThis ? (
                  <span className="text-green-500">
                    <EqualizerIcon className="w-4 h-4" />
                  </span>
                ) : (
                  <span className="group-hover:hidden">{virtualItem.index + 1}</span>
                )}
                <PlayIcon className="w-4 h-4 hidden group-hover:block" />
              </span>

              {/* Title and artist */}
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={track.album.cover_url}
                  alt=""
                  className="w-10 h-10 rounded flex-shrink-0"
                  loading="lazy"
                />
                <div className="min-w-0">
                  <p className={`text-sm font-medium truncate
                    ${isCurrentTrack ? 'text-green-500' : 'text-white'}`}>
                    {track.title}
                    {track.explicit && (
                      <span className="ml-2 px-1 py-0.5 text-[10px] bg-neutral-600
                        rounded text-neutral-300">
                        E
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-400 truncate">
                    {track.artist.name}
                  </p>
                </div>
              </div>

              {/* Album */}
              <span className="text-sm text-neutral-400 truncate">
                {track.album.title}
              </span>

              {/* Date added (placeholder) */}
              <span className="text-sm text-neutral-400">
                2 days ago
              </span>

              {/* Duration */}
              <span className="text-sm text-neutral-400 text-right">
                {formatDuration(track.duration_ms)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

### Performance Optimizations

```typescript
// Memoize track rows to prevent unnecessary re-renders
const TrackRow = memo(function TrackRow({
  track,
  index,
  isCurrentTrack,
  isPlaying,
  onPlay,
}: TrackRowProps) {
  // ...row implementation
}, (prev, next) => {
  return (
    prev.track.id === next.track.id &&
    prev.isCurrentTrack === next.isCurrentTrack &&
    prev.isPlaying === next.isPlaying &&
    prev.index === next.index
  )
})

// Lazy load album art with intersection observer
function LazyImage({ src, alt, className }: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && imgRef.current) {
          imgRef.current.src = src
          observer.disconnect()
        }
      },
      { rootMargin: '100px' }
    )

    if (imgRef.current) {
      observer.observe(imgRef.current)
    }

    return () => observer.disconnect()
  }, [src])

  return (
    <img
      ref={imgRef}
      alt={alt}
      className={`${className} ${isLoaded ? '' : 'bg-neutral-700 animate-pulse'}`}
      onLoad={() => setIsLoaded(true)}
    />
  )
}
```

---

## Deep Dive: Responsive Layout (5 minutes)

### Mobile-First Design

```tsx
// Tailwind breakpoints used throughout:
// sm: 640px, md: 768px, lg: 1024px, xl: 1280px

function AppLayout() {
  return (
    <div className="flex flex-col h-screen bg-black text-white">
      {/* Header - simplified on mobile */}
      <Header />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - hidden on mobile, shown on md+ */}
        <aside className="hidden md:flex md:w-60 lg:w-72 flex-col
          bg-neutral-900 border-r border-neutral-800">
          <Sidebar />
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto pb-20 md:pb-24">
          <Outlet />
        </main>
      </div>

      {/* Now Playing Bar - compact on mobile */}
      <NowPlayingBar />

      {/* Mobile navigation - bottom tabs on mobile */}
      <nav className="md:hidden fixed bottom-20 left-0 right-0
        bg-neutral-900 border-t border-neutral-800 flex justify-around py-2">
        <MobileNavItem to="/" icon={HomeIcon} label="Home" />
        <MobileNavItem to="/search" icon={SearchIcon} label="Search" />
        <MobileNavItem to="/library" icon={LibraryIcon} label="Library" />
      </nav>
    </div>
  )
}
```

### Responsive Grid for Album/Playlist Cards

```tsx
function CardGrid({ items }: { items: CardItem[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5
      xl:grid-cols-6 gap-4 p-4">
      {items.map((item) => (
        <Card key={item.id} {...item} />
      ))}
    </div>
  )
}

function Card({ id, title, subtitle, imageUrl, type }: CardItem) {
  return (
    <Link
      to={`/${type}/${id}`}
      className="group p-3 rounded-lg bg-neutral-800/50 hover:bg-neutral-800
        transition-colors"
    >
      <div className="relative aspect-square mb-3">
        <img
          src={imageUrl}
          alt=""
          className={`w-full h-full object-cover shadow-lg
            ${type === 'artist' ? 'rounded-full' : 'rounded-md'}`}
        />
        <button
          className="absolute bottom-2 right-2 w-12 h-12 rounded-full bg-green-500
            flex items-center justify-center opacity-0 translate-y-2
            group-hover:opacity-100 group-hover:translate-y-0
            transition-all shadow-xl hover:scale-105"
          onClick={(e) => {
            e.preventDefault()
            // Play this album/playlist
          }}
          aria-label={`Play ${title}`}
        >
          <PlayIcon className="w-5 h-5 text-black ml-0.5" />
        </button>
      </div>
      <h3 className="font-medium text-white truncate">{title}</h3>
      <p className="text-sm text-neutral-400 truncate">{subtitle}</p>
    </Link>
  )
}
```

---

## Accessibility Considerations

### Keyboard Navigation

```typescript
// Global keyboard shortcuts
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ignore if typing in an input
    if (e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement) {
      return
    }

    const { toggle, skipNext, skipPrevious, toggleMute } = usePlayerStore.getState()

    switch (e.key) {
      case ' ':
        e.preventDefault()
        toggle()
        break
      case 'ArrowRight':
        if (e.shiftKey) skipNext()
        break
      case 'ArrowLeft':
        if (e.shiftKey) skipPrevious()
        break
      case 'm':
        toggleMute()
        break
    }
  }

  document.addEventListener('keydown', handleKeyDown)
  return () => document.removeEventListener('keydown', handleKeyDown)
}, [])
```

### Screen Reader Announcements

```tsx
// Announce track changes
function TrackChangeAnnouncer() {
  const currentTrack = usePlayerStore(s => s.currentTrack)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (currentTrack) {
      setAnnouncement(`Now playing: ${currentTrack.title} by ${currentTrack.artist.name}`)
    }
  }, [currentTrack?.id])

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </div>
  )
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux Toolkit | Simpler API, built-in persistence, smaller bundle |
| List Virtualization | @tanstack/react-virtual | react-window | More flexible, better dynamic sizing |
| Audio API | Native HTML5 Audio | Web Audio API | Simpler; Web Audio for future equalizer |
| Styling | Tailwind CSS | CSS-in-JS (styled-components) | Better performance, smaller bundle |
| Queue in Store | Single queue array | Separate upcoming/history | Simpler state, easier shuffle/repeat |
| Progress Updates | timeupdate event | requestAnimationFrame | Native event sufficient, less CPU usage |

---

## Future Enhancements (Frontend Focus)

1. **Crossfade**: Use Web Audio API to blend track endings/beginnings
2. **Equalizer**: Audio visualization and EQ controls
3. **Drag-and-Drop Reordering**: In playlists and queue
4. **Offline Mode**: IndexedDB for downloaded tracks with service worker
5. **Spotify Connect**: WebSocket sync for cross-device control
6. **Lyrics Sync**: Scrolling lyrics synchronized with playback position
7. **Picture-in-Picture**: Mini player for multitasking

---

## Summary

"To summarize the frontend architecture:

1. **Zustand player store** managing playback state, queue, shuffle/repeat with localStorage persistence
2. **Audio controller component** coordinating HTML5 Audio with stream URL fetching and analytics reporting
3. **Virtualized track lists** using @tanstack/react-virtual for smooth scrolling through large libraries
4. **Responsive layout** with mobile-first design, collapsible sidebar, and bottom navigation
5. **Accessible controls** with full keyboard support and ARIA attributes

The architecture prioritizes a fluid playback experience with efficient rendering for large music libraries.

What aspects would you like to explore further?"
