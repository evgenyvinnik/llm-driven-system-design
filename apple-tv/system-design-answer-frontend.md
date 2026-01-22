# Apple TV+ - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend application for a premium video streaming service that:
- Provides a cinematic browsing experience across devices
- Delivers smooth video playback with adaptive quality
- Supports cross-device watch progress synchronization
- Offers profile management and personalized recommendations

## Requirements Clarification

### Functional Requirements
1. **Browse**: Discover content through hero banners, rows, and search
2. **Watch**: Full-screen video player with controls and quality selection
3. **Continue**: Resume playback across devices with synced progress
4. **Profiles**: Family sharing with individual profiles
5. **Downloads**: Save content for offline viewing

### Non-Functional Requirements
1. **Performance**: < 2s time to interactive on initial load
2. **Responsiveness**: Support iPhone, iPad, Apple TV, Mac, and web
3. **Accessibility**: VoiceOver support, keyboard navigation, captions
4. **Offline**: Graceful degradation with cached content

### Key User Flows
- Browse home page with featured content
- Select and watch content with adaptive streaming
- Manage watch history and continue watching
- Switch between family member profiles

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        React Application                         │
├─────────────────────────────────────────────────────────────────┤
│  Routes (Tanstack Router)                                        │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │  Home   │ │ Content │ │  Watch  │ │ Profile │ │  Admin  │   │
│  │    /    │ │/:id     │ │/:id     │ │/profiles│ │ /admin  │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  Components                                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │   Layout     │ │   Content    │ │    Player    │             │
│  │  - Header    │ │  - HeroBanner│ │  - Controls  │             │
│  │  - Sidebar   │ │  - ContentRow│ │  - ProgressBar│            │
│  │  - Footer    │ │  - ContentCard││  - Quality   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├─────────────────────────────────────────────────────────────────┤
│  State (Zustand)                                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │  authStore   │ │ contentStore │ │ playerStore  │             │
│  │  - user      │ │  - catalog   │ │  - isPlaying │             │
│  │  - profile   │ │  - continue  │ │  - position  │             │
│  │  - session   │ │  - watchlist │ │  - quality   │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
├─────────────────────────────────────────────────────────────────┤
│  Services                                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │   API Client │ │  HLS Player  │ │  Progress    │             │
│  │   (fetch)    │ │  (hls.js)    │ │  Sync        │             │
│  └──────────────┘ └──────────────┘ └──────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Zustand State Management

### Auth Store

```typescript
interface Profile {
    id: string;
    name: string;
    avatarUrl: string;
    isKids: boolean;
}

interface AuthState {
    user: User | null;
    profile: Profile | null;
    profiles: Profile[];
    isAuthenticated: boolean;

    // Actions
    login: (username: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    selectProfile: (profileId: string) => void;
    fetchProfiles: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set, get) => ({
            user: null,
            profile: null,
            profiles: [],
            isAuthenticated: false,

            login: async (username, password) => {
                const response = await api.post('/auth/login', {
                    username,
                    password
                });

                set({
                    user: response.user,
                    isAuthenticated: true
                });

                // Fetch profiles after login
                await get().fetchProfiles();
            },

            logout: async () => {
                await api.post('/auth/logout');
                set({
                    user: null,
                    profile: null,
                    profiles: [],
                    isAuthenticated: false
                });
            },

            selectProfile: (profileId) => {
                const profile = get().profiles.find(p => p.id === profileId);
                if (profile) {
                    set({ profile });
                    // Clear content cache when profile changes
                    useContentStore.getState().clearCache();
                }
            },

            fetchProfiles: async () => {
                const profiles = await api.get('/profiles');
                set({ profiles });
            }
        }),
        {
            name: 'auth-storage',
            partialize: (state) => ({
                user: state.user,
                profile: state.profile,
                isAuthenticated: state.isAuthenticated
            })
        }
    )
);
```

### Player Store

```typescript
interface PlayerState {
    // Playback state
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    buffered: number;

    // Quality
    quality: QualityLevel;
    availableQualities: QualityLevel[];
    autoQuality: boolean;

    // UI state
    showControls: boolean;
    isFullscreen: boolean;
    volume: number;
    isMuted: boolean;

    // Content
    currentContent: Content | null;
    contentId: string | null;

    // Actions
    play: () => void;
    pause: () => void;
    seek: (time: number) => void;
    setQuality: (quality: QualityLevel) => void;
    toggleFullscreen: () => void;
    setVolume: (volume: number) => void;
    toggleMute: () => void;
    loadContent: (contentId: string) => Promise<void>;
    saveProgress: () => Promise<void>;
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    quality: 'auto',
    availableQualities: [],
    autoQuality: true,
    showControls: true,
    isFullscreen: false,
    volume: 1,
    isMuted: false,
    currentContent: null,
    contentId: null,

    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),

    seek: (time) => {
        set({ currentTime: time });
        // HLS player will handle actual seek
    },

    setQuality: (quality) => {
        set({ quality, autoQuality: quality === 'auto' });
    },

    toggleFullscreen: async () => {
        const isFullscreen = !get().isFullscreen;
        if (isFullscreen) {
            await document.documentElement.requestFullscreen();
        } else {
            await document.exitFullscreen();
        }
        set({ isFullscreen });
    },

    setVolume: (volume) => {
        set({ volume, isMuted: volume === 0 });
    },

    toggleMute: () => {
        const { isMuted, volume } = get();
        set({ isMuted: !isMuted });
    },

    loadContent: async (contentId) => {
        // Fetch content details and playback URLs
        const content = await api.get(`/content/${contentId}`);
        const playback = await api.get(`/stream/${contentId}/playback`);

        // Get saved progress
        const progress = await api.get(`/watch/progress/${contentId}`);

        set({
            currentContent: content,
            contentId,
            currentTime: progress?.position || 0,
            duration: content.duration,
            availableQualities: playback.qualities
        });
    },

    saveProgress: async () => {
        const { contentId, currentTime, duration } = get();
        if (!contentId) return;

        await api.post('/watch/progress', {
            contentId,
            position: Math.floor(currentTime),
            duration,
            clientTimestamp: Date.now()
        });
    }
}));
```

## Deep Dive: Video Player Component

### Main Player Component

```typescript
/**
 * Full-screen video player with HLS adaptive streaming support.
 * Handles quality selection, progress tracking, and keyboard controls.
 */
export function VideoPlayer() {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const {
        isPlaying,
        currentTime,
        duration,
        quality,
        showControls,
        currentContent,
        play,
        pause,
        seek,
        setQuality,
        saveProgress
    } = usePlayerStore();

    const { contentId } = useParams({ from: '/watch/$contentId' });

    // Initialize HLS player
    useEffect(() => {
        if (!videoRef.current || !contentId) return;

        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90
        });

        hls.loadSource(`/api/stream/${contentId}/master.m3u8`);
        hls.attachMedia(videoRef.current);

        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            const qualities = data.levels.map(level => ({
                height: level.height,
                bitrate: level.bitrate
            }));
            // Update available qualities in store
        });

        hlsRef.current = hls;

        return () => {
            hls.destroy();
        };
    }, [contentId]);

    // Auto-hide controls
    useAutoHideControls(containerRef, 3000);

    // Keyboard controls
    useKeyboardControls({
        onSpace: () => isPlaying ? pause() : play(),
        onArrowLeft: () => seek(currentTime - 10),
        onArrowRight: () => seek(currentTime + 30),
        onArrowUp: () => {/* increase volume */},
        onArrowDown: () => {/* decrease volume */},
        onEscape: () => {/* exit fullscreen */}
    });

    // Progress auto-save every 30 seconds
    useProgressAutoSave(saveProgress, 30000);

    // Save progress on unmount
    useEffect(() => {
        return () => {
            saveProgress();
        };
    }, [saveProgress]);

    return (
        <div
            ref={containerRef}
            className="relative w-full h-screen bg-black"
            onMouseMove={() => showControlsTemporarily()}
        >
            <video
                ref={videoRef}
                className="w-full h-full object-contain"
                autoPlay
                playsInline
                onTimeUpdate={(e) => {
                    usePlayerStore.setState({
                        currentTime: e.currentTarget.currentTime
                    });
                }}
                onPlay={() => play()}
                onPause={() => pause()}
            />

            {/* Video overlay for click-to-play */}
            <VideoOverlay
                isPlaying={isPlaying}
                onPlayPause={() => isPlaying ? pause() : play()}
            />

            {/* Controls overlay */}
            <AnimatePresence>
                {showControls && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 flex flex-col"
                    >
                        <PlayerTopBar
                            title={currentContent?.title}
                            onBack={() => navigate('/')}
                        />

                        <div className="flex-1" />

                        <ProgressBar
                            currentTime={currentTime}
                            duration={duration}
                            buffered={buffered}
                            onSeek={seek}
                        />

                        <PlayerControls
                            isPlaying={isPlaying}
                            onPlayPause={() => isPlaying ? pause() : play()}
                            quality={quality}
                            onQualityChange={setQuality}
                        />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
```

### Progress Bar Component

```typescript
interface ProgressBarProps {
    currentTime: number;
    duration: number;
    buffered: number;
    onSeek: (time: number) => void;
}

/**
 * Interactive seek bar with buffer visualization and time tooltips.
 */
export function ProgressBar({
    currentTime,
    duration,
    buffered,
    onSeek
}: ProgressBarProps) {
    const [isDragging, setIsDragging] = useState(false);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const barRef = useRef<HTMLDivElement>(null);

    const progressPercent = (currentTime / duration) * 100;
    const bufferedPercent = (buffered / duration) * 100;

    const handleSeek = (clientX: number) => {
        if (!barRef.current) return;
        const rect = barRef.current.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1,
            (clientX - rect.left) / rect.width
        ));
        onSeek(percent * duration);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!barRef.current) return;
        const rect = barRef.current.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        setHoverTime(Math.max(0, Math.min(duration, percent * duration)));

        if (isDragging) {
            handleSeek(e.clientX);
        }
    };

    return (
        <div className="px-4 py-2">
            <div
                ref={barRef}
                className="relative h-1 bg-white/30 rounded-full cursor-pointer
                           group hover:h-2 transition-all"
                onClick={(e) => handleSeek(e.clientX)}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setHoverTime(null)}
                onMouseDown={() => setIsDragging(true)}
                onMouseUp={() => setIsDragging(false)}
            >
                {/* Buffered progress */}
                <div
                    className="absolute inset-y-0 left-0 bg-white/50 rounded-full"
                    style={{ width: `${bufferedPercent}%` }}
                />

                {/* Current progress */}
                <div
                    className="absolute inset-y-0 left-0 bg-white rounded-full"
                    style={{ width: `${progressPercent}%` }}
                />

                {/* Seek handle */}
                <div
                    className="absolute top-1/2 -translate-y-1/2 w-3 h-3
                               bg-white rounded-full shadow-lg
                               opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ left: `calc(${progressPercent}% - 6px)` }}
                />

                {/* Time tooltip */}
                {hoverTime !== null && (
                    <div
                        className="absolute -top-8 -translate-x-1/2
                                   px-2 py-1 bg-black/80 text-white text-xs
                                   rounded whitespace-nowrap"
                        style={{
                            left: `${(hoverTime / duration) * 100}%`
                        }}
                    >
                        {formatTime(hoverTime)}
                    </div>
                )}
            </div>

            {/* Time display */}
            <div className="flex justify-between text-sm text-white/80 mt-1">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
            </div>
        </div>
    );
}

function formatTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}
```

### Quality Selection Component

```typescript
interface QualityLevel {
    height: number;
    bitrate: number;
    label: string;
}

interface QualitySettingsProps {
    current: QualityLevel | 'auto';
    available: QualityLevel[];
    onChange: (quality: QualityLevel | 'auto') => void;
}

/**
 * Quality selection dropdown with auto option and bitrate display.
 */
export function QualitySettings({
    current,
    available,
    onChange
}: QualitySettingsProps) {
    const [isOpen, setIsOpen] = useState(false);

    const getLabel = (quality: QualityLevel | 'auto'): string => {
        if (quality === 'auto') {
            return 'Auto';
        }
        const hdLabel = quality.height >= 2160 ? '4K' :
                       quality.height >= 1080 ? 'HD' :
                       quality.height >= 720 ? 'HD' : 'SD';
        return `${quality.height}p ${hdLabel}`;
    };

    return (
        <div className="relative">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-2
                           text-white hover:text-white/80 transition-colors"
                aria-label="Quality settings"
                aria-expanded={isOpen}
            >
                <SettingsIcon className="w-5 h-5" />
                <span className="text-sm">{getLabel(current)}</span>
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute bottom-full right-0 mb-2
                                   bg-black/90 rounded-lg shadow-xl
                                   min-w-[160px] overflow-hidden"
                    >
                        {/* Auto option */}
                        <button
                            onClick={() => {
                                onChange('auto');
                                setIsOpen(false);
                            }}
                            className={`w-full px-4 py-3 text-left text-sm
                                       flex items-center justify-between
                                       hover:bg-white/10 transition-colors
                                       ${current === 'auto' ? 'text-blue-400' : 'text-white'}`}
                        >
                            <span>Auto</span>
                            {current === 'auto' && (
                                <CheckIcon className="w-4 h-4" />
                            )}
                        </button>

                        <div className="h-px bg-white/20" />

                        {/* Quality options */}
                        {available.map((quality) => (
                            <button
                                key={quality.height}
                                onClick={() => {
                                    onChange(quality);
                                    setIsOpen(false);
                                }}
                                className={`w-full px-4 py-3 text-left text-sm
                                           flex items-center justify-between
                                           hover:bg-white/10 transition-colors
                                           ${current !== 'auto' && current.height === quality.height
                                               ? 'text-blue-400'
                                               : 'text-white'}`}
                            >
                                <span>{getLabel(quality)}</span>
                                <span className="text-white/50 text-xs">
                                    {formatBitrate(quality.bitrate)}
                                </span>
                            </button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function formatBitrate(bps: number): string {
    const mbps = bps / 1000000;
    return `${mbps.toFixed(1)} Mbps`;
}
```

## Deep Dive: Content Browsing Experience

### Hero Banner Component

```typescript
interface HeroBannerProps {
    content: Content;
    onPlay: () => void;
    onMoreInfo: () => void;
}

/**
 * Full-width hero banner with gradient overlay and action buttons.
 * Auto-advances to next featured content every 8 seconds.
 */
export function HeroBanner({ content, onPlay, onMoreInfo }: HeroBannerProps) {
    return (
        <div className="relative h-[70vh] min-h-[500px] w-full">
            {/* Background image with parallax effect */}
            <motion.div
                className="absolute inset-0"
                initial={{ scale: 1.1 }}
                animate={{ scale: 1 }}
                transition={{ duration: 1.5 }}
            >
                <img
                    src={content.heroImageUrl}
                    alt={content.title}
                    className="w-full h-full object-cover"
                />
            </motion.div>

            {/* Gradient overlays */}
            <div className="absolute inset-0 bg-gradient-to-t
                           from-apple-gray-900 via-transparent to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r
                           from-apple-gray-900/80 via-transparent to-transparent" />

            {/* Content */}
            <div className="absolute bottom-0 left-0 right-0 p-8 md:p-16">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="max-w-2xl"
                >
                    {/* Logo or title */}
                    {content.logoUrl ? (
                        <img
                            src={content.logoUrl}
                            alt={content.title}
                            className="h-24 md:h-32 object-contain mb-4"
                        />
                    ) : (
                        <h1 className="text-4xl md:text-6xl font-bold
                                      text-white mb-4">
                            {content.title}
                        </h1>
                    )}

                    {/* Metadata */}
                    <div className="flex items-center gap-3 text-white/70
                                   text-sm mb-4">
                        <span>{content.releaseYear}</span>
                        <span className="w-1 h-1 rounded-full bg-white/50" />
                        <span>{content.rating}</span>
                        <span className="w-1 h-1 rounded-full bg-white/50" />
                        <span>{formatDuration(content.duration)}</span>
                        {content.hdr && (
                            <>
                                <span className="w-1 h-1 rounded-full bg-white/50" />
                                <span className="px-1.5 py-0.5 border border-white/50
                                               rounded text-xs">
                                    4K
                                </span>
                                <span className="px-1.5 py-0.5 border border-white/50
                                               rounded text-xs">
                                    HDR
                                </span>
                            </>
                        )}
                    </div>

                    {/* Description */}
                    <p className="text-white/80 text-lg line-clamp-3 mb-6">
                        {content.description}
                    </p>

                    {/* Action buttons */}
                    <div className="flex items-center gap-4">
                        <button
                            onClick={onPlay}
                            className="flex items-center gap-2 px-8 py-3
                                      bg-white text-black font-semibold
                                      rounded-lg hover:bg-white/90
                                      transition-colors"
                        >
                            <PlayIcon className="w-6 h-6" />
                            Play
                        </button>

                        <button
                            onClick={onMoreInfo}
                            className="flex items-center gap-2 px-6 py-3
                                      bg-white/20 text-white font-semibold
                                      rounded-lg hover:bg-white/30
                                      transition-colors backdrop-blur-sm"
                        >
                            <InfoIcon className="w-5 h-5" />
                            More Info
                        </button>
                    </div>
                </motion.div>
            </div>
        </div>
    );
}
```

### Content Row Component

```typescript
interface ContentRowProps {
    title: string;
    items: Content[];
    size?: 'normal' | 'large';
}

/**
 * Horizontally scrolling content row with hover previews.
 * Uses CSS scroll snap for smooth navigation.
 */
export function ContentRow({ title, items, size = 'normal' }: ContentRowProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [showLeftArrow, setShowLeftArrow] = useState(false);
    const [showRightArrow, setShowRightArrow] = useState(true);

    const scroll = (direction: 'left' | 'right') => {
        if (!scrollRef.current) return;
        const scrollAmount = scrollRef.current.clientWidth * 0.8;
        scrollRef.current.scrollBy({
            left: direction === 'left' ? -scrollAmount : scrollAmount,
            behavior: 'smooth'
        });
    };

    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
        setShowLeftArrow(scrollLeft > 0);
        setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 10);
    };

    return (
        <section className="mb-8">
            <h2 className="text-xl md:text-2xl font-semibold text-white
                          mb-4 px-8 md:px-16">
                {title}
            </h2>

            <div className="relative group">
                {/* Scroll container */}
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="flex gap-2 md:gap-3 overflow-x-auto
                              scrollbar-hide scroll-smooth snap-x snap-mandatory
                              px-8 md:px-16"
                >
                    {items.map((item) => (
                        <ContentCard
                            key={item.id}
                            content={item}
                            size={size}
                            className="snap-start flex-shrink-0"
                        />
                    ))}
                </div>

                {/* Left arrow */}
                {showLeftArrow && (
                    <button
                        onClick={() => scroll('left')}
                        className="absolute left-0 top-0 bottom-0 w-12
                                  bg-gradient-to-r from-apple-gray-900 to-transparent
                                  flex items-center justify-center
                                  opacity-0 group-hover:opacity-100
                                  transition-opacity"
                        aria-label="Scroll left"
                    >
                        <ChevronLeftIcon className="w-8 h-8 text-white" />
                    </button>
                )}

                {/* Right arrow */}
                {showRightArrow && (
                    <button
                        onClick={() => scroll('right')}
                        className="absolute right-0 top-0 bottom-0 w-12
                                  bg-gradient-to-l from-apple-gray-900 to-transparent
                                  flex items-center justify-center
                                  opacity-0 group-hover:opacity-100
                                  transition-opacity"
                        aria-label="Scroll right"
                    >
                        <ChevronRightIcon className="w-8 h-8 text-white" />
                    </button>
                )}
            </div>
        </section>
    );
}
```

### Content Card Component

```typescript
interface ContentCardProps {
    content: Content;
    size?: 'normal' | 'large';
    className?: string;
}

/**
 * Thumbnail card with hover preview and progress indicator.
 */
export function ContentCard({ content, size = 'normal', className }: ContentCardProps) {
    const navigate = useNavigate();
    const [isHovered, setIsHovered] = useState(false);
    const progress = useContentStore(
        (state) => state.getProgress(content.id)
    );

    const cardWidth = size === 'large' ? 'w-[280px] md:w-[350px]' : 'w-[160px] md:w-[200px]';
    const aspectRatio = size === 'large' ? 'aspect-[16/9]' : 'aspect-[2/3]';

    return (
        <motion.div
            className={`relative ${cardWidth} ${className}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            whileHover={{ scale: 1.05, zIndex: 10 }}
            transition={{ duration: 0.2 }}
        >
            <Link to={`/watch/${content.id}`}>
                <div className={`relative ${aspectRatio} rounded-lg overflow-hidden`}>
                    {/* Thumbnail */}
                    <img
                        src={size === 'large' ? content.thumbnailUrl : content.posterUrl}
                        alt={content.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                    />

                    {/* Progress bar */}
                    {progress > 0 && progress < 100 && (
                        <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
                            <div
                                className="h-full bg-red-500"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    )}

                    {/* Hover overlay */}
                    <AnimatePresence>
                        {isHovered && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 bg-black/50
                                          flex items-center justify-center"
                            >
                                <div className="w-12 h-12 rounded-full bg-white/90
                                              flex items-center justify-center">
                                    <PlayIcon className="w-6 h-6 text-black ml-1" />
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Title (for smaller cards) */}
                {size === 'normal' && (
                    <h3 className="mt-2 text-sm text-white/80 truncate">
                        {content.title}
                    </h3>
                )}
            </Link>
        </motion.div>
    );
}
```

## Deep Dive: Custom Hooks

### Auto-Hide Controls Hook

```typescript
/**
 * Auto-hides player controls after inactivity.
 * Shows controls on mouse movement or keyboard input.
 */
export function useAutoHideControls(
    containerRef: RefObject<HTMLElement>,
    hideDelay = 3000
) {
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);
    const setShowControls = usePlayerStore((state) => state.setShowControls);

    const showControlsTemporarily = useCallback(() => {
        setShowControls(true);

        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = setTimeout(() => {
            const { isPlaying } = usePlayerStore.getState();
            if (isPlaying) {
                setShowControls(false);
            }
        }, hideDelay);
    }, [hideDelay, setShowControls]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleActivity = () => showControlsTemporarily();

        container.addEventListener('mousemove', handleActivity);
        container.addEventListener('mousedown', handleActivity);
        document.addEventListener('keydown', handleActivity);

        return () => {
            container.removeEventListener('mousemove', handleActivity);
            container.removeEventListener('mousedown', handleActivity);
            document.removeEventListener('keydown', handleActivity);
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [containerRef, showControlsTemporarily]);

    return { showControlsTemporarily };
}
```

### Keyboard Controls Hook

```typescript
interface KeyboardControlsConfig {
    onSpace: () => void;
    onArrowLeft: () => void;
    onArrowRight: () => void;
    onArrowUp: () => void;
    onArrowDown: () => void;
    onEscape: () => void;
    onF: () => void;
    onM: () => void;
}

/**
 * Handles keyboard shortcuts for video player.
 */
export function useKeyboardControls(config: KeyboardControlsConfig) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if user is typing in an input
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    config.onSpace();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    config.onArrowLeft();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    config.onArrowRight();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    config.onArrowUp();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    config.onArrowDown();
                    break;
                case 'Escape':
                    config.onEscape();
                    break;
                case 'f':
                case 'F':
                    config.onF();
                    break;
                case 'm':
                case 'M':
                    config.onM();
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [config]);
}
```

### Progress Auto-Save Hook

```typescript
/**
 * Periodically saves watch progress to the server.
 * Also saves on visibility change and unmount.
 */
export function useProgressAutoSave(
    saveProgress: () => Promise<void>,
    intervalMs = 30000
) {
    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        // Auto-save at interval
        intervalRef.current = setInterval(() => {
            saveProgress();
        }, intervalMs);

        // Save when tab becomes hidden
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                saveProgress();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Save before page unload
        const handleBeforeUnload = () => {
            saveProgress();
        };
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('beforeunload', handleBeforeUnload);
        };
    }, [saveProgress, intervalMs]);
}
```

## Accessibility Implementation

```typescript
// Player accessibility features
export function AccessiblePlayer() {
    const { isPlaying, currentTime, duration } = usePlayerStore();

    return (
        <div
            role="application"
            aria-label="Video player"
            aria-description={`Now playing: ${title}`}
        >
            {/* Screen reader announcements */}
            <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="sr-only"
            >
                {isPlaying ? 'Playing' : 'Paused'}
                {` - ${formatTime(currentTime)} of ${formatTime(duration)}`}
            </div>

            {/* Accessible controls */}
            <button
                onClick={togglePlayPause}
                aria-label={isPlaying ? 'Pause' : 'Play'}
                aria-pressed={isPlaying}
            >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>

            {/* Seek slider */}
            <input
                type="range"
                min={0}
                max={duration}
                value={currentTime}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Seek"
                aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            />

            {/* Captions toggle */}
            <button
                onClick={toggleCaptions}
                aria-label={captionsOn ? 'Turn off captions' : 'Turn on captions'}
                aria-pressed={captionsOn}
            >
                <CaptionsIcon />
            </button>
        </div>
    );
}
```

## Performance Optimizations

### Image Loading Strategy

```typescript
// Progressive image loading with blur placeholder
export function ProgressiveImage({ src, alt, className }: ImageProps) {
    const [isLoaded, setIsLoaded] = useState(false);
    const thumbnailSrc = src.replace('/full/', '/thumb/');

    return (
        <div className={`relative overflow-hidden ${className}`}>
            {/* Low-res placeholder */}
            <img
                src={thumbnailSrc}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover
                           blur-lg scale-110 transition-opacity duration-300
                           ${isLoaded ? 'opacity-0' : 'opacity-100'}`}
            />

            {/* Full image */}
            <img
                src={src}
                alt={alt}
                loading="lazy"
                onLoad={() => setIsLoaded(true)}
                className={`w-full h-full object-cover transition-opacity
                           duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
        </div>
    );
}
```

### Content Prefetching

```typescript
// Prefetch content details on hover
export function usePrefetchContent() {
    const prefetchedIds = useRef(new Set<string>());

    const prefetch = useCallback((contentId: string) => {
        if (prefetchedIds.current.has(contentId)) return;

        prefetchedIds.current.add(contentId);

        // Prefetch content details
        fetch(`/api/content/${contentId}`)
            .then(res => res.json())
            .then(data => {
                useContentStore.getState().cacheContent(data);
            });

        // Prefetch poster image
        const img = new Image();
        img.src = `/api/content/${contentId}/poster`;
    }, []);

    return { prefetch };
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Zustand over Redux | Simpler API, less boilerplate | Smaller ecosystem |
| hls.js | Wide browser support, feature-rich | Bundle size (~80KB) |
| CSS scroll snap | Native feel, performant | Limited customization |
| Framer Motion | Declarative animations | Additional bundle size |
| Local storage persist | Offline session support | Storage limits |
| Lazy image loading | Faster initial load | Content shifts |

## Future Frontend Enhancements

1. **Picture-in-Picture**: Mini player while browsing
2. **Offline Downloads**: Service Worker caching
3. **TV Navigation**: D-pad focus management for Apple TV
4. **Immersive Sound**: Spatial audio visualization
5. **Gesture Controls**: Swipe to seek on touch devices
6. **AI Search**: Natural language content search
