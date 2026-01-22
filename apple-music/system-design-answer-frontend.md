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

### App Shell Layout

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
┌─────────────────────────────────────────────────────────────────────┐
│  App                                                                 │
│  ├── NavigationBar                                                  │
│  │   ├── Logo                                                       │
│  │   ├── SearchBar (with autocomplete)                              │
│  │   ├── NavLinks                                                   │
│  │   └── UserMenu                                                   │
│  ├── MainContent (router outlet)                                    │
│  │   ├── BrowsePage                                                 │
│  │   │   ├── ForYouSection                                         │
│  │   │   ├── RecentlyPlayedRow                                     │
│  │   │   └── FeaturedPlaylistsGrid                                 │
│  │   ├── AlbumPage                                                  │
│  │   │   ├── AlbumHeader                                           │
│  │   │   └── TrackList                                             │
│  │   ├── ArtistPage                                                 │
│  │   ├── PlaylistPage                                               │
│  │   ├── LibraryPage                                                │
│  │   │   ├── LibraryTabs                                           │
│  │   │   └── VirtualizedGrid                                       │
│  │   └── SearchResultsPage                                          │
│  ├── NowPlayingSidebar                                              │
│  │   ├── LargeAlbumArt                                             │
│  │   ├── TrackDetails                                              │
│  │   ├── LyricsPanel                                               │
│  │   └── UpNextQueue                                               │
│  └── PlayerBar                                                      │
│      ├── NowPlayingMini                                            │
│      ├── ProgressBar                                               │
│      ├── PlaybackControls                                          │
│      ├── VolumeControl                                             │
│      └── QueueButton                                               │
└─────────────────────────────────────────────────────────────────────┘
```

## State Management (5 minutes)

### Zustand Store Structure

**PlayerStore:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                         PlayerState                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Playback State                                                      │
│  ├── isPlaying: boolean                                             │
│  ├── currentTrack: Track | null                                     │
│  ├── currentTime: number                                            │
│  ├── duration: number                                               │
│  ├── volume: number                                                 │
│  └── isMuted: boolean                                               │
├─────────────────────────────────────────────────────────────────────┤
│  Queue Management                                                    │
│  ├── queue: Track[]                                                 │
│  ├── queueIndex: number                                             │
│  ├── shuffle: boolean                                               │
│  └── repeat: 'off' | 'all' | 'one'                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Actions                                                             │
│  ├── play(track?) ──▶ set currentTrack, isPlaying: true             │
│  ├── pause() ──▶ isPlaying: false                                   │
│  ├── next() ──▶ advance queue (shuffle/repeat aware)                │
│  ├── previous() ──▶ go back in queue                                │
│  ├── seek(time) ──▶ update currentTime                              │
│  ├── setVolume(vol) ──▶ update volume                               │
│  ├── addToQueue(tracks) ──▶ append to queue                         │
│  └── playAlbum(album, startIndex?) ──▶ load album into queue        │
└─────────────────────────────────────────────────────────────────────┘
```

**next() Action Logic:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  next() Flow                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  IF queue.length === 0: return                                       │
│                                                                      │
│  Calculate nextIndex:                                                │
│    IF shuffle: random(0, queue.length)                              │
│    ELSE IF queueIndex < length - 1: queueIndex + 1                  │
│    ELSE IF repeat === 'all': 0                                      │
│    ELSE: stop playing, return                                       │
│                                                                      │
│  Set: queueIndex, currentTrack = queue[nextIndex], currentTime = 0  │
└─────────────────────────────────────────────────────────────────────┘
```

### Library State with Sync

**LibraryStore:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                        LibraryState                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Data                                                                │
│  ├── tracks: Track[]                                                │
│  ├── albums: Album[]                                                │
│  ├── playlists: Playlist[]                                          │
│  ├── syncToken: number | null                                       │
│  └── isSyncing: boolean                                             │
├─────────────────────────────────────────────────────────────────────┤
│  addToLibrary(item)                                                  │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. Optimistic: add item to local state                        │  │
│  │  2. API call: POST /library { itemType, itemId }               │  │
│  │  3. On error: rollback - remove from local state               │  │
│  └───────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  syncLibrary()                                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. GET /library/sync?syncToken=...                            │  │
│  │  2. Apply delta changes:                                       │  │
│  │     - changeType: 'add' ──▶ push to array                      │  │
│  │     - changeType: 'remove' ──▶ filter out                      │  │
│  │  3. Update syncToken for next sync                             │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Audio Player (8 minutes)

### Web Audio Integration

**useAudioPlayer Hook:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                      useAudioPlayer()                                │
├─────────────────────────────────────────────────────────────────────┤
│  Refs                                                                │
│  ├── audioRef: HTMLAudioElement (current track)                     │
│  └── nextAudioRef: HTMLAudioElement (prefetch for gapless)          │
├─────────────────────────────────────────────────────────────────────┤
│  Store Access                                                        │
│  └── currentTrack, isPlaying, volume, next (from usePlayerStore)    │
├─────────────────────────────────────────────────────────────────────┤
│  Effects                                                             │
│  ├── Initialize: create Audio element, attach event listeners       │
│  ├── Track change: load new src, play if isPlaying                  │
│  ├── Play/pause: audio.play() or audio.pause()                      │
│  └── Volume: audio.volume = volume                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Returns                                                             │
│  └── seek(time) ──▶ audio.currentTime = time                        │
└─────────────────────────────────────────────────────────────────────┘
```

**Event Handlers:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Event: 'ended'                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  IF nextAudioRef has src (prefetched):                              │
│    1. Swap: audioRef = nextAudioRef                                 │
│    2. Play immediately (gapless)                                    │
│    3. Create new nextAudioRef                                       │
│    4. Call next() to update store                                   │
│  ELSE:                                                               │
│    Call next() (will load via useEffect)                            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Event: 'timeupdate'                                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Update store: currentTime, duration                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Prefetching Next Track

```
Prefetch Effect Flow:
┌───────────────────────┐
│ currentTrack changes  │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐
│ Get queue, queueIndex │
│ nextIndex = index + 1 │
└───────────┬───────────┘
            │
            ▼
┌───────────────────────┐     ┌───────────────────────┐
│ nextIndex < length?   │────▶│ Fetch stream URL      │
└───────────────────────┘ yes │ Set nextAudioRef.src  │
            │ no              │ preload = 'auto'      │
            ▼                 └───────────────────────┘
     (no prefetch)
```

"I chose dual HTMLAudioElement for gapless playback. When track A ends, we immediately switch to the already-buffered track B. The user hears no gap between songs - critical for album listening."

### Player Bar Component

```
┌─────────────────────────────────────────────────────────────────────┐
│  PlayerBar Layout                                                    │
├────────────────┬──────────────────────────────┬─────────────────────┤
│  Now Playing   │     Playback Controls        │   Volume Control    │
│  ┌──────────┐  │  ┌────────────────────────┐  │   ┌─────────────┐  │
│  │ Artwork  │  │  │ [<] [||] [>]           │  │   │ [vol] ━━━━  │  │
│  │ Title    │  │  │ 1:23 ━━━━━━━━━━ 3:45   │  │   └─────────────┘  │
│  │ Artist   │  │  └────────────────────────┘  │                     │
│  └──────────┘  │                              │                     │
│   w-64         │     flex-1 max-w-xl          │       w-32          │
└────────────────┴──────────────────────────────┴─────────────────────┘
```

**Accessibility Attributes:**
- role="region" aria-label="Audio player"
- Play button: aria-label={isPlaying ? 'Pause' : 'Play'}
- Seek slider: aria-label="Seek"
- Volume slider: aria-label="Volume"

## Deep Dive: Search Experience (5 minutes)

### Debounced Search with Autocomplete

**SearchBar Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                      SearchBar State                                 │
├─────────────────────────────────────────────────────────────────────┤
│  query: string                                                       │
│  results: SearchResults | null                                       │
│  isOpen: boolean                                                     │
│  selectedIndex: number                                               │
└─────────────────────────────────────────────────────────────────────┘
```

**Search Flow:**

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ User types   │───▶│ useDebounce  │───▶│ API search   │
│ in input     │    │ (300ms)      │    │ if len >= 2  │
└──────────────┘    └──────────────┘    └──────┬───────┘
                                               │
                                               ▼
                                        ┌──────────────┐
                                        │ setResults   │
                                        │ selectedIdx=0│
                                        └──────────────┘
```

**Keyboard Navigation:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Key          │ Action                                              │
├───────────────┼─────────────────────────────────────────────────────┤
│  ArrowDown    │ selectedIndex = min(index + 1, totalItems - 1)      │
│  ArrowUp      │ selectedIndex = max(index - 1, 0)                   │
│  Enter        │ selectResult(selectedIndex) - play or navigate      │
│  Escape       │ close dropdown, blur input                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Results Dropdown Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Search Results Dropdown                                             │
├─────────────────────────────────────────────────────────────────────┤
│  TOP RESULT (if exists)                                              │
│  └── TopResultCard                                                  │
├─────────────────────────────────────────────────────────────────────┤
│  SONGS                                                               │
│  ├── SearchResultRow (track, onClick: playTrack)                    │
│  ├── SearchResultRow                                                │
│  └── ...                                                            │
├─────────────────────────────────────────────────────────────────────┤
│  ALBUMS                                                              │
│  ├── SearchResultRow (album, onClick: navigate)                     │
│  └── ...                                                            │
└─────────────────────────────────────────────────────────────────────┘
```

**ARIA Attributes:**
- role="combobox" on input
- aria-expanded={isOpen && results !== null}
- aria-controls="search-results"
- aria-activedescendant={`result-${selectedIndex}`}
- role="listbox" on results container

## Deep Dive: Library with Virtualization (5 minutes)

### Virtualized Track Grid

**LibraryGrid Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                      LibraryGrid                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Data                                                                │
│  └── tracks from useLibraryStore()                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Responsive Columns                                                  │
│  ├── < 640px: 2 columns                                             │
│  ├── < 1024px: 3 columns                                            │
│  ├── < 1280px: 4 columns                                            │
│  └── >= 1280px: 5 columns                                           │
├─────────────────────────────────────────────────────────────────────┤
│  Virtualizer Config                                                  │
│  ├── count: Math.ceil(tracks.length / columns)                      │
│  ├── estimateSize: () => 220 (row height)                           │
│  └── overscan: 3                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Virtualization Strategy:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Parent Container (h-full overflow-auto)                             │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Virtual Container (height = totalSize, position: relative)      ││
│  │  ┌───────────────────────────────────────────────────────────┐  ││
│  │  │  Virtual Row (position: absolute, translateY)              │  ││
│  │  │  ├── AlbumCard                                            │  ││
│  │  │  ├── AlbumCard                                            │  ││
│  │  │  └── ... (columns per row)                                │  ││
│  │  └───────────────────────────────────────────────────────────┘  ││
│  │  (only visible + overscan rows rendered)                         ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

**Row Rendering:**

```
For each virtualRow:
  startIndex = virtualRow.index * columns
  rowTracks = tracks.slice(startIndex, startIndex + columns)

  Render:
  ┌──────────┬──────────┬──────────┬──────────┬──────────┐
  │ AlbumCard│ AlbumCard│ AlbumCard│ AlbumCard│ AlbumCard│
  │ (flex-1) │ (flex-1) │ (flex-1) │ (flex-1) │ (flex-1) │
  └──────────┴──────────┴──────────┴──────────┴──────────┘
```

### Album Card Component

**AlbumCard Structure:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  AlbumCard (group cursor-pointer)                                    │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Album Artwork (aspect-square)                                   ││
│  │  ┌──────────────────────────────────────────────────────┐      ││
│  │  │                                                       │      ││
│  │  │                    <img>                              │      ││
│  │  │                                                       │      ││
│  │  │                               ┌──────────────┐       │      ││
│  │  │                               │ Play Button  │       │      ││
│  │  │                               │ (on hover)   │       │      ││
│  │  │                               └──────────────┘       │      ││
│  │  └──────────────────────────────────────────────────────┘      ││
│  └─────────────────────────────────────────────────────────────────┘│
│  │  Title (truncate)                                                │
│  │  Artist (text-sm text-zinc-400 truncate)                         │
└─────────────────────────────────────────────────────────────────────┘
```

**Play Button Animation:**
- Hidden by default: opacity-0 translate-y-2
- On hover: opacity-100 translate-y-0
- Transition: transform, opacity (200ms)

## Keyboard Shortcuts (3 minutes)

### Global Keyboard Handler

```
┌─────────────────────────────────────────────────────────────────────┐
│  useKeyboardShortcuts()                                              │
├─────────────────────────────────────────────────────────────────────┤
│  Ignores input when:                                                 │
│  - target is HTMLInputElement                                        │
│  - target is HTMLTextAreaElement                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Key Mappings                                                        │
│  ├── Space ──▶ toggle play/pause (e.preventDefault)                 │
│  ├── Cmd/Ctrl + ArrowRight ──▶ next()                               │
│  ├── Cmd/Ctrl + ArrowLeft ──▶ previous()                            │
│  └── Cmd/Ctrl + F ──▶ focus search input                            │
└─────────────────────────────────────────────────────────────────────┘
```

## Accessibility (3 minutes)

### Screen Reader Announcements

**LiveAnnouncer Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  <div role="status" aria-live="polite" aria-atomic="true">          │
│    "Now playing: {track.title} by {track.artist.name}"              │
│  </div>                                                              │
│  (class: sr-only - visually hidden but read by screen readers)      │
└─────────────────────────────────────────────────────────────────────┘
```

### Focus Management

**useFocusTrap Hook:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Focus Trap Behavior (when isActive)                                 │
├─────────────────────────────────────────────────────────────────────┤
│  1. Query all focusable elements in container                        │
│     - button, [href], input, select, textarea, [tabindex!=-1]       │
├─────────────────────────────────────────────────────────────────────┤
│  2. On Tab key:                                                      │
│     - Shift+Tab on first element ──▶ focus last element             │
│     - Tab on last element ──▶ focus first element                   │
├─────────────────────────────────────────────────────────────────────┤
│  3. Auto-focus first element on activation                           │
└─────────────────────────────────────────────────────────────────────┘
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

**LazyImage Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  LazyImage Behavior                                                  │
├─────────────────────────────────────────────────────────────────────┤
│  1. Create IntersectionObserver (rootMargin: 200px)                  │
│  2. When element enters viewport: setIsInView(true)                  │
│  3. Render <img> only when isInView                                  │
│  4. Fade in on load: opacity 0 ──▶ 1 (300ms transition)             │
└─────────────────────────────────────────────────────────────────────┘
```

### Memoized Track List

**TrackRow Component:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  memo(TrackRow)                                                      │
├─────────────────────────────────────────────────────────────────────┤
│  ┌────┬──────────┬────────────────────────┬──────────┐              │
│  │ #  │ Artwork  │ Title / Artist          │ Duration │              │
│  │    │          │ (highlight if playing)  │          │              │
│  └────┴──────────┴────────────────────────┴──────────┘              │
├─────────────────────────────────────────────────────────────────────┤
│  Memoization: Only re-render if track.id changes                     │
│  isPlaying conditional styling: text-pink-500                        │
└─────────────────────────────────────────────────────────────────────┘
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
