# Apple Music - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design the Apple Music frontend, focusing on the audio player experience, responsive UI across devices, and seamless library management. The key technical challenges are building a robust audio player with gapless playback and queue management, implementing efficient search with instant results, and synchronizing library state across tabs and devices.

For a music streaming app with millions of songs, we need virtualized lists for large libraries, optimistic updates for responsive interactions, and careful state management to coordinate playback across the UI."

## Requirements Clarification (3 minutes)

### Functional Requirements (Frontend Scope)
- **Audio Player**: Play/pause, skip, seek, volume, queue management
- **Browse**: Discover music through curated sections and recommendations
- **Search**: Instant search with autocomplete across songs, albums, artists
- **Library**: Personal collection with add/remove, playlists, downloads
- **Now Playing**: Full-screen view with album art, lyrics, up next

### Non-Functional Requirements
- **Performance**: < 100ms UI response, smooth 60fps animations
- **Accessibility**: WCAG 2.1 AA, keyboard navigation, screen reader support
- **Offline**: Service worker for offline library access
- **Cross-Platform**: Responsive design for mobile, tablet, desktop

### User Experience Goals
- Playback never interrupts during navigation
- Library changes reflect instantly (optimistic updates)
- Seamless quality adaptation without user intervention
- Keyboard shortcuts for power users

## Component Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         App Shell                                    │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Navigation Bar                                ││
│  │  [Logo] [Search] [Browse] [Radio] [Library] [Profile]           ││
│  └─────────────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────┬────────────────────┐│
│  │              Main Content                  │    Now Playing     ││
│  │  ┌──────────────────────────────────────┐  │    Sidebar         ││
│  │  │   Browse / Album / Artist / Search   │  │  ┌──────────────┐  ││
│  │  │   Library / Playlist Views           │  │  │  Album Art   │  ││
│  │  │   (virtualized lists)                │  │  │  Track Info  │  ││
│  │  └──────────────────────────────────────┘  │  │  Queue       │  ││
│  │                                            │  └──────────────┘  ││
│  └────────────────────────────────────────────┴────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                    Player Bar (persistent)                       ││
│  │  [Now Playing] [Progress] [Controls] [Volume] [Queue]           ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Component Tree

```
App
├── NavigationBar
│   ├── Logo
│   ├── SearchBar (with autocomplete)
│   ├── NavLinks
│   └── UserMenu
├── MainContent (router outlet)
│   ├── BrowsePage
│   │   ├── ForYouSection
│   │   ├── RecentlyPlayedRow
│   │   └── FeaturedPlaylistsGrid
│   ├── AlbumPage
│   │   ├── AlbumHeader
│   │   └── TrackList
│   ├── ArtistPage
│   ├── PlaylistPage
│   ├── LibraryPage
│   │   ├── LibraryTabs
│   │   └── VirtualizedGrid
│   └── SearchResultsPage
├── NowPlayingSidebar
│   ├── LargeAlbumArt
│   ├── TrackDetails
│   ├── LyricsPanel
│   └── UpNextQueue
└── PlayerBar
    ├── NowPlayingMini
    ├── ProgressBar
    ├── PlaybackControls
    ├── VolumeControl
    └── QueueButton
```

## State Management (5 minutes)

### Zustand Store Structure

```typescript
// stores/playerStore.ts
interface PlayerState {
  // Playback state
  isPlaying: boolean;
  currentTrack: Track | null;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;

  // Queue management
  queue: Track[];
  queueIndex: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';

  // Actions
  play: (track?: Track) => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  addToQueue: (tracks: Track[]) => void;
  playAlbum: (album: Album, startIndex?: number) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  isPlaying: false,
  currentTrack: null,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isMuted: false,
  queue: [],
  queueIndex: 0,
  shuffle: false,
  repeat: 'off',

  play: (track) => {
    const state = get();
    if (track) {
      set({ currentTrack: track, isPlaying: true });
    } else if (state.currentTrack) {
      set({ isPlaying: true });
    }
  },

  pause: () => set({ isPlaying: false }),

  next: () => {
    const { queue, queueIndex, repeat, shuffle } = get();
    if (queue.length === 0) return;

    let nextIndex: number;
    if (shuffle) {
      nextIndex = Math.floor(Math.random() * queue.length);
    } else if (queueIndex < queue.length - 1) {
      nextIndex = queueIndex + 1;
    } else if (repeat === 'all') {
      nextIndex = 0;
    } else {
      set({ isPlaying: false });
      return;
    }

    set({
      queueIndex: nextIndex,
      currentTrack: queue[nextIndex],
      currentTime: 0
    });
  },

  playAlbum: (album, startIndex = 0) => {
    set({
      queue: album.tracks,
      queueIndex: startIndex,
      currentTrack: album.tracks[startIndex],
      isPlaying: true,
      currentTime: 0
    });
  }
}));
```

### Library State with Sync

```typescript
// stores/libraryStore.ts
interface LibraryState {
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  syncToken: number | null;
  isSyncing: boolean;

  // Optimistic operations
  addToLibrary: (item: LibraryItem) => Promise<void>;
  removeFromLibrary: (itemId: string, itemType: string) => Promise<void>;
  syncLibrary: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  albums: [],
  playlists: [],
  syncToken: null,
  isSyncing: false,

  addToLibrary: async (item) => {
    // Optimistic update
    const key = item.type === 'track' ? 'tracks'
              : item.type === 'album' ? 'albums'
              : 'playlists';

    set((state) => ({
      [key]: [...state[key], item]
    }));

    try {
      await api.post('/library', {
        itemType: item.type,
        itemId: item.id
      });
    } catch (error) {
      // Rollback on failure
      set((state) => ({
        [key]: state[key].filter((i) => i.id !== item.id)
      }));
      throw error;
    }
  },

  syncLibrary: async () => {
    const { syncToken } = get();
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
              tracks.push(change.data);
            }
          } else if (change.changeType === 'remove') {
            if (change.itemType === 'track') {
              tracks = tracks.filter(t => t.id !== change.itemId);
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
}));
```

## Deep Dive: Audio Player (8 minutes)

### Web Audio Integration

```typescript
// hooks/useAudioPlayer.ts
export function useAudioPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextAudioRef = useRef<HTMLAudioElement | null>(null); // For gapless

  const {
    currentTrack,
    isPlaying,
    volume,
    next: nextTrack
  } = usePlayerStore();

  // Initialize audio element
  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'auto';
    }

    const audio = audioRef.current;

    // Handle track end
    const handleEnded = () => {
      if (nextAudioRef.current?.src) {
        // Swap to pre-buffered next track (gapless)
        audioRef.current = nextAudioRef.current;
        audioRef.current.play();
        nextAudioRef.current = new Audio();
        nextTrack();
      } else {
        nextTrack();
      }
    };

    // Update store with time progress
    const handleTimeUpdate = () => {
      usePlayerStore.setState({
        currentTime: audio.currentTime,
        duration: audio.duration || 0
      });
    };

    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, []);

  // Load and play new track
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;

    const loadTrack = async () => {
      const streamUrl = await api.get(`/stream/${currentTrack.id}`);
      audioRef.current!.src = streamUrl.url;

      if (isPlaying) {
        audioRef.current!.play();
      }
    };

    loadTrack();
  }, [currentTrack?.id]);

  // Play/pause control
  useEffect(() => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.play();
    } else {
      audioRef.current.pause();
    }
  }, [isPlaying]);

  // Volume control
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  return {
    seek: (time: number) => {
      if (audioRef.current) {
        audioRef.current.currentTime = time;
      }
    }
  };
}
```

### Prefetching Next Track

```typescript
// Prefetch next track for gapless playback
useEffect(() => {
  const { queue, queueIndex } = usePlayerStore.getState();
  const nextIndex = queueIndex + 1;

  if (nextIndex < queue.length && nextAudioRef.current) {
    const prefetchNext = async () => {
      const nextTrack = queue[nextIndex];
      const streamUrl = await api.get(`/stream/${nextTrack.id}`);
      nextAudioRef.current!.src = streamUrl.url;
      nextAudioRef.current!.preload = 'auto';
    };

    prefetchNext();
  }
}, [currentTrack?.id]);
```

### Player Bar Component

```tsx
// components/PlayerBar.tsx
export function PlayerBar() {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    play,
    pause,
    next,
    previous,
    setVolume
  } = usePlayerStore();

  const { seek } = useAudioPlayer();

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!currentTrack) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 h-20 bg-zinc-900
                 border-t border-zinc-800 flex items-center px-4"
      role="region"
      aria-label="Audio player"
    >
      {/* Now Playing Info */}
      <div className="flex items-center gap-3 w-64">
        <img
          src={currentTrack.album.artworkUrl}
          alt={currentTrack.album.title}
          className="w-14 h-14 rounded"
        />
        <div className="truncate">
          <p className="text-white font-medium truncate">
            {currentTrack.title}
          </p>
          <p className="text-zinc-400 text-sm truncate">
            {currentTrack.artist.name}
          </p>
        </div>
      </div>

      {/* Playback Controls */}
      <div className="flex-1 flex flex-col items-center gap-1">
        <div className="flex items-center gap-4">
          <button
            onClick={previous}
            className="text-zinc-400 hover:text-white transition-colors"
            aria-label="Previous track"
          >
            <SkipBackIcon className="w-5 h-5" />
          </button>

          <button
            onClick={() => isPlaying ? pause() : play()}
            className="w-10 h-10 bg-white rounded-full flex items-center
                       justify-center hover:scale-105 transition-transform"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <PauseIcon className="w-5 h-5 text-black" />
            ) : (
              <PlayIcon className="w-5 h-5 text-black ml-0.5" />
            )}
          </button>

          <button
            onClick={next}
            className="text-zinc-400 hover:text-white transition-colors"
            aria-label="Next track"
          >
            <SkipForwardIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="flex items-center gap-2 w-full max-w-xl">
          <span className="text-xs text-zinc-400 w-10 text-right">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 h-1 bg-zinc-600 rounded-full appearance-none
                       [&::-webkit-slider-thumb]:appearance-none
                       [&::-webkit-slider-thumb]:w-3
                       [&::-webkit-slider-thumb]:h-3
                       [&::-webkit-slider-thumb]:bg-white
                       [&::-webkit-slider-thumb]:rounded-full
                       [&::-webkit-slider-thumb]:cursor-pointer"
            aria-label="Seek"
          />
          <span className="text-xs text-zinc-400 w-10">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* Volume Control */}
      <div className="w-32 flex items-center gap-2">
        <VolumeIcon className="w-5 h-5 text-zinc-400" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="flex-1 h-1 bg-zinc-600 rounded-full appearance-none
                     [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:w-3
                     [&::-webkit-slider-thumb]:h-3
                     [&::-webkit-slider-thumb]:bg-white
                     [&::-webkit-slider-thumb]:rounded-full"
          aria-label="Volume"
        />
      </div>
    </div>
  );
}
```

## Deep Dive: Search Experience (5 minutes)

### Debounced Search with Autocomplete

```tsx
// components/SearchBar.tsx
export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Debounced search
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults(null);
      return;
    }

    const search = async () => {
      const data = await api.get('/search', {
        params: { q: debouncedQuery, limit: 5 }
      });
      setResults(data);
      setSelectedIndex(0);
    };

    search();
  }, [debouncedQuery]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!results) return;

    const totalItems = [
      ...results.tracks,
      ...results.albums,
      ...results.artists
    ].length;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, totalItems - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        selectResult(selectedIndex);
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  return (
    <div className="relative w-80">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2
                               w-4 h-4 text-zinc-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search songs, albums, artists..."
          className="w-full pl-10 pr-4 py-2 bg-zinc-800 rounded-lg
                     text-white placeholder:text-zinc-500
                     focus:outline-none focus:ring-2 focus:ring-pink-500"
          role="combobox"
          aria-expanded={isOpen && results !== null}
          aria-controls="search-results"
          aria-activedescendant={`result-${selectedIndex}`}
        />
      </div>

      {isOpen && results && (
        <div
          id="search-results"
          className="absolute top-full left-0 right-0 mt-2
                     bg-zinc-800 rounded-lg shadow-xl overflow-hidden z-50"
          role="listbox"
        >
          {/* Top Result */}
          {results.topResult && (
            <div className="p-4 border-b border-zinc-700">
              <p className="text-xs text-zinc-400 uppercase mb-2">Top Result</p>
              <TopResultCard result={results.topResult} />
            </div>
          )}

          {/* Songs */}
          {results.tracks.length > 0 && (
            <div className="p-4">
              <p className="text-xs text-zinc-400 uppercase mb-2">Songs</p>
              {results.tracks.map((track, i) => (
                <SearchResultRow
                  key={track.id}
                  item={track}
                  type="track"
                  isSelected={selectedIndex === i}
                  id={`result-${i}`}
                  onClick={() => playTrack(track)}
                />
              ))}
            </div>
          )}

          {/* Albums */}
          {results.albums.length > 0 && (
            <div className="p-4 border-t border-zinc-700">
              <p className="text-xs text-zinc-400 uppercase mb-2">Albums</p>
              {results.albums.map((album, i) => (
                <SearchResultRow
                  key={album.id}
                  item={album}
                  type="album"
                  isSelected={selectedIndex === results.tracks.length + i}
                  onClick={() => navigate(`/album/${album.id}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

## Deep Dive: Library with Virtualization (5 minutes)

### Virtualized Track Grid

```tsx
// components/LibraryGrid.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

export function LibraryGrid() {
  const { tracks } = useLibraryStore();
  const parentRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(5);

  // Responsive columns
  useEffect(() => {
    const updateColumns = () => {
      const width = window.innerWidth;
      if (width < 640) setColumns(2);
      else if (width < 1024) setColumns(3);
      else if (width < 1280) setColumns(4);
      else setColumns(5);
    };

    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, []);

  const rowCount = Math.ceil(tracks.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 220, // Height of each row
    overscan: 3
  });

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowTracks = tracks.slice(startIndex, startIndex + columns);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
              className="flex gap-4 px-4"
            >
              {rowTracks.map((track) => (
                <AlbumCard
                  key={track.id}
                  album={track.album}
                  className="flex-1"
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Album Card Component

```tsx
// components/AlbumCard.tsx
interface AlbumCardProps {
  album: Album;
  className?: string;
}

export function AlbumCard({ album, className }: AlbumCardProps) {
  const { playAlbum } = usePlayerStore();
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn(
        "group relative cursor-pointer",
        className
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={() => playAlbum(album)}
    >
      <div className="relative aspect-square mb-2">
        <img
          src={album.artworkUrl}
          alt={album.title}
          className="w-full h-full object-cover rounded-lg shadow-lg"
          loading="lazy"
        />

        {/* Play button overlay */}
        <button
          className={cn(
            "absolute bottom-2 right-2 w-12 h-12 bg-pink-500 rounded-full",
            "flex items-center justify-center shadow-lg",
            "transform transition-all duration-200",
            isHovered
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-2"
          )}
          onClick={(e) => {
            e.stopPropagation();
            playAlbum(album);
          }}
          aria-label={`Play ${album.title}`}
        >
          <PlayIcon className="w-5 h-5 text-white ml-0.5" />
        </button>
      </div>

      <p className="font-medium text-white truncate">{album.title}</p>
      <p className="text-sm text-zinc-400 truncate">{album.artist.name}</p>
    </div>
  );
}
```

## Keyboard Shortcuts (3 minutes)

### Global Keyboard Handler

```tsx
// hooks/useKeyboardShortcuts.ts
export function useKeyboardShortcuts() {
  const { isPlaying, play, pause, next, previous } = usePlayerStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          isPlaying ? pause() : play();
          break;
        case 'ArrowRight':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            next();
          }
          break;
        case 'ArrowLeft':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            previous();
          }
          break;
        case 'KeyF':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            document.getElementById('search-input')?.focus();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying]);
}
```

## Accessibility (3 minutes)

### Screen Reader Announcements

```tsx
// components/LiveAnnouncer.tsx
export function LiveAnnouncer() {
  const { currentTrack, isPlaying } = usePlayerStore();
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (currentTrack) {
      setAnnouncement(
        `Now playing: ${currentTrack.title} by ${currentTrack.artist.name}`
      );
    }
  }, [currentTrack?.id]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {announcement}
    </div>
  );
}
```

### Focus Management

```tsx
// hooks/useFocusTrap.ts
export function useFocusTrap(isActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const focusableElements = containerRef.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );

    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleTab);
    firstElement?.focus();

    return () => document.removeEventListener('keydown', handleTab);
  }, [isActive]);

  return containerRef;
}
```

## Trade-offs and Alternatives (5 minutes)

| Decision | Chosen Approach | Alternative | Rationale |
|----------|-----------------|-------------|-----------|
| Audio API | HTMLAudioElement | Web Audio API | Simpler, sufficient for playback |
| State Management | Zustand | Redux | Less boilerplate, built-in persistence |
| Styling | Tailwind CSS | CSS Modules | Rapid development, consistent design |
| Virtualization | TanStack Virtual | react-window | More features, better dynamic sizing |
| Routing | TanStack Router | React Router | Type-safe, file-based routing |
| Data Fetching | TanStack Query | SWR | Better caching, devtools |

### Why HTMLAudioElement Over Web Audio API

The Web Audio API is powerful but complex:
- **Simpler Integration**: `<audio>` element handles buffering, codecs, network
- **Gapless Possible**: Two audio elements enable crossfade
- **Trade-off**: Less control over audio processing (equalizer, effects)

### Why Zustand Over Redux

- **Less Boilerplate**: No action types, reducers, or selectors needed
- **Simpler Updates**: Direct state mutation with Immer integration
- **Persistence**: Built-in localStorage middleware
- **Trade-off**: Less ecosystem (middleware, devtools)

## Performance Optimizations (3 minutes)

### Image Lazy Loading

```tsx
// components/LazyImage.tsx
export function LazyImage({ src, alt, className }: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef} className={cn("bg-zinc-800", className)}>
      {isInView && (
        <img
          src={src}
          alt={alt}
          onLoad={() => setIsLoaded(true)}
          className={cn(
            "transition-opacity duration-300",
            isLoaded ? "opacity-100" : "opacity-0"
          )}
        />
      )}
    </div>
  );
}
```

### Memoized Track List

```tsx
// components/TrackList.tsx
const TrackRow = memo(function TrackRow({
  track,
  index,
  isPlaying
}: TrackRowProps) {
  const { play } = usePlayerStore();

  return (
    <div
      className={cn(
        "flex items-center gap-4 p-2 rounded-lg hover:bg-zinc-800",
        isPlaying && "bg-zinc-800"
      )}
      onClick={() => play(track)}
    >
      <span className="w-6 text-zinc-400 text-right">{index + 1}</span>
      <img
        src={track.album.artworkUrl}
        className="w-10 h-10 rounded"
        alt=""
      />
      <div className="flex-1 truncate">
        <p className={cn("truncate", isPlaying && "text-pink-500")}>
          {track.title}
        </p>
        <p className="text-sm text-zinc-400 truncate">{track.artist.name}</p>
      </div>
      <span className="text-zinc-400">{formatDuration(track.durationMs)}</span>
    </div>
  );
});
```

## Closing Summary (1 minute)

"The Apple Music frontend is built around three core systems:

1. **Audio Player** - Persistent player bar with gapless playback achieved through dual HTMLAudioElement instances for prefetching. The player state in Zustand coordinates playback across all UI components.

2. **Search Experience** - Debounced input with instant results, keyboard navigation for accessibility, and categorized results (songs, albums, artists) with a top result highlight.

3. **Virtualized Library** - TanStack Virtual renders only visible items, enabling smooth scrolling through thousands of saved tracks. Responsive column count adapts to screen width.

The main trade-off is simplicity over power: HTMLAudioElement over Web Audio API sacrifices audio effects for easier implementation, but enables gapless playback which is the critical user experience feature."

## Future Enhancements

1. **Offline Support** - Service worker caching for downloaded tracks
2. **Waveform Visualization** - Web Audio API analyser node for visual feedback
3. **Lyrics Sync** - Timestamped lyrics with karaoke-style highlighting
4. **Collaborative Playlists** - Real-time updates via WebSocket
5. **Mini Player** - Picture-in-picture for multitasking
