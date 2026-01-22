# Design Netflix - Frontend-Focused System Design Answer

## 45-Minute Interview Format - Frontend/UI Engineering Focus

---

## Introduction (2 minutes)

"Thanks for having me. I'll design Netflix's frontend architecture, focusing on building a rich video streaming experience with adaptive quality, personalized browsing, and responsive playback controls.

The frontend challenges include:
1. **Video player architecture** with adaptive bitrate streaming and keyboard controls
2. **Component composition** for complex UI patterns like carousels and hover previews
3. **State management** across authentication, browsing, and playback domains
4. **Performance optimization** for smooth scrolling and instant playback start

Let me walk through the key frontend systems."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"From a frontend perspective:

1. **Video Player**: Full-screen playback with quality selection, progress tracking, and keyboard shortcuts
2. **Browse Experience**: Personalized homepage with horizontally scrolling content rows
3. **Content Cards**: Hover previews, progress indicators, and quick actions
4. **Profile Management**: Profile selection and switching
5. **Continue Watching**: Resume playback with visual progress indicators"

### Non-Functional Requirements

"For the user experience:

- **Playback Start**: Under 2 seconds from click to video appearing
- **Smooth Scrolling**: 60fps for horizontal row scrolling
- **Responsive Design**: TV, desktop, tablet, and mobile layouts
- **Accessibility**: Full keyboard navigation, screen reader support"

---

## High-Level Frontend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Application                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ TanStack    │  │ Zustand     │  │ API         │             │
│  │ Router      │  │ Stores      │  │ Services    │             │
│  │             │  │             │  │             │             │
│  │ /           │  │ authStore   │  │ streaming   │             │
│  │ /browse     │  │ browseStore │  │ browse      │             │
│  │ /watch/:id  │  │ playerStore │  │ profiles    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Components                             │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐  │  │
│  │  │ Navbar   │  │ Hero     │  │ VideoPlayer            │  │  │
│  │  │          │  │ Banner   │  │  ├── TopBar            │  │  │
│  │  └──────────┘  └──────────┘  │  ├── CenterPlayButton  │  │  │
│  │                              │  ├── ProgressBar       │  │  │
│  │  ┌──────────┐  ┌──────────┐  │  ├── VolumeControl     │  │  │
│  │  │ VideoRow │  │ VideoCard│  │  ├── QualitySelector   │  │  │
│  │  │          │  │          │  │  └── ControlBar        │  │  │
│  │  └──────────┘  └──────────┘  └────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: VideoPlayer Component Architecture (12 minutes)

### Component Decomposition

"The VideoPlayer is our most complex component, split into focused sub-components:

```typescript
// Directory structure
VideoPlayer/
├── index.ts              // Barrel exports
├── VideoPlayer.tsx       // Main orchestrator (~200 lines)
├── TopBar.tsx           // Title and back navigation (~45 lines)
├── CenterPlayButton.tsx // Large play/pause overlay (~40 lines)
├── ProgressBar.tsx      // Seek slider with time display (~60 lines)
├── VolumeControl.tsx    // Volume slider and mute toggle (~75 lines)
├── QualitySelector.tsx  // Quality selection dropdown (~85 lines)
├── ControlBar.tsx       // Bottom controls container (~130 lines)
├── useVideoPlayerControls.ts // Keyboard and control logic (~175 lines)
└── utils.ts             // Time formatting utilities (~25 lines)

// Main VideoPlayer component
interface VideoPlayerProps {
  videoId: string;
  episodeId?: string;
  title: string;
  startPosition?: number;
}

export function VideoPlayer({
  videoId,
  episodeId,
  title,
  startPosition = 0
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    isPlaying,
    currentTime,
    duration,
    volume,
    quality,
    isFullscreen,
    showControls,
    // Actions
    play,
    pause,
    seek,
    setVolume,
    setQuality,
    toggleFullscreen,
  } = useVideoPlayerControls(videoRef, containerRef);

  const { manifest, loadManifest } = usePlayerStore();

  useEffect(() => {
    loadManifest(videoId, episodeId);
  }, [videoId, episodeId]);

  useEffect(() => {
    if (videoRef.current && startPosition > 0) {
      videoRef.current.currentTime = startPosition;
    }
  }, [startPosition, manifest]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={handleMouseMove}
    >
      <video
        ref={videoRef}
        src={manifest?.sources[quality]?.url}
        className="w-full h-full object-contain"
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
      />

      <TopBar
        title={title}
        visible={showControls}
        onBack={handleBack}
      />

      <CenterPlayButton
        isPlaying={isPlaying}
        visible={showControls && !isPlaying}
        onClick={isPlaying ? pause : play}
      />

      <ControlBar visible={showControls}>
        <ProgressBar
          currentTime={currentTime}
          duration={duration}
          onSeek={seek}
        />
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-4">
            <PlayPauseButton isPlaying={isPlaying} onClick={toggle} />
            <VolumeControl volume={volume} onVolumeChange={setVolume} />
            <TimeDisplay current={currentTime} total={duration} />
          </div>
          <div className="flex items-center gap-4">
            <QualitySelector
              qualities={manifest?.sources || []}
              current={quality}
              onChange={setQuality}
            />
            <FullscreenButton
              isFullscreen={isFullscreen}
              onClick={toggleFullscreen}
            />
          </div>
        </div>
      </ControlBar>
    </div>
  );
}
```"

### Keyboard Controls Hook

"The useVideoPlayerControls hook handles all keyboard interactions:

```typescript
// useVideoPlayerControls.ts
export function useVideoPlayerControls(
  videoRef: RefObject<HTMLVideoElement>,
  containerRef: RefObject<HTMLDivElement>
) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const hideControlsTimeout = useRef<NodeJS.Timeout>();

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          break;

        case 'ArrowLeft':
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;

        case 'ArrowRight':
          e.preventDefault();
          video.currentTime = Math.min(video.duration, video.currentTime + 10);
          break;

        case 'ArrowUp':
          e.preventDefault();
          setVolume(Math.min(1, volume + 0.1));
          break;

        case 'ArrowDown':
          e.preventDefault();
          setVolume(Math.max(0, volume - 0.1));
          break;

        case 'm':
        case 'M':
          toggleMute();
          break;

        case 'f':
        case 'F':
          toggleFullscreen();
          break;

        case 'Escape':
          if (isFullscreen) {
            document.exitFullscreen();
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [volume, isFullscreen]);

  // Auto-hide controls
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimeout.current) {
      clearTimeout(hideControlsTimeout.current);
    }
    hideControlsTimeout.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  }, [isPlaying]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      setIsFullscreen(false);
    } else {
      await container.requestFullscreen();
      setIsFullscreen(true);
    }
  }, []);

  return {
    isPlaying,
    currentTime,
    duration,
    volume,
    isMuted,
    isFullscreen,
    showControls,
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
    seek: (time: number) => {
      if (videoRef.current) videoRef.current.currentTime = time;
    },
    setVolume: (v: number) => {
      if (videoRef.current) videoRef.current.volume = v;
      setVolumeState(v);
    },
    toggleMute,
    toggleFullscreen,
    resetControlsTimeout,
  };
}
```"

### Progress Bar with Preview Thumbnails

"The progress bar shows position, duration, and preview thumbnails on hover:

```typescript
// ProgressBar.tsx
interface ProgressBarProps {
  currentTime: number;
  duration: number;
  buffered: TimeRanges | null;
  thumbnails?: ThumbnailSprite;
  onSeek: (time: number) => void;
}

export function ProgressBar({
  currentTime,
  duration,
  buffered,
  thumbnails,
  onSeek,
}: ProgressBarProps) {
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number>(0);
  const barRef = useRef<HTMLDivElement>(null);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleMouseMove = (e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar) return;

    const rect = bar.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const time = percent * duration;

    setHoverPosition(x);
    setHoverTime(time);
  };

  const handleClick = (e: React.MouseEvent) => {
    const bar = barRef.current;
    if (!bar) return;

    const rect = bar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    onSeek(percent * duration);
  };

  return (
    <div className="relative px-4 py-2">
      {/* Thumbnail preview on hover */}
      {hoverPosition !== null && thumbnails && (
        <ThumbnailPreview
          thumbnails={thumbnails}
          time={hoverTime}
          position={hoverPosition}
        />
      )}

      <div
        ref={barRef}
        className="relative h-1 bg-gray-600 cursor-pointer group"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverPosition(null)}
        onClick={handleClick}
      >
        {/* Buffered range */}
        <BufferedRanges
          buffered={buffered}
          duration={duration}
        />

        {/* Progress */}
        <div
          className="absolute h-full bg-red-600"
          style={{ width: `${progress}%` }}
        />

        {/* Scrubber handle */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4
                     bg-red-600 rounded-full opacity-0 group-hover:opacity-100
                     transition-opacity"
          style={{ left: `calc(${progress}% - 8px)` }}
        />
      </div>

      {/* Time display on hover */}
      {hoverPosition !== null && (
        <div
          className="absolute bottom-full mb-2 px-2 py-1 bg-black/80
                     text-white text-sm rounded transform -translate-x-1/2"
          style={{ left: hoverPosition }}
        >
          {formatTime(hoverTime)}
        </div>
      )}
    </div>
  );
}
```"

---

## Deep Dive: Browse Experience Components (10 minutes)

### HeroBanner Component

"The hero banner features the spotlight content with auto-play preview:

```typescript
// HeroBanner.tsx
interface HeroBannerProps {
  video: Video;
  onPlay: (videoId: string) => void;
  onInfo: (videoId: string) => void;
}

export function HeroBanner({ video, onPlay, onInfo }: HeroBannerProps) {
  const [showVideo, setShowVideo] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  // Auto-play preview after 5 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowVideo(true);
    }, 5000);

    return () => clearTimeout(timer);
  }, [video.id]);

  return (
    <div className="relative h-[80vh] overflow-hidden">
      {/* Background image or video */}
      <div className="absolute inset-0">
        {showVideo && video.previewUrl ? (
          <video
            ref={previewVideoRef}
            src={video.previewUrl}
            autoPlay
            muted={isMuted}
            loop
            className="w-full h-full object-cover"
          />
        ) : (
          <img
            src={video.backdropUrl}
            alt={video.title}
            className="w-full h-full object-cover"
          />
        )}

        {/* Gradient overlays */}
        <div className="absolute inset-0 bg-gradient-to-t
                        from-black via-transparent to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r
                        from-black/80 via-transparent to-transparent" />
      </div>

      {/* Content */}
      <div className="absolute bottom-1/4 left-12 max-w-xl">
        <h1 className="text-5xl font-bold text-white mb-4">
          {video.title}
        </h1>
        <p className="text-lg text-gray-200 mb-6 line-clamp-3">
          {video.description}
        </p>

        <div className="flex gap-4">
          <button
            onClick={() => onPlay(video.id)}
            className="flex items-center gap-2 px-8 py-3 bg-white
                       text-black font-semibold rounded hover:bg-gray-200"
          >
            <PlayIcon className="w-6 h-6" />
            Play
          </button>
          <button
            onClick={() => onInfo(video.id)}
            className="flex items-center gap-2 px-8 py-3
                       bg-gray-500/70 text-white font-semibold rounded
                       hover:bg-gray-500/90"
          >
            <InfoIcon className="w-6 h-6" />
            More Info
          </button>
        </div>
      </div>

      {/* Mute toggle for preview video */}
      {showVideo && (
        <button
          onClick={() => setIsMuted(!isMuted)}
          className="absolute bottom-8 right-12 p-2
                     border border-white/50 rounded-full"
        >
          {isMuted ? <VolumeOffIcon /> : <VolumeOnIcon />}
        </button>
      )}
    </div>
  );
}
```"

### VideoRow with Horizontal Scrolling

"Content rows with smooth horizontal scrolling and navigation arrows:

```typescript
// VideoRow.tsx
interface VideoRowProps {
  title: string;
  videos: Video[];
  onVideoSelect: (video: Video) => void;
}

export function VideoRow({ title, videos, onVideoSelect }: VideoRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(true);

  const cardWidth = 240; // Width of each VideoCard
  const scrollAmount = cardWidth * 4; // Scroll 4 cards at a time

  const handleScroll = () => {
    const row = rowRef.current;
    if (!row) return;

    setShowLeftArrow(row.scrollLeft > 0);
    setShowRightArrow(
      row.scrollLeft < row.scrollWidth - row.clientWidth - 10
    );
  };

  const scroll = (direction: 'left' | 'right') => {
    const row = rowRef.current;
    if (!row) return;

    const delta = direction === 'left' ? -scrollAmount : scrollAmount;
    row.scrollBy({ left: delta, behavior: 'smooth' });
  };

  return (
    <div className="relative group py-6">
      <h2 className="text-xl font-semibold text-white mb-4 px-12">
        {title}
      </h2>

      {/* Left arrow */}
      {showLeftArrow && (
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 z-10 h-full w-12
                     bg-black/50 text-white opacity-0 group-hover:opacity-100
                     transition-opacity flex items-center justify-center"
        >
          <ChevronLeftIcon className="w-8 h-8" />
        </button>
      )}

      {/* Scrollable row */}
      <div
        ref={rowRef}
        onScroll={handleScroll}
        className="flex gap-2 overflow-x-auto scrollbar-hide px-12
                   scroll-smooth"
      >
        {videos.map((video, index) => (
          <VideoCard
            key={video.id}
            video={video}
            index={index}
            onClick={() => onVideoSelect(video)}
          />
        ))}
      </div>

      {/* Right arrow */}
      {showRightArrow && (
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 z-10 h-full w-12
                     bg-black/50 text-white opacity-0 group-hover:opacity-100
                     transition-opacity flex items-center justify-center"
        >
          <ChevronRightIcon className="w-8 h-8" />
        </button>
      )}
    </div>
  );
}
```"

### VideoCard with Hover Preview

"Cards that expand on hover with additional information:

```typescript
// VideoCard.tsx
interface VideoCardProps {
  video: Video;
  index: number;
  onClick: () => void;
  progress?: number; // 0-100 for Continue Watching
}

export function VideoCard({ video, index, onClick, progress }: VideoCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const hoverTimeout = useRef<NodeJS.Timeout>();

  const handleMouseEnter = () => {
    setIsHovered(true);
    // Delay video preview to avoid unnecessary loads
    hoverTimeout.current = setTimeout(() => {
      setShowPreview(true);
    }, 500);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setShowPreview(false);
    if (hoverTimeout.current) {
      clearTimeout(hoverTimeout.current);
    }
  };

  // Calculate transform origin based on position in row
  const getTransformOrigin = () => {
    if (index === 0) return 'left center';
    if (index >= 5) return 'right center';
    return 'center center';
  };

  return (
    <div
      className={`relative flex-shrink-0 w-60 transition-transform duration-300
                  ${isHovered ? 'z-20 scale-125' : 'z-10'}`}
      style={{ transformOrigin: getTransformOrigin() }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {/* Thumbnail / Preview */}
      <div className="relative aspect-video rounded overflow-hidden">
        {showPreview && video.previewUrl ? (
          <video
            src={video.previewUrl}
            autoPlay
            muted
            loop
            className="w-full h-full object-cover"
          />
        ) : (
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            className="w-full h-full object-cover"
          />
        )}

        {/* Progress bar for Continue Watching */}
        {progress !== undefined && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-600">
            <div
              className="h-full bg-red-600"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Expanded info on hover */}
      {isHovered && (
        <div className="absolute top-full left-0 right-0 bg-zinc-800
                        rounded-b p-4 shadow-lg">
          <div className="flex gap-2 mb-2">
            <button className="p-2 bg-white rounded-full">
              <PlayIcon className="w-4 h-4 text-black" />
            </button>
            <button className="p-2 border border-gray-400 rounded-full">
              <PlusIcon className="w-4 h-4 text-white" />
            </button>
            <button className="p-2 border border-gray-400 rounded-full">
              <ThumbUpIcon className="w-4 h-4 text-white" />
            </button>
            <button className="ml-auto p-2 border border-gray-400 rounded-full">
              <ChevronDownIcon className="w-4 h-4 text-white" />
            </button>
          </div>

          <div className="text-white text-sm">
            <span className="text-green-400 font-semibold">98% Match</span>
            <span className="mx-2 border border-gray-400 px-1">{video.rating}</span>
            <span>{video.duration}</span>
          </div>

          <div className="flex flex-wrap gap-1 mt-2 text-xs text-gray-400">
            {video.genres.slice(0, 3).map((genre, i) => (
              <span key={genre}>
                {genre}{i < 2 && ' • '}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```"

---

## Deep Dive: State Management (8 minutes)

### Zustand Store Architecture

"We organize state into domain-specific stores:

```typescript
// stores/authStore.ts
interface AuthState {
  isAuthenticated: boolean;
  account: Account | null;
  profiles: Profile[];
  activeProfile: Profile | null;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfiles: () => Promise<void>;
  selectProfile: (profileId: string) => Promise<void>;
  createProfile: (name: string, isKids: boolean) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  account: null,
  profiles: [],
  activeProfile: null,

  login: async (email, password) => {
    const response = await api.post('/auth/login', { email, password });
    set({
      isAuthenticated: true,
      account: response.data.account
    });
    // Fetch profiles after login
    await get().fetchProfiles();
  },

  logout: async () => {
    await api.post('/auth/logout');
    set({
      isAuthenticated: false,
      account: null,
      profiles: [],
      activeProfile: null
    });
  },

  selectProfile: async (profileId) => {
    const response = await api.post('/profiles/select', { profileId });
    const profile = get().profiles.find(p => p.id === profileId);
    set({ activeProfile: profile });
  },
}));

// stores/browseStore.ts
interface BrowseState {
  rows: ContentRow[];
  myList: Video[];
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchHomepage: () => Promise<void>;
  addToMyList: (videoId: string) => Promise<void>;
  removeFromMyList: (videoId: string) => Promise<void>;
  searchVideos: (query: string) => Promise<Video[]>;
}

export const useBrowseStore = create<BrowseState>((set) => ({
  rows: [],
  myList: [],
  isLoading: false,
  error: null,

  fetchHomepage: async () => {
    set({ isLoading: true, error: null });
    try {
      const [homepageRes, myListRes] = await Promise.all([
        api.get('/browse/homepage'),
        api.get('/browse/my-list'),
      ]);
      set({
        rows: homepageRes.data.rows,
        myList: myListRes.data.items,
        isLoading: false
      });
    } catch (error) {
      set({ error: 'Failed to load content', isLoading: false });
    }
  },

  addToMyList: async (videoId) => {
    await api.post(`/browse/my-list/${videoId}`);
    const video = await api.get(`/videos/${videoId}`);
    set((state) => ({
      myList: [video.data, ...state.myList]
    }));
  },
}));

// stores/playerStore.ts
interface PlayerState {
  manifest: StreamingManifest | null;
  currentQuality: string;
  isLoading: boolean;
  error: string | null;

  // Progress tracking
  lastPosition: number;
  progressSaveTimeout: NodeJS.Timeout | null;

  // Actions
  loadManifest: (videoId: string, episodeId?: string) => Promise<void>;
  setQuality: (quality: string) => void;
  saveProgress: (videoId: string, position: number, duration: number) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  manifest: null,
  currentQuality: 'auto',
  isLoading: false,
  error: null,
  lastPosition: 0,
  progressSaveTimeout: null,

  loadManifest: async (videoId, episodeId) => {
    set({ isLoading: true, error: null });
    try {
      const url = episodeId
        ? `/stream/${videoId}/episodes/${episodeId}/manifest`
        : `/stream/${videoId}/manifest`;
      const response = await api.get(url);

      set({
        manifest: response.data,
        isLoading: false,
        // Default to highest available quality
        currentQuality: response.data.sources[0]?.quality || 'auto'
      });
    } catch (error) {
      set({ error: 'Failed to load video', isLoading: false });
    }
  },

  saveProgress: (videoId, position, duration) => {
    const state = get();

    // Debounce progress saves to every 10 seconds
    if (state.progressSaveTimeout) {
      clearTimeout(state.progressSaveTimeout);
    }

    if (Math.abs(position - state.lastPosition) >= 10) {
      const timeout = setTimeout(async () => {
        await api.post('/stream/progress', { videoId, position, duration });
        set({ lastPosition: position });
      }, 1000);

      set({ progressSaveTimeout: timeout });
    }
  },
}));
```"

### Cross-Store Communication

"Stores can reference each other when needed:

```typescript
// In browseStore, access auth state for personalization
fetchHomepage: async () => {
  const { activeProfile } = useAuthStore.getState();
  if (!activeProfile) {
    throw new Error('No profile selected');
  }

  // Maturity filtering is handled server-side based on profile
  const response = await api.get('/browse/homepage');
  set({ rows: response.data.rows });
}
```"

---

## Accessibility and Performance (5 minutes)

### Keyboard Navigation

"Full keyboard support for the video player and browsing:

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| Arrow Left | Skip back 10 seconds |
| Arrow Right | Skip forward 10 seconds |
| Arrow Up | Increase volume |
| Arrow Down | Decrease volume |
| M | Toggle mute |
| F | Toggle fullscreen |
| Escape | Exit fullscreen or navigate back |

Tab navigation for browsing:

```typescript
// Focus management for video cards
function VideoRow({ videos }) {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
        focusCard(index + 1);
        break;
      case 'ArrowLeft':
        focusCard(index - 1);
        break;
      case 'Enter':
        selectVideo(videos[index]);
        break;
    }
  };

  return (
    <div role=\"list\" aria-label=\"Video row\">
      {videos.map((video, i) => (
        <div
          key={video.id}
          role=\"listitem\"
          tabIndex={0}
          onKeyDown={(e) => handleKeyDown(e, i)}
          aria-label={`${video.title}, ${video.rating}, ${video.duration}`}
        >
          <VideoCard video={video} />
        </div>
      ))}
    </div>
  );
}
```"

### Performance Optimizations

"Key optimizations for smooth UX:

```typescript
// 1. Lazy load video previews
const [loadPreview, setLoadPreview] = useState(false);
useEffect(() => {
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        setLoadPreview(true);
        observer.disconnect();
      }
    },
    { rootMargin: '100px' }
  );
  observer.observe(cardRef.current);
  return () => observer.disconnect();
}, []);

// 2. Virtualize long lists (e.g., search results)
import { useVirtualizer } from '@tanstack/react-virtual';

function SearchResults({ results }) {
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className=\"h-screen overflow-auto\">
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <VideoCard
            key={results[virtualRow.index].id}
            video={results[virtualRow.index]}
            style={{
              transform: `translateY(${virtualRow.start}px)`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// 3. Preload next episode
useEffect(() => {
  if (currentTime > duration * 0.9 && nextEpisode) {
    // Preload next episode manifest
    api.get(`/stream/${nextEpisode.id}/manifest`);
  }
}, [currentTime, duration, nextEpisode]);
```"

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux Toolkit | Simpler API, less boilerplate |
| Routing | TanStack Router | React Router | Type-safe routes with search params |
| Video Player | Custom | Video.js/Plyr | Full control over UX and ABR |
| Component Split | Sub-components | Single large file | Testability, maintainability |
| Styling | Tailwind CSS | CSS Modules | Rapid development, consistency |

---

## Summary

"I've designed Netflix's frontend with:

1. **Modular VideoPlayer** with keyboard shortcuts and sub-components under 150 lines each
2. **HeroBanner** with auto-playing preview and gradient overlays
3. **VideoRow** with smooth horizontal scrolling and lazy-loaded previews
4. **VideoCard** with hover expansion and progress indicators
5. **Zustand stores** organized by domain (auth, browse, player)
6. **Full accessibility** with keyboard navigation and ARIA labels
7. **Performance optimizations** including virtualization and lazy loading

The architecture prioritizes user experience with fast playback start, smooth interactions, and responsive controls.

What aspect would you like me to elaborate on?"
