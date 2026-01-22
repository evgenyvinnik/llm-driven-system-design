# YouTube - Video Platform - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"I'll be designing the frontend architecture for a video hosting and streaming platform like YouTube. This is a complex frontend challenge involving adaptive video streaming with HLS.js, chunked file uploads with progress tracking, real-time engagement features, and a sophisticated recommendation-driven home feed. The UI must balance information density with visual clarity while supporting both light and dark themes. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (3-4 minutes)

### Core User Flows

1. **Video Consumption**
   - Browse and discover videos on home feed
   - Watch videos with adaptive quality selection
   - Engage with like/dislike, comments, subscribe
   - Resume playback from where user left off

2. **Content Creation**
   - Upload large video files with progress tracking
   - Set title, description, tags, visibility
   - Monitor transcoding status
   - View analytics on published videos

3. **Channel Experience**
   - Browse channel page with video grid
   - Subscribe/unsubscribe with notification preferences
   - View channel about section and statistics

4. **Search and Discovery**
   - Search videos by title, description, tags
   - Filter by category, duration, upload date
   - Trending and personalized recommendations

### UI/UX Requirements

- **Performance**: Video start time < 2 seconds, smooth scrolling with virtualized lists
- **Responsiveness**: Adaptive grid from 1 to 6 columns
- **Accessibility**: Keyboard navigation, screen reader support, captions
- **Brand Fidelity**: Match YouTube's visual identity closely

---

## 2. Component Architecture (8-10 minutes)

### Application Structure

```
src/
├── routes/
│   ├── __root.tsx              # App shell with sidebar
│   ├── index.tsx               # Home feed with recommendations
│   ├── watch.$videoId.tsx      # Video player page
│   ├── channel.$handle.tsx     # Channel page
│   ├── upload.tsx              # Video upload page
│   ├── search.tsx              # Search results
│   ├── subscriptions.tsx       # Subscription feed
│   ├── history.tsx             # Watch history
│   └── studio/                 # Creator dashboard
│       ├── index.tsx           # Overview
│       ├── videos.tsx          # Video management
│       └── analytics.tsx       # Channel analytics
├── components/
│   ├── player/
│   │   ├── VideoPlayer.tsx     # HLS player wrapper
│   │   ├── PlayerControls.tsx  # Play, seek, volume, quality
│   │   ├── QualitySelector.tsx # Resolution picker
│   │   ├── ProgressBar.tsx     # Seek bar with preview
│   │   └── CaptionsDisplay.tsx # Subtitle overlay
│   ├── video/
│   │   ├── VideoCard.tsx       # Thumbnail + metadata
│   │   ├── VideoGrid.tsx       # Virtualized grid layout
│   │   ├── VideoRow.tsx        # Horizontal card for lists
│   │   └── VideoSkeleton.tsx   # Loading placeholder
│   ├── engagement/
│   │   ├── LikeDislikeBar.tsx  # Vote buttons with counter
│   │   ├── CommentSection.tsx  # Threaded comments
│   │   ├── CommentForm.tsx     # New comment input
│   │   └── SubscribeButton.tsx # Subscribe with animation
│   ├── upload/
│   │   ├── FileDropzone.tsx    # Drag-and-drop area
│   │   ├── UploadProgress.tsx  # Chunk upload progress
│   │   ├── MetadataForm.tsx    # Title, description, tags
│   │   └── ThumbnailPicker.tsx # Thumbnail selection
│   ├── layout/
│   │   ├── Sidebar.tsx         # Navigation sidebar
│   │   ├── Header.tsx          # Search bar, user menu
│   │   ├── MiniSidebar.tsx     # Collapsed icon sidebar
│   │   └── BottomNav.tsx       # Mobile navigation
│   └── icons/
│       ├── index.ts            # Barrel export
│       ├── HomeIcon.tsx
│       ├── SubscriptionsIcon.tsx
│       └── ... (YouTube icon set)
├── hooks/
│   ├── useVideoPlayer.ts       # HLS.js integration
│   ├── useChunkedUpload.ts     # Resumable uploads
│   ├── useIntersectionObserver.ts
│   ├── useWatchProgress.ts     # Track and sync position
│   └── useTheme.ts             # Dark/light mode
├── store/
│   ├── authStore.ts            # User session
│   ├── playerStore.ts          # Playback state
│   ├── uploadStore.ts          # Upload queue
│   └── uiStore.ts              # Sidebar, modals
└── services/
    ├── api.ts                  # HTTP client
    ├── videoApi.ts             # Video CRUD
    ├── commentApi.ts           # Comments API
    └── uploadApi.ts            # Chunked upload API
```

### Component Hierarchy

```
<App>
├── <RouterProvider>
│   └── <RootLayout>
│       ├── <Header>
│       │   ├── <Logo />
│       │   ├── <SearchBar />
│       │   └── <UserMenu />
│       ├── <Sidebar>
│       │   ├── <NavItem icon={HomeIcon} label="Home" />
│       │   ├── <NavItem icon={SubscriptionsIcon} label="Subscriptions" />
│       │   └── <SubscriptionsList />
│       └── <Outlet />  {/* Route content */}
│
├── <HomePage>
│   ├── <CategoryTabs />
│   └── <VideoGrid>
│       ├── <VideoCard /> (virtualized)
│       └── ...
│
├── <WatchPage>
│   ├── <VideoPlayer>
│   │   ├── <HLSVideo />
│   │   ├── <PlayerControls />
│   │   └── <QualitySelector />
│   ├── <VideoInfo>
│   │   ├── <VideoTitle />
│   │   ├── <ChannelInfo />
│   │   ├── <LikeDislikeBar />
│   │   └── <SubscribeButton />
│   ├── <CommentSection>
│   │   ├── <CommentForm />
│   │   └── <CommentList>
│   │       └── <Comment /> (recursive for replies)
│   └── <RecommendationSidebar>
│       └── <VideoRow /> (stacked)
│
└── <UploadPage>
    ├── <FileDropzone />
    ├── <UploadProgress />
    └── <MetadataForm>
        ├── <TitleInput />
        ├── <DescriptionEditor />
        ├── <TagsInput />
        └── <ThumbnailPicker />
```

---

## 3. Deep Dive: Video Player with HLS.js (10-12 minutes)

### HLS Video Player Component

```tsx
// components/player/VideoPlayer.tsx
import Hls from 'hls.js';
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePlayerStore } from '@/store/playerStore';
import { PlayerControls } from './PlayerControls';
import { QualitySelector } from './QualitySelector';

interface VideoPlayerProps {
  videoId: string;
  manifestUrl: string;
  thumbnailUrl: string;
  duration: number;
  startPosition?: number;
  onProgress?: (position: number) => void;
}

interface QualityLevel {
  index: number;
  height: number;
  bitrate: number;
  label: string;
}

export function VideoPlayer({
  videoId,
  manifestUrl,
  thumbnailUrl,
  duration,
  startPosition = 0,
  onProgress
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = auto
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const { volume, setVolume, playbackRate } = usePlayerStore();

  // Initialize HLS.js
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Check for native HLS support (Safari)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = manifestUrl;
      video.currentTime = startPosition;
      return;
    }

    // Use HLS.js for other browsers
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        startLevel: -1, // Auto quality selection
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startPosition: startPosition
      });

      hls.attachMedia(video);
      hls.loadSource(manifestUrl);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        // Extract quality levels
        const levels = data.levels.map((level, index) => ({
          index,
          height: level.height,
          bitrate: level.bitrate,
          label: `${level.height}p`
        }));
        setQualityLevels([
          { index: -1, height: 0, bitrate: 0, label: 'Auto' },
          ...levels.sort((a, b) => b.height - a.height)
        ]);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (currentQuality === -1) {
          // Update UI when auto-switching
          setCurrentQuality(-1);
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('Network error, attempting recovery...');
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('Media error, attempting recovery...');
              hls.recoverMediaError();
              break;
            default:
              console.error('Fatal error, destroying HLS instance');
              hls.destroy();
              break;
          }
        }
      });

      hlsRef.current = hls;
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [manifestUrl, startPosition]);

  // Quality selection handler
  const handleQualityChange = useCallback((levelIndex: number) => {
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIndex; // -1 for auto
      setCurrentQuality(levelIndex);
    }
  }, []);

  // Playback controls
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  }, []);

  const handleSeek = useCallback((time: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = time;
    }
  }, []);

  const handleVolumeChange = useCallback((newVolume: number) => {
    const video = videoRef.current;
    if (video) {
      video.volume = newVolume;
      video.muted = newVolume === 0;
      setVolume(newVolume);
    }
  }, [setVolume]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      onProgress?.(video.currentTime);
    };
    const handleProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('progress', handleProgress);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('progress', handleProgress);
    };
  }, [onProgress]);

  // Controls auto-hide
  useEffect(() => {
    let timeout: NodeJS.Timeout;

    const handleMouseMove = () => {
      setShowControls(true);
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (isPlaying) {
          setShowControls(false);
        }
      }, 3000);
    };

    const container = containerRef.current;
    container?.addEventListener('mousemove', handleMouseMove);

    return () => {
      container?.removeEventListener('mousemove', handleMouseMove);
      clearTimeout(timeout);
    };
  }, [isPlaying]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          handleSeek(Math.max(0, currentTime - 5));
          break;
        case 'ArrowRight':
          handleSeek(Math.min(duration, currentTime + 5));
          break;
        case 'ArrowUp':
          handleVolumeChange(Math.min(1, volume + 0.1));
          break;
        case 'ArrowDown':
          handleVolumeChange(Math.max(0, volume - 0.1));
          break;
        case 'f':
          toggleFullscreen();
          break;
        case 'm':
          handleVolumeChange(volume > 0 ? 0 : 1);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, handleSeek, handleVolumeChange, toggleFullscreen, currentTime, duration, volume]);

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative aspect-video bg-black group',
        isFullscreen && 'fixed inset-0 z-50'
      )}
    >
      <video
        ref={videoRef}
        className="w-full h-full"
        poster={thumbnailUrl}
        playsInline
        onClick={togglePlay}
      />

      {/* Gradient overlay for controls */}
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/30',
          'transition-opacity duration-300',
          showControls ? 'opacity-100' : 'opacity-0'
        )}
      />

      {/* Player controls */}
      <PlayerControls
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        buffered={buffered}
        volume={volume}
        isFullscreen={isFullscreen}
        visible={showControls}
        onPlayPause={togglePlay}
        onSeek={handleSeek}
        onVolumeChange={handleVolumeChange}
        onFullscreen={toggleFullscreen}
      >
        <QualitySelector
          levels={qualityLevels}
          currentLevel={currentQuality}
          onChange={handleQualityChange}
        />
      </PlayerControls>

      {/* Big play button when paused */}
      {!isPlaying && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
        >
          <div className="w-20 h-20 bg-black/70 rounded-full flex items-center justify-center">
            <PlayIcon className="w-10 h-10 text-white ml-1" />
          </div>
        </button>
      )}
    </div>
  );
}
```

### Progress Bar with Seek Preview

```tsx
// components/player/ProgressBar.tsx
import { useRef, useState, useCallback } from 'react';

interface ProgressBarProps {
  currentTime: number;
  duration: number;
  buffered: number;
  onSeek: (time: number) => void;
  thumbnailUrl?: string;
}

export function ProgressBar({
  currentTime,
  duration,
  buffered,
  onSeek,
  thumbnailUrl
}: ProgressBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverPosition, setHoverPosition] = useState(0);

  const progress = (currentTime / duration) * 100;
  const bufferedPercent = (buffered / duration) * 100;

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!barRef.current) return;

    const rect = barRef.current.getBoundingClientRect();
    const position = (e.clientX - rect.left) / rect.width;
    const time = position * duration;

    setHoverTime(time);
    setHoverPosition(e.clientX - rect.left);
  }, [duration]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!barRef.current) return;

    const rect = barRef.current.getBoundingClientRect();
    const position = (e.clientX - rect.left) / rect.width;
    const time = Math.max(0, Math.min(duration, position * duration));

    onSeek(time);
  }, [duration, onSeek]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={barRef}
      className="relative h-1 group-hover:h-1.5 bg-white/30 cursor-pointer transition-all"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverTime(null)}
      onClick={handleClick}
    >
      {/* Buffered progress */}
      <div
        className="absolute h-full bg-white/50"
        style={{ width: `${bufferedPercent}%` }}
      />

      {/* Watched progress - YouTube red */}
      <div
        className="absolute h-full bg-[#FF0000]"
        style={{ width: `${progress}%` }}
      />

      {/* Scrubber handle */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-[#FF0000] rounded-full
                   opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ left: `${progress}%`, transform: 'translate(-50%, -50%)' }}
      />

      {/* Hover preview */}
      {hoverTime !== null && (
        <div
          className="absolute bottom-6 -translate-x-1/2 pointer-events-none"
          style={{ left: hoverPosition }}
        >
          {/* Thumbnail preview (if available) */}
          {thumbnailUrl && (
            <div className="w-40 h-24 bg-black rounded overflow-hidden mb-2">
              <img
                src={`${thumbnailUrl}?t=${Math.floor(hoverTime)}`}
                alt="Preview"
                className="w-full h-full object-cover"
              />
            </div>
          )}
          {/* Time label */}
          <div className="bg-black/80 text-white text-xs px-2 py-1 rounded text-center">
            {formatTime(hoverTime)}
          </div>
        </div>
      )}
    </div>
  );
}
```

### Quality Selector Component

```tsx
// components/player/QualitySelector.tsx
import { useState } from 'react';

interface QualityLevel {
  index: number;
  height: number;
  label: string;
}

interface QualitySelectorProps {
  levels: QualityLevel[];
  currentLevel: number;
  onChange: (levelIndex: number) => void;
}

export function QualitySelector({
  levels,
  currentLevel,
  onChange
}: QualitySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const currentLabel = currentLevel === -1
    ? 'Auto'
    : levels.find(l => l.index === currentLevel)?.label || 'Auto';

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 px-2 py-1 text-white text-sm
                   hover:bg-white/10 rounded"
      >
        <SettingsIcon className="w-5 h-5" />
        <span>{currentLabel}</span>
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Quality menu */}
          <div className="absolute bottom-full right-0 mb-2 bg-neutral-900/95
                          rounded-lg overflow-hidden min-w-[120px] z-20">
            <div className="py-2">
              {levels.map((level) => (
                <button
                  key={level.index}
                  onClick={() => {
                    onChange(level.index);
                    setIsOpen(false);
                  }}
                  className={cn(
                    'w-full px-4 py-2 text-left text-sm flex items-center gap-2',
                    'hover:bg-white/10',
                    currentLevel === level.index && 'text-[#3EA6FF]'
                  )}
                >
                  {currentLevel === level.index && (
                    <CheckIcon className="w-4 h-4" />
                  )}
                  <span className={currentLevel !== level.index ? 'ml-6' : ''}>
                    {level.label}
                  </span>
                  {level.index === -1 && currentLevel === -1 && (
                    <span className="text-xs text-neutral-400 ml-auto">
                      (currently 720p)
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
```

---

## 4. Deep Dive: Chunked Upload with Progress (8-10 minutes)

### useChunkedUpload Hook

```tsx
// hooks/useChunkedUpload.ts
import { useState, useCallback, useRef } from 'react';
import { uploadApi } from '@/services/uploadApi';

interface UploadProgress {
  status: 'idle' | 'initializing' | 'uploading' | 'processing' | 'complete' | 'error';
  uploadedChunks: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
  percentComplete: number;
  speed: number; // bytes per second
  timeRemaining: number; // seconds
  videoId?: string;
  error?: string;
}

interface ChunkUploadOptions {
  chunkSize?: number;
  maxConcurrent?: number;
  onProgress?: (progress: UploadProgress) => void;
}

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_CONCURRENT = 3;

export function useChunkedUpload(options: ChunkUploadOptions = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onProgress
  } = options;

  const [progress, setProgress] = useState<UploadProgress>({
    status: 'idle',
    uploadedChunks: 0,
    totalChunks: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    percentComplete: 0,
    speed: 0,
    timeRemaining: 0
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const speedSamplesRef = useRef<number[]>([]);
  const lastUpdateRef = useRef<number>(Date.now());

  const updateProgress = useCallback((updates: Partial<UploadProgress>) => {
    setProgress(prev => {
      const newProgress = { ...prev, ...updates };

      // Calculate speed (moving average)
      const now = Date.now();
      const elapsed = (now - lastUpdateRef.current) / 1000;

      if (elapsed > 0 && updates.uploadedBytes !== undefined) {
        const bytesThisInterval = updates.uploadedBytes - prev.uploadedBytes;
        const currentSpeed = bytesThisInterval / elapsed;

        speedSamplesRef.current.push(currentSpeed);
        if (speedSamplesRef.current.length > 10) {
          speedSamplesRef.current.shift();
        }

        newProgress.speed = speedSamplesRef.current.reduce((a, b) => a + b, 0)
          / speedSamplesRef.current.length;

        const remainingBytes = newProgress.totalBytes - newProgress.uploadedBytes;
        newProgress.timeRemaining = newProgress.speed > 0
          ? remainingBytes / newProgress.speed
          : 0;

        lastUpdateRef.current = now;
      }

      newProgress.percentComplete = newProgress.totalBytes > 0
        ? Math.round((newProgress.uploadedBytes / newProgress.totalBytes) * 100)
        : 0;

      onProgress?.(newProgress);
      return newProgress;
    });
  }, [onProgress]);

  const uploadFile = useCallback(async (
    file: File,
    metadata: { title: string; description?: string; tags?: string[] }
  ): Promise<string> => {
    abortControllerRef.current = new AbortController();
    speedSamplesRef.current = [];
    lastUpdateRef.current = Date.now();

    try {
      // Initialize upload
      updateProgress({
        status: 'initializing',
        totalBytes: file.size,
        uploadedBytes: 0
      });

      const { uploadId, totalChunks } = await uploadApi.initializeUpload({
        filename: file.name,
        fileSize: file.size,
        mimeType: file.type
      });

      updateProgress({
        status: 'uploading',
        totalChunks
      });

      // Split file into chunks
      const chunks: { index: number; blob: Blob }[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        chunks.push({
          index: i,
          blob: file.slice(start, end)
        });
      }

      // Upload chunks with concurrency limit
      const uploadedChunks = new Set<number>();
      let uploadedBytes = 0;

      const uploadChunk = async (chunk: { index: number; blob: Blob }) => {
        if (abortControllerRef.current?.signal.aborted) {
          throw new Error('Upload cancelled');
        }

        await uploadApi.uploadChunk(uploadId, chunk.index, chunk.blob, {
          signal: abortControllerRef.current?.signal,
          onProgress: (chunkProgress) => {
            // Update bytes for this chunk
            const chunkBytes = Math.round(chunk.blob.size * chunkProgress);
            // This is approximate - real implementation would track per-chunk
          }
        });

        uploadedChunks.add(chunk.index);
        uploadedBytes += chunk.blob.size;

        updateProgress({
          uploadedChunks: uploadedChunks.size,
          uploadedBytes
        });
      };

      // Process chunks with concurrency pool
      const pool: Promise<void>[] = [];

      for (const chunk of chunks) {
        const promise = uploadChunk(chunk).then(() => {
          pool.splice(pool.indexOf(promise), 1);
        });
        pool.push(promise);

        if (pool.length >= maxConcurrent) {
          await Promise.race(pool);
        }
      }

      await Promise.all(pool);

      // Complete upload
      updateProgress({ status: 'processing' });

      const { videoId } = await uploadApi.completeUpload(uploadId, metadata);

      updateProgress({
        status: 'complete',
        videoId,
        percentComplete: 100
      });

      return videoId;

    } catch (error) {
      if (error instanceof Error && error.message === 'Upload cancelled') {
        updateProgress({
          status: 'idle',
          error: 'Upload cancelled'
        });
      } else {
        updateProgress({
          status: 'error',
          error: error instanceof Error ? error.message : 'Upload failed'
        });
      }
      throw error;
    }
  }, [chunkSize, maxConcurrent, updateProgress]);

  const cancelUpload = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setProgress({
      status: 'idle',
      uploadedChunks: 0,
      totalChunks: 0,
      uploadedBytes: 0,
      totalBytes: 0,
      percentComplete: 0,
      speed: 0,
      timeRemaining: 0
    });
  }, []);

  return {
    progress,
    uploadFile,
    cancelUpload,
    reset
  };
}
```

### Upload Progress Component

```tsx
// components/upload/UploadProgress.tsx
interface UploadProgressProps {
  progress: UploadProgress;
  filename: string;
  onCancel: () => void;
}

export function UploadProgress({ progress, filename, onCancel }: UploadProgressProps) {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  };

  return (
    <div className="bg-yt-bg-secondary rounded-lg p-4">
      {/* File info */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 bg-yt-bg-primary rounded flex items-center justify-center">
          <VideoIcon className="w-6 h-6 text-yt-text-secondary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{filename}</p>
          <p className="text-sm text-yt-text-secondary">
            {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)}
          </p>
        </div>
        {progress.status === 'uploading' && (
          <button
            onClick={onCancel}
            className="p-2 hover:bg-yt-hover rounded-full"
          >
            <XIcon className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="relative h-1 bg-yt-border rounded-full overflow-hidden mb-2">
        <div
          className={cn(
            'absolute h-full transition-all duration-300',
            progress.status === 'error' ? 'bg-red-500' : 'bg-[#FF0000]'
          )}
          style={{ width: `${progress.percentComplete}%` }}
        />
        {progress.status === 'processing' && (
          <div className="absolute inset-0 bg-[#FF0000]/30 animate-pulse" />
        )}
      </div>

      {/* Status text */}
      <div className="flex justify-between text-sm text-yt-text-secondary">
        <span>
          {progress.status === 'initializing' && 'Preparing upload...'}
          {progress.status === 'uploading' && (
            <>
              {progress.percentComplete}% &middot;{' '}
              {formatBytes(progress.speed)}/s &middot;{' '}
              {formatTime(progress.timeRemaining)} remaining
            </>
          )}
          {progress.status === 'processing' && 'Processing video...'}
          {progress.status === 'complete' && 'Upload complete!'}
          {progress.status === 'error' && (
            <span className="text-red-500">{progress.error}</span>
          )}
        </span>
        <span>
          {progress.uploadedChunks} / {progress.totalChunks} chunks
        </span>
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: Engagement Components (6-8 minutes)

### Like/Dislike Bar

```tsx
// components/engagement/LikeDislikeBar.tsx
import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface LikeDislikeBarProps {
  videoId: string;
  initialLikes: number;
  initialDislikes: number;
  userReaction: 'like' | 'dislike' | null;
  onReact: (reaction: 'like' | 'dislike') => Promise<void>;
}

export function LikeDislikeBar({
  videoId,
  initialLikes,
  initialDislikes,
  userReaction: initialReaction,
  onReact
}: LikeDislikeBarProps) {
  const [likes, setLikes] = useState(initialLikes);
  const [dislikes, setDislikes] = useState(initialDislikes);
  const [userReaction, setUserReaction] = useState(initialReaction);
  const [isLoading, setIsLoading] = useState(false);

  const handleReaction = useCallback(async (reaction: 'like' | 'dislike') => {
    if (isLoading) return;

    // Optimistic update
    const previousReaction = userReaction;
    const previousLikes = likes;
    const previousDislikes = dislikes;

    // Calculate new state
    if (userReaction === reaction) {
      // Removing reaction
      setUserReaction(null);
      if (reaction === 'like') setLikes(l => l - 1);
      else setDislikes(d => d - 1);
    } else {
      // Adding or switching reaction
      setUserReaction(reaction);

      if (previousReaction === 'like') setLikes(l => l - 1);
      if (previousReaction === 'dislike') setDislikes(d => d - 1);

      if (reaction === 'like') setLikes(l => l + 1);
      else setDislikes(d => d + 1);
    }

    try {
      setIsLoading(true);
      await onReact(reaction);
    } catch (error) {
      // Rollback on error
      setUserReaction(previousReaction);
      setLikes(previousLikes);
      setDislikes(previousDislikes);
    } finally {
      setIsLoading(false);
    }
  }, [userReaction, likes, dislikes, isLoading, onReact]);

  const formatCount = (count: number): string => {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return count.toString();
  };

  return (
    <div className="flex items-center bg-yt-bg-secondary rounded-full overflow-hidden">
      {/* Like button */}
      <button
        onClick={() => handleReaction('like')}
        disabled={isLoading}
        className={cn(
          'flex items-center gap-2 px-4 py-2 hover:bg-yt-hover transition-colors',
          isLoading && 'opacity-50 cursor-not-allowed'
        )}
      >
        {userReaction === 'like' ? (
          <ThumbUpFilledIcon className="w-5 h-5 text-[#3EA6FF]" />
        ) : (
          <ThumbUpOutlineIcon className="w-5 h-5" />
        )}
        <span className={cn(
          'text-sm font-medium',
          userReaction === 'like' && 'text-[#3EA6FF]'
        )}>
          {formatCount(likes)}
        </span>
      </button>

      {/* Divider */}
      <div className="w-px h-6 bg-yt-border" />

      {/* Dislike button */}
      <button
        onClick={() => handleReaction('dislike')}
        disabled={isLoading}
        className={cn(
          'flex items-center px-4 py-2 hover:bg-yt-hover transition-colors',
          isLoading && 'opacity-50 cursor-not-allowed'
        )}
      >
        {userReaction === 'dislike' ? (
          <ThumbDownFilledIcon className="w-5 h-5" />
        ) : (
          <ThumbDownOutlineIcon className="w-5 h-5" />
        )}
      </button>
    </div>
  );
}
```

### Subscribe Button with Animation

```tsx
// components/engagement/SubscribeButton.tsx
import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface SubscribeButtonProps {
  channelId: string;
  channelName: string;
  isSubscribed: boolean;
  subscriberCount: number;
  onSubscribe: () => Promise<void>;
  onUnsubscribe: () => Promise<void>;
}

export function SubscribeButton({
  channelId,
  channelName,
  isSubscribed: initialSubscribed,
  subscriberCount: initialCount,
  onSubscribe,
  onUnsubscribe
}: SubscribeButtonProps) {
  const [isSubscribed, setIsSubscribed] = useState(initialSubscribed);
  const [subscriberCount, setSubscriberCount] = useState(initialCount);
  const [isLoading, setIsLoading] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);

  const handleClick = useCallback(async () => {
    if (isLoading) return;

    const wasSubscribed = isSubscribed;

    // Optimistic update
    setIsSubscribed(!wasSubscribed);
    setSubscriberCount(c => wasSubscribed ? c - 1 : c + 1);

    try {
      setIsLoading(true);

      if (wasSubscribed) {
        await onUnsubscribe();
      } else {
        await onSubscribe();
        // Trigger confetti animation
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 1000);
      }
    } catch (error) {
      // Rollback
      setIsSubscribed(wasSubscribed);
      setSubscriberCount(c => wasSubscribed ? c + 1 : c - 1);
    } finally {
      setIsLoading(false);
    }
  }, [isSubscribed, isLoading, onSubscribe, onUnsubscribe]);

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        disabled={isLoading}
        className={cn(
          'relative px-4 py-2 rounded-full font-medium text-sm transition-all duration-200',
          isSubscribed
            ? 'bg-[#909090] text-white hover:bg-[#717171]'
            : 'bg-[#CC0000] text-white hover:bg-[#AA0000]',
          isLoading && 'opacity-70 cursor-not-allowed',
          'group'
        )}
      >
        {/* Bell icon for subscribed state */}
        {isSubscribed && (
          <BellIcon className="w-4 h-4 inline mr-2" />
        )}

        <span className="relative">
          {isSubscribed ? (
            <>
              <span className="group-hover:hidden">Subscribed</span>
              <span className="hidden group-hover:inline">Unsubscribe</span>
            </>
          ) : (
            'Subscribe'
          )}
        </span>
      </button>

      {/* Confetti animation */}
      {showConfetti && (
        <div className="absolute inset-0 pointer-events-none">
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full animate-confetti"
              style={{
                left: '50%',
                top: '50%',
                backgroundColor: ['#FF0000', '#3EA6FF', '#FFFFFF', '#FFCC00'][i % 4],
                animationDelay: `${i * 50}ms`,
                '--angle': `${(i / 20) * 360}deg`,
                '--distance': `${50 + Math.random() * 30}px`
              } as React.CSSProperties}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Confetti animation in CSS
const confettiStyles = `
@keyframes confetti {
  0% {
    transform: translate(-50%, -50%) rotate(0deg);
    opacity: 1;
  }
  100% {
    transform:
      translate(
        calc(-50% + cos(var(--angle)) * var(--distance)),
        calc(-50% + sin(var(--angle)) * var(--distance) - 20px)
      )
      rotate(720deg);
    opacity: 0;
  }
}

.animate-confetti {
  animation: confetti 0.6s ease-out forwards;
}
`;
```

### Comment Section with Threading

```tsx
// components/engagement/CommentSection.tsx
import { useState, useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commentApi } from '@/services/commentApi';

interface CommentSectionProps {
  videoId: string;
  commentCount: number;
}

export function CommentSection({ videoId, commentCount }: CommentSectionProps) {
  const [sortBy, setSortBy] = useState<'newest' | 'top'>('top');
  const queryClient = useQueryClient();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery({
    queryKey: ['comments', videoId, sortBy],
    queryFn: ({ pageParam = 1 }) =>
      commentApi.getComments(videoId, { page: pageParam, sort: sortBy }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.page + 1 : undefined
  });

  const addCommentMutation = useMutation({
    mutationFn: (text: string) => commentApi.addComment(videoId, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', videoId] });
    }
  });

  const comments = data?.pages.flatMap(p => p.comments) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-6">
        <h3 className="text-lg font-medium">
          {commentCount.toLocaleString()} Comments
        </h3>
        <SortDropdown value={sortBy} onChange={setSortBy} />
      </div>

      {/* Add comment form */}
      <CommentForm
        onSubmit={(text) => addCommentMutation.mutateAsync(text)}
        isLoading={addCommentMutation.isPending}
      />

      {/* Comment list */}
      <div className="space-y-4">
        {comments.map((comment) => (
          <Comment
            key={comment.id}
            comment={comment}
            videoId={videoId}
          />
        ))}
      </div>

      {/* Load more */}
      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="text-[#3EA6FF] font-medium hover:opacity-80"
        >
          {isFetchingNextPage ? 'Loading...' : 'Show more comments'}
        </button>
      )}
    </div>
  );
}

// Individual comment component
function Comment({
  comment,
  videoId,
  depth = 0
}: {
  comment: CommentType;
  videoId: string;
  depth?: number;
}) {
  const [showReplies, setShowReplies] = useState(false);
  const [isReplying, setIsReplying] = useState(false);

  return (
    <div className={cn('flex gap-3', depth > 0 && 'ml-12')}>
      {/* Avatar */}
      <a href={`/channel/${comment.author.handle}`}>
        <img
          src={comment.author.avatarUrl}
          alt={comment.author.username}
          className="w-10 h-10 rounded-full"
        />
      </a>

      <div className="flex-1">
        {/* Author and timestamp */}
        <div className="flex items-center gap-2 mb-1">
          <a
            href={`/channel/${comment.author.handle}`}
            className="text-sm font-medium hover:underline"
          >
            @{comment.author.username}
          </a>
          <span className="text-xs text-yt-text-secondary">
            {formatRelativeTime(comment.createdAt)}
            {comment.isEdited && ' (edited)'}
          </span>
        </div>

        {/* Comment text */}
        <p className="text-sm whitespace-pre-wrap mb-2">
          {comment.text}
        </p>

        {/* Actions */}
        <div className="flex items-center gap-4 text-sm">
          <button className="flex items-center gap-1 hover:bg-yt-hover rounded-full p-1">
            <ThumbUpOutlineIcon className="w-4 h-4" />
            {comment.likeCount > 0 && (
              <span className="text-xs text-yt-text-secondary">
                {comment.likeCount}
              </span>
            )}
          </button>
          <button className="hover:bg-yt-hover rounded-full p-1">
            <ThumbDownOutlineIcon className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsReplying(true)}
            className="text-xs font-medium hover:bg-yt-hover px-2 py-1 rounded-full"
          >
            Reply
          </button>
        </div>

        {/* Reply form */}
        {isReplying && (
          <div className="mt-4">
            <CommentForm
              onSubmit={async (text) => {
                await commentApi.addReply(videoId, comment.id, text);
                setIsReplying(false);
                setShowReplies(true);
              }}
              onCancel={() => setIsReplying(false)}
              placeholder="Add a reply..."
              autoFocus
            />
          </div>
        )}

        {/* Replies */}
        {comment.replyCount > 0 && (
          <button
            onClick={() => setShowReplies(!showReplies)}
            className="flex items-center gap-2 text-[#3EA6FF] font-medium mt-2 text-sm"
          >
            <ChevronDownIcon
              className={cn('w-5 h-5 transition-transform', showReplies && 'rotate-180')}
            />
            {showReplies ? 'Hide' : `View ${comment.replyCount}`} replies
          </button>
        )}

        {showReplies && comment.replies?.map((reply) => (
          <div key={reply.id} className="mt-4">
            <Comment comment={reply} videoId={videoId} depth={depth + 1} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 6. YouTube Brand Identity Implementation (4-5 minutes)

### Theme Configuration

```tsx
// styles/theme.ts
export const youtubeTheme = {
  colors: {
    light: {
      '--yt-red': '#FF0000',
      '--yt-subscribe': '#CC0000',
      '--yt-bg-primary': '#FFFFFF',
      '--yt-bg-secondary': '#F9F9F9',
      '--yt-text-primary': '#0F0F0F',
      '--yt-text-secondary': '#606060',
      '--yt-like-active': '#065FD4',
      '--yt-subscribed': '#909090',
      '--yt-border': '#E5E5E5',
      '--yt-hover': '#F2F2F2'
    },
    dark: {
      '--yt-red': '#FF0000',
      '--yt-subscribe': '#CC0000',
      '--yt-bg-primary': '#0F0F0F',
      '--yt-bg-secondary': '#212121',
      '--yt-text-primary': '#FFFFFF',
      '--yt-text-secondary': '#AAAAAA',
      '--yt-like-active': '#3EA6FF',
      '--yt-subscribed': '#909090',
      '--yt-border': '#3F3F3F',
      '--yt-hover': '#3F3F3F'
    }
  },
  typography: {
    fontFamily: "'Roboto', Arial, sans-serif",
    sizes: {
      videoTitle: { card: '14px', watch: '18px' },
      channelName: '12px',
      metadata: '12px',
      comment: '14px',
      button: '14px'
    },
    weights: {
      regular: 400,
      medium: 500,
      semiBold: 600
    }
  },
  spacing: {
    grid: {
      gap: { horizontal: '16px', vertical: '24px' }
    },
    borderRadius: {
      thumbnail: '12px',
      button: '9999px', // pill
      card: '8px'
    }
  }
};
```

### Tailwind Configuration

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'yt-red': 'var(--yt-red)',
        'yt-subscribe': 'var(--yt-subscribe)',
        'yt-bg-primary': 'var(--yt-bg-primary)',
        'yt-bg-secondary': 'var(--yt-bg-secondary)',
        'yt-text-primary': 'var(--yt-text-primary)',
        'yt-text-secondary': 'var(--yt-text-secondary)',
        'yt-like-active': 'var(--yt-like-active)',
        'yt-subscribed': 'var(--yt-subscribed)',
        'yt-border': 'var(--yt-border)',
        'yt-hover': 'var(--yt-hover)'
      },
      fontFamily: {
        roboto: ['Roboto', 'Arial', 'sans-serif']
      }
    }
  }
};
```

### Video Card with YouTube Styling

```tsx
// components/video/VideoCard.tsx
interface VideoCardProps {
  video: Video;
  layout?: 'grid' | 'row';
}

export function VideoCard({ video, layout = 'grid' }: VideoCardProps) {
  const formatDuration = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatViews = (count: number): string => {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
    if (count >= 1_000) return `${Math.floor(count / 1_000)}K views`;
    return `${count} views`;
  };

  if (layout === 'row') {
    return (
      <a
        href={`/watch/${video.id}`}
        className="flex gap-2 group"
      >
        {/* Thumbnail */}
        <div className="relative flex-shrink-0 w-40 aspect-video rounded-lg overflow-hidden">
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
          <span className="absolute bottom-1 right-1 bg-black/80 text-white text-xs px-1 rounded">
            {formatDuration(video.durationSeconds)}
          </span>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium line-clamp-2 group-hover:text-yt-like-active">
            {video.title}
          </h3>
          <p className="text-xs text-yt-text-secondary mt-1">
            {video.channel.name}
          </p>
          <p className="text-xs text-yt-text-secondary">
            {formatViews(video.viewCount)} &middot; {formatRelativeTime(video.publishedAt)}
          </p>
        </div>
      </a>
    );
  }

  return (
    <a
      href={`/watch/${video.id}`}
      className="group block"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video rounded-xl overflow-hidden mb-3">
        <img
          src={video.thumbnailUrl}
          alt={video.title}
          className="w-full h-full object-cover"
          loading="lazy"
        />

        {/* Duration badge */}
        <span className="absolute bottom-2 right-2 bg-black/80 text-white text-xs
                         font-medium px-1.5 py-0.5 rounded">
          {formatDuration(video.durationSeconds)}
        </span>

        {/* Progress bar for partially watched */}
        {video.watchProgress > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
            <div
              className="h-full bg-[#FF0000]"
              style={{ width: `${video.watchProgress}%` }}
            />
          </div>
        )}
      </div>

      {/* Video info */}
      <div className="flex gap-3">
        {/* Channel avatar */}
        <a
          href={`/channel/${video.channel.handle}`}
          onClick={(e) => e.stopPropagation()}
          className="flex-shrink-0"
        >
          <img
            src={video.channel.avatarUrl}
            alt={video.channel.name}
            className="w-9 h-9 rounded-full"
          />
        </a>

        {/* Text info */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium leading-5 line-clamp-2 mb-1
                         group-hover:text-yt-like-active transition-colors">
            {video.title}
          </h3>
          <a
            href={`/channel/${video.channel.handle}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-yt-text-secondary hover:text-yt-text-primary"
          >
            {video.channel.name}
          </a>
          <p className="text-xs text-yt-text-secondary">
            {formatViews(video.viewCount)} &middot; {formatRelativeTime(video.publishedAt)}
          </p>
        </div>
      </div>
    </a>
  );
}
```

---

## 7. Responsive Layout and Virtualized Grid (4-5 minutes)

### Virtualized Video Grid

```tsx
// components/video/VideoGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useMemo } from 'react';
import { useWindowSize } from '@/hooks/useWindowSize';
import { VideoCard } from './VideoCard';
import { VideoCardSkeleton } from './VideoCardSkeleton';

interface VideoGridProps {
  videos: Video[];
  isLoading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

export function VideoGrid({
  videos,
  isLoading,
  hasMore,
  onLoadMore
}: VideoGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width } = useWindowSize();

  // Calculate columns based on viewport width
  const columns = useMemo(() => {
    if (width < 500) return 1;
    if (width < 900) return 2;
    if (width < 1200) return 3;
    if (width < 1600) return 4;
    return 5;
  }, [width]);

  // Group videos into rows
  const rows = useMemo(() => {
    const result: Video[][] = [];
    for (let i = 0; i < videos.length; i += columns) {
      result.push(videos.slice(i, i + columns));
    }
    // Add loading row if needed
    if (isLoading && hasMore) {
      result.push([]); // Empty row triggers skeleton
    }
    return result;
  }, [videos, columns, isLoading, hasMore]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 300, // Estimated row height
    overscan: 3
  });

  // Load more when near bottom
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;

    if (
      lastItem.index >= rows.length - 2 &&
      hasMore &&
      !isLoading &&
      onLoadMore
    ) {
      onLoadMore();
    }
  }, [virtualizer.getVirtualItems(), hasMore, isLoading, onLoadMore, rows.length]);

  return (
    <div
      ref={containerRef}
      className="h-screen overflow-auto"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          const isLoadingRow = row.length === 0 && isLoading;

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <div
                className="grid gap-x-4 gap-y-6 px-6"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
                }}
              >
                {isLoadingRow
                  ? Array.from({ length: columns }).map((_, i) => (
                      <VideoCardSkeleton key={i} />
                    ))
                  : row.map((video) => (
                      <VideoCard key={video.id} video={video} />
                    ))
                }
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Responsive Sidebar

```tsx
// components/layout/Sidebar.tsx
import { cn } from '@/lib/utils';
import { useUIStore } from '@/store/uiStore';
import { useWindowSize } from '@/hooks/useWindowSize';

export function Sidebar() {
  const { width } = useWindowSize();
  const { sidebarExpanded, setSidebarExpanded } = useUIStore();

  // Auto-collapse on smaller screens
  const isCollapsible = width < 1200;
  const isExpanded = !isCollapsible || sidebarExpanded;

  const navItems = [
    { icon: HomeIcon, label: 'Home', path: '/' },
    { icon: ShortsIcon, label: 'Shorts', path: '/shorts' },
    { icon: SubscriptionsIcon, label: 'Subscriptions', path: '/subscriptions' },
    { divider: true },
    { icon: LibraryIcon, label: 'Library', path: '/library' },
    { icon: HistoryIcon, label: 'History', path: '/history' }
  ];

  if (width < 500) {
    // Mobile: bottom navigation instead
    return null;
  }

  return (
    <aside
      className={cn(
        'fixed left-0 top-14 h-[calc(100vh-56px)] bg-yt-bg-primary',
        'flex flex-col overflow-y-auto overflow-x-hidden',
        'transition-all duration-200',
        isExpanded ? 'w-60' : 'w-[72px]'
      )}
    >
      <nav className="flex-1 py-3">
        {navItems.map((item, index) => {
          if (item.divider) {
            return (
              <hr key={index} className="my-3 border-yt-border mx-3" />
            );
          }

          const Icon = item.icon;
          const isActive = location.pathname === item.path;

          return (
            <a
              key={item.path}
              href={item.path}
              className={cn(
                'flex items-center gap-5 mx-2.5 rounded-lg',
                'transition-colors',
                isExpanded
                  ? 'px-3 py-2 hover:bg-yt-hover'
                  : 'flex-col px-2 py-4 hover:bg-yt-hover text-center',
                isActive && 'bg-yt-hover font-medium'
              )}
            >
              <Icon
                className={cn(
                  'flex-shrink-0',
                  isExpanded ? 'w-6 h-6' : 'w-6 h-6'
                )}
                filled={isActive}
              />
              <span
                className={cn(
                  'whitespace-nowrap',
                  isExpanded ? 'text-sm' : 'text-[10px] mt-1'
                )}
              >
                {item.label}
              </span>
            </a>
          );
        })}

        {/* Subscriptions section */}
        {isExpanded && (
          <>
            <hr className="my-3 border-yt-border mx-3" />
            <div className="px-3">
              <h3 className="text-sm font-medium mb-2 px-3">Subscriptions</h3>
              <SubscriptionsList />
            </div>
          </>
        )}
      </nav>
    </aside>
  );
}
```

---

## 8. Trade-offs and Alternatives (3-4 minutes)

### Video Player Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| HLS.js | Lightweight, well-maintained | Manual controls needed | **Chosen** |
| Video.js | Full-featured, plugins | Heavy bundle size | Good alternative |
| Shaka Player | DASH + DRM support | More complex | For premium content |

### Upload Strategy

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Single POST | Simple | Size limits, no resume | Never for video |
| tus.io protocol | Standard, resumable | Extra dependency | Good for production |
| Custom chunked | Full control, simple | Custom implementation | **Chosen** for learning |

### State Management

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Zustand | Lightweight, simple | Less structure | **Chosen** for UI state |
| React Query | Server state sync | Not for UI state | **Chosen** for API data |
| Redux | Predictable, devtools | Boilerplate | Overkill for this size |

### List Virtualization

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| @tanstack/react-virtual | Lightweight, flexible | Manual measurement | **Chosen** |
| react-window | Simple API | Less flexible | Good alternative |
| react-virtuoso | Auto-measure | Larger bundle | For complex lists |

---

## 9. Summary

The YouTube frontend architecture focuses on:

1. **HLS Video Player**: Custom player wrapper around HLS.js with adaptive bitrate selection, keyboard shortcuts, and quality controls matching YouTube's UX

2. **Chunked Upload with Progress**: Resumable uploads using parallel chunk processing with real-time speed calculation and time-remaining estimates

3. **Optimistic Engagement UI**: Like/dislike bar and subscribe button with immediate visual feedback and error rollback

4. **YouTube Brand Fidelity**: CSS variables for light/dark themes matching exact YouTube colors, Roboto typography, and component styling (red progress bar, blue like active state, pill-shaped buttons)

5. **Virtualized Video Grid**: Responsive grid layout (1-5 columns) using TanStack Virtual for efficient rendering of large video feeds

6. **Threaded Comments**: Recursive comment component supporting replies, likes, and pagination with infinite scroll

The frontend provides a YouTube-faithful experience while maintaining performance through virtualization, optimistic updates, and efficient HLS streaming with automatic quality adaptation.
