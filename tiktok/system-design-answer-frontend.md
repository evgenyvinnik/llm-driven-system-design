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
┌─────────────────────────────────────────────────────────────────┐
│  <App>                                                          │
│  ├── <Router>                                                   │
│  │   ├── <FeedPage>               /                             │
│  │   │   ├── <VirtualizedFeed>                                  │
│  │   │   │   └── <VideoCard>      Single video container        │
│  │   │   │       ├── <VideoPlayer>                              │
│  │   │   │       ├── <EngagementBar>                            │
│  │   │   │       └── <VideoInfo>                                │
│  │   │   └── <CommentsSheet>      Bottom sheet overlay          │
│  │   │                                                          │
│  │   ├── <DiscoverPage>           /discover                     │
│  │   │   ├── <SearchBar>                                        │
│  │   │   ├── <TrendingHashtags>                                 │
│  │   │   └── <CategoryGrid>                                     │
│  │   │                                                          │
│  │   ├── <UploadPage>             /upload                       │
│  │   │   ├── <VideoCapture>                                     │
│  │   │   ├── <VideoTrimmer>                                     │
│  │   │   ├── <EffectsPanel>                                     │
│  │   │   └── <PublishForm>                                      │
│  │   │                                                          │
│  │   ├── <ProfilePage>            /profile/:userId              │
│  │   │   ├── <ProfileHeader>                                    │
│  │   │   └── <VideoGrid>                                        │
│  │   │                                                          │
│  │   └── <CreatorStudioPage>      /creator/analytics            │
│  │       ├── <PerformanceChart>                                 │
│  │       ├── <AudienceInsights>                                 │
│  │       └── <VideoAnalyticsTable>                              │
│  │                                                              │
│  ├── <BottomNav>                                                │
│  └── <ToastContainer>                                           │
└─────────────────────────────────────────────────────────────────┘
```

### State Management (Zustand)

**FeedState Store:**

| Field | Type | Purpose |
|-------|------|---------|
| videos | Video[] | Feed video list |
| currentIndex | number | Currently visible video |
| isLoading | boolean | Fetch state |
| hasMore | boolean | More pages available |

**FeedState Actions:**
- `fetchNextPage()` - Load next batch of videos
- `setCurrentIndex(index)` - Track current video for autoplay
- `updateVideo(id, updates)` - Update video state after engagement

**EngagementState Store:**

| Field | Type | Purpose |
|-------|------|---------|
| pendingLikes | Set<string> | Optimistic update tracking |
| pendingComments | Map<string, Comment[]> | Pending comment submissions |

**EngagementState Actions:**
- `likeVideo(videoId)` - Like with optimistic UI
- `unlikeVideo(videoId)` - Unlike with optimistic UI
- `addComment(videoId, text)` - Submit comment

**UserState Store:**

| Field | Type | Purpose |
|-------|------|---------|
| user | User or null | Current user |
| isNewUser | boolean | Cold start flag |
| preferences | UserPreferences | Interest settings |
| watchHistory | WatchedVideo[] | Viewed videos |

**UserState Actions:**
- `trackWatch(videoId, duration)` - Record watch time for recommendations

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

**VirtualizedFeed Component Responsibilities:**

1. Create container ref for scroll element
2. Get videos, fetchNextPage, hasMore, setCurrentIndex from store
3. Calculate container height (window.innerHeight or 800px fallback)
4. Initialize virtualizer with count, scroll element, estimateSize, overscan: 1
5. Effect: Trigger fetchNextPage when last item index >= videos.length - 3
6. Effect: Track current video by finding which video's center is in view
7. Render container with snap scrolling enabled
8. Render total size spacer with relative positioning
9. Map virtual items to absolutely positioned VideoCard components
10. Pass isActive prop based on currentIndex match

**Virtualizer Configuration:**

| Option | Value | Rationale |
|--------|-------|-----------|
| count | videos.length | Total items to virtualize |
| getScrollElement | containerRef.current | Scroll container |
| estimateSize | () => containerHeight | Full-screen videos |
| overscan | 1 | Minimal extra rendering |

**Snap Scrolling Behavior:**

- Container: `scroll-snap-type: y mandatory` for forced snapping
- Container: `overscroll-behavior-y: contain` to prevent pull-to-refresh
- Video card: `scroll-snap-align: start` aligns top of video
- Video card: `scroll-snap-stop: always` forces stop at each video

**Why `overscan: 1`:**
- Videos are the heaviest DOM elements (video decoder, large images)
- Rendering 2+ off-screen videos wastes memory significantly
- With snap scrolling, user can only move one video at a time
- Preloading handles the next video's data, not DOM element

---

### Deep Dive 2: Video Player with Preloading (10 minutes)

**VideoPlayer Component Props:**

| Prop | Type | Purpose |
|------|------|---------|
| video | Video | Video data object |
| isActive | boolean | Whether video is current |
| onProgress | (watched, total) => void | Watch time callback |

**VideoPlayer Internal State:**

| State | Type | Initial | Purpose |
|-------|------|---------|---------|
| isPlaying | boolean | false | Play/pause state |
| isMuted | boolean | true | Start muted for autoplay |
| showControls | boolean | false | Pause overlay visibility |

**VideoPlayer Component Responsibilities:**

1. Create video element ref
2. Effect (isActive changes): If active, reset currentTime to 0, call play(), update isPlaying. If inactive, pause and set isPlaying false
3. Effect (timeupdate): When active, call onProgress with currentTime and duration
4. Handle tap: Toggle play/pause state, show/hide controls overlay
5. Handle double-tap: Detect via timing (< 300ms between taps), trigger heart animation at tap position
6. Render video element with loop, muted, playsInline, preload="metadata"
7. Render pause overlay with play icon when paused and controls visible
8. Render progress bar at bottom
9. Render sound toggle button with muted/unmuted icon

**Preloading Strategy:**

**useVideoPreload Hook Responsibilities:**

1. Get videos and currentIndex from feed store
2. Maintain Set of preloaded video IDs (ref)
3. Effect (currentIndex changes):
   - Preload videos at currentIndex + 1 and currentIndex + 2
   - For each video not already preloaded:
     - Create hidden video element with preload="auto"
     - Set src and muted
     - On loadeddata, add to preloaded set
     - Cleanup: clear src and remove element after 5 seconds
   - Preload thumbnails for next 5 videos using Image objects

**Preloading Flow:**
```
┌──────────────────────────────────────────────────────────────┐
│  Current video index changes                                  │
│         │                                                     │
│         ▼                                                     │
│  ┌─────────────────┐                                         │
│  │ Check indices   │  currentIndex + 1, currentIndex + 2     │
│  │ to preload      │                                         │
│  └────────┬────────┘                                         │
│           ▼                                                   │
│  ┌─────────────────┐    Already       ┌─────────────────┐    │
│  │ Already in      │───preloaded────▶│ Skip            │    │
│  │ preloadedRef?   │                  │                 │    │
│  └────────┬────────┘                  └─────────────────┘    │
│           │ Not preloaded                                    │
│           ▼                                                   │
│  ┌─────────────────┐                                         │
│  │ Create hidden   │  preload="auto", muted                  │
│  │ video element   │                                         │
│  └────────┬────────┘                                         │
│           ▼                                                   │
│  ┌─────────────────┐    ┌─────────────────┐                  │
│  │ On loadeddata   │───▶│ Add to          │                  │
│  │ event           │    │ preloadedRef    │                  │
│  └────────┬────────┘    └─────────────────┘                  │
│           ▼                                                   │
│  ┌─────────────────┐                                         │
│  │ After 5s:       │  Clear src, remove element              │
│  │ cleanup element │                                         │
│  └─────────────────┘                                         │
│                                                              │
│  Simultaneously: Preload thumbnails for next 5 videos        │
└──────────────────────────────────────────────────────────────┘
```

**Why Preload Only 2 Videos:**
- Mobile data constraints
- Memory limits on phones
- 2 videos covers swipe latency
- Thumbnail preload extends visible range cheaply

---

### Deep Dive 3: Engagement UI with Optimistic Updates (8 minutes)

**LikeButton Component Props:**

| Prop | Type | Purpose |
|------|------|---------|
| videoId | string | Video identifier |
| isLiked | boolean | Server-confirmed like state |
| likeCount | number | Server-confirmed count |

**LikeButton Internal State:**

| State | Type | Purpose |
|-------|------|---------|
| showBurst | boolean | Controls particle burst animation |

**Optimistic State Calculation:**
- `isPending = pendingLikes.has(videoId)` - Check if in-flight
- `optimisticLiked = isPending ? !isLiked : isLiked` - Invert if pending
- `optimisticCount = isPending ? (isLiked ? count - 1 : count + 1) : count`

**LikeButton Component Responsibilities:**

1. Get likeVideo, unlikeVideo, pendingLikes from engagement store
2. Calculate optimistic state based on pending status
3. Handle click: If optimistically liked, call unlikeVideo. Otherwise, trigger burst animation (800ms), call likeVideo
4. Render button with disabled when pending
5. Render heart icon with scale animation on like (1 -> 1.3 -> 1, 0.3s)
6. Render heart fill color: red when liked, white outline when not
7. AnimatePresence for burst animation with 6 particles
8. Each particle animates outward at 60-degree intervals
9. Render formatted count below icon

**Count Formatting:**
- >= 1,000,000: Show as "X.XM"
- >= 1,000: Show as "X.XK"
- < 1,000: Show exact number

**Optimistic Update Flow (Engagement Store):**

```
┌──────────────────────────────────────────────────────────────┐
│  User clicks like                                             │
│         │                                                     │
│         ▼                                                     │
│  ┌─────────────────┐                                         │
│  │ Add videoId to  │  Triggers optimistic UI change          │
│  │ pendingLikes    │                                         │
│  └────────┬────────┘                                         │
│           ▼                                                   │
│  ┌─────────────────┐                                         │
│  │ POST /api/      │  API call                               │
│  │ videos/:id/like │                                         │
│  └────────┬────────┘                                         │
│           │                                                   │
│     ┌─────┴─────┐                                            │
│     ▼           ▼                                             │
│  Success     Failure                                          │
│     │           │                                             │
│     ▼           ▼                                             │
│  ┌───────┐  ┌─────────────────┐                              │
│  │Update │  │ Rollback        │  UI reverts automatically    │
│  │feed   │  │ (pendingLikes   │  when pending removed        │
│  │store  │  │ removal only)   │                              │
│  └───┬───┘  └────────┬────────┘                              │
│      │               │                                        │
│      └───────┬───────┘                                        │
│              ▼                                                │
│  ┌─────────────────┐                                         │
│  │ Remove from     │  Always executed in finally block       │
│  │ pendingLikes    │                                         │
│  └─────────────────┘                                         │
└──────────────────────────────────────────────────────────────┘
```

**Double-Tap Heart Animation:**

**DoubleTapHeart Component:**
- Positioned absolutely at tap coordinates (x - 50, y - 50)
- Initial: scale(0), opacity(1)
- Animate: scale(1.5), opacity(0) over 0.8s
- Renders large white heart icon with drop shadow
- pointer-events: none to avoid blocking interaction

---

### Deep Dive 4: Cold Start Onboarding UI (5 minutes)

**Interest Categories:**

| ID | Label | Emoji |
|----|-------|-------|
| comedy | Comedy | laughing face |
| music | Music | musical notes |
| dance | Dance | dancer |
| food | Food | pizza |
| sports | Sports | soccer ball |
| pets | Pets | dog |
| diy | DIY | hammer |
| beauty | Beauty | lipstick |
| gaming | Gaming | game controller |
| travel | Travel | airplane |
| fitness | Fitness | flexed bicep |
| tech | Tech | mobile phone |

**InterestSelector Component Props:**

| Prop | Type | Purpose |
|------|------|---------|
| onComplete | (interests: string[]) => void | Callback with selected interests |

**InterestSelector Internal State:**
- `selected: Set<string>` - Currently selected interest IDs

**InterestSelector Component Responsibilities:**

1. Maintain Set of selected interest IDs
2. Toggle function: Add or remove ID from Set
3. Handle continue: Call onComplete with Array from Set
4. Render title "What are you interested in?"
5. Render subtitle "Select 3 or more to personalize your feed"
6. Render 3-column grid of interest buttons
7. Each button shows emoji and label
8. Selected buttons: pink background, white text
9. Unselected buttons: gray background, gray text
10. Button tap animation: scale(0.95)
11. Continue button: disabled when selected.size < 3
12. Continue button: gray when disabled, pink when enabled
13. Display "Continue (X/3 selected)" with count

**Implicit Preference Learning (useWatchTracking Hook):**

**Hook Responsibilities:**
1. Maintain ref for start time
2. Effect (isActive changes):
   - If becoming active: Record start time
   - If becoming inactive: Calculate duration, call trackWatch, clear start time

**NewUserFeedbackOverlay Component:**
- Only renders when isNewUser is true
- Positioned at top of screen
- Dark semi-transparent background
- Title: "We're learning your taste!"
- Subtitle: "Keep scrolling - we'll personalize your feed based on what you watch."

---

### Deep Dive 5: Creator Analytics Dashboard (5 minutes)

**PerformanceChart Component Props:**

| Prop | Type | Purpose |
|------|------|---------|
| data | AnalyticsData[] | Time-series data |
| metric | 'views' or 'likes' or 'shares' or 'comments' | Metric to display |

**Metric Colors:**

| Metric | Color |
|--------|-------|
| views | Blue (#3B82F6) |
| likes | Red (#EF4444) |
| shares | Green (#10B981) |
| comments | Amber (#F59E0B) |

**PerformanceChart Component Responsibilities:**

1. Memoize chart data transformation (date formatting, metric extraction)
2. Render ResponsiveContainer with LineChart
3. Render CartesianGrid with dashed stroke in gray
4. Render XAxis with date labels, gray stroke
5. Render YAxis with formatted count, gray stroke
6. Render Tooltip with dark background, rounded corners
7. Render Line with monotone curve, metric color, no dots, 2px stroke

**VideoAnalyticsTable Component:**

**Table Columns:**

| Column | Alignment | Content |
|--------|-----------|---------|
| Video | Left | Thumbnail + description |
| Views | Right | Formatted count |
| Avg Watch | Right | Formatted duration |
| Completion | Right | CompletionBadge component |
| Likes | Right | Formatted count |
| Shares | Right | Formatted count |

**VideoAnalyticsTable Component Responsibilities:**

1. Render overflow-x-auto wrapper for horizontal scroll
2. Render table with gray text
3. Render thead with border-bottom
4. Map videos to table rows with border-bottom and hover effect
5. Video cell: thumbnail (12x9 rounded) + 2-line clamped description
6. All count cells: formatted with formatCount helper
7. Duration cell: formatted with formatDuration helper
8. Completion cell: CompletionBadge with rate prop

**CompletionBadge Component:**

| Rate Range | Color | Background |
|------------|-------|------------|
| > 70% | Green | green-500/20 |
| 40-70% | Yellow | yellow-500/20 |
| < 40% | Red | red-500/20 |

- Displays rate as percentage (rounded)
- Small pill shape with colored text on tinted background

---

## Step 4: Responsive Design (3 minutes)

**Mobile-First Layout (Base Styles):**

| Element | Styles |
|---------|--------|
| Feed container | Full screen height and width, overflow hidden |
| Video card | Full height and width, relative positioning |
| Engagement bar | Absolute right-3, bottom-24, flex column, gap-4 |

**Tablet Landscape (min-width: 768px, orientation: landscape):**

| Element | Change |
|---------|--------|
| Feed container | max-width: 2xl (672px), centered |

**Desktop (min-width: 1024px):**

| Element | Change |
|---------|--------|
| Layout | Flex row |
| Sidebar | 256px fixed width |
| Feed container | max-width: lg (512px), centered |
| Engagement bar | Positioned outside video (right: -80px) |

---

## Step 5: Accessibility (2 minutes)

**Accessible Video Controls:**

| ARIA Attribute | Element | Value |
|----------------|---------|-------|
| role="region" | Video container | Landmark for screen readers |
| aria-label | Video container | "Video by {username}" |
| aria-describedby | Video element | References hidden description |
| aria-label | Captions button | "Toggle captions" |
| aria-pressed | Captions button | Current captions state |

**Hidden Description (sr-only):**
- Video description text
- Duration in seconds
- Like count
- Comment count

**Reduced Motion Preference:**

- Query `prefers-reduced-motion: reduce` media feature
- When true: Disable scale animations on like button
- When true: Return empty animation object from motion components

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
