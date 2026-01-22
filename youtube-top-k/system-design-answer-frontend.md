# YouTube Top K Videos - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design the frontend for a real-time trending videos dashboard that displays Top K videos across categories with live updates. The core frontend challenges are: building a responsive trending grid that handles real-time SSE updates without jarring reflows, implementing smooth category filtering with animated transitions, and designing an engaging video card component with view count animations. I'll focus on the component architecture, state management with Zustand, and performance optimizations for handling frequent data updates."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Trending Display**: Show Top 10 videos per category in an engaging grid
- **Category Filtering**: Quick switching between categories (all, music, gaming, etc.)
- **Real-time Updates**: Live view count updates via SSE connection
- **Video Details**: Thumbnails, titles, view counts, rank indicators
- **View Simulation**: Button to simulate views for testing

### Non-Functional Requirements
- **Responsiveness**: Works on mobile, tablet, and desktop
- **Performance**: Smooth 60fps animations during updates
- **Accessibility**: Keyboard navigation, screen reader support
- **Offline**: Graceful degradation when SSE disconnects

### UI/UX Considerations
- **Visual feedback**: Rank changes should be animated
- **View count animation**: Numbers should count up smoothly
- **Loading states**: Skeleton screens while data loads
- **Error handling**: Clear messages when connection fails

### Key Frontend Questions
1. How frequently do rankings change? (affects animation strategy)
2. Should we show rank change indicators (+2, -1)?
3. What interaction triggers a video view?

---

## Component Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                         App Shell                                │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                       Header                                │ │
│  │  Logo    |    Category Tabs    |    Connection Status      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                   TrendingDashboard                         │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              CategoryTabs                            │   │ │
│  │  │  [ All ] [ Music ] [ Gaming ] [ Sports ] [ News ]   │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                             │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              TrendingGrid                            │   │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │ │
│  │  │  │VideoCard │ │VideoCard │ │VideoCard │            │   │ │
│  │  │  │  #1      │ │  #2      │ │  #3      │            │   │ │
│  │  │  └──────────┘ └──────────┘ └──────────┘            │   │ │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │   │ │
│  │  │  │VideoCard │ │VideoCard │ │VideoCard │            │   │ │
│  │  │  │  #4      │ │  #5      │ │  #6      │            │   │ │
│  │  │  └──────────┘ └──────────┘ └──────────┘            │   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  │                                                             │ │
│  │  ┌─────────────────────────────────────────────────────┐   │ │
│  │  │              ViewSimulator                           │   │ │
│  │  │  Select Video  [ v ]  [ +1 View ] [ +100 ] [ Random]│   │ │
│  │  └─────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                       Stats Bar                             │ │
│  │  Connected: [green dot] Live  |  Updated 2s ago  |  10K    │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Component Tree

```
┌─────────────────────────────────────────────────────────────────┐
│  src/                                                            │
│  ├── routes/                                                     │
│  │   ├── __root.tsx           ──▶ App shell with SSE provider   │
│  │   ├── index.tsx            ──▶ Trending dashboard page       │
│  │   └── video.$id.tsx        ──▶ Individual video page         │
│  ├── components/                                                 │
│  │   ├── trending/                                               │
│  │   │   ├── TrendingDashboard.tsx                              │
│  │   │   ├── TrendingGrid.tsx                                   │
│  │   │   ├── VideoCard.tsx                                      │
│  │   │   └── CategoryTabs.tsx                                   │
│  │   ├── common/                                                 │
│  │   │   ├── AnimatedNumber.tsx                                 │
│  │   │   ├── RankBadge.tsx                                      │
│  │   │   ├── ConnectionStatus.tsx                               │
│  │   │   └── SkeletonCard.tsx                                   │
│  │   └── simulator/                                              │
│  │       └── ViewSimulator.tsx                                  │
│  ├── hooks/                                                      │
│  │   ├── useSSE.ts                                              │
│  │   ├── useTrending.ts                                         │
│  │   └── useAnimatedValue.ts                                    │
│  ├── stores/                                                     │
│  │   └── trendingStore.ts                                       │
│  └── services/                                                   │
│      └── api.ts                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: SSE Connection Hook (8 minutes)

### Robust SSE Hook with Reconnection

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         useSSE Hook                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Options:                                                                │
│  ├── url: string                                                        │
│  ├── onMessage?: (data: unknown) => void                                │
│  ├── onError?: (error: Event) => void                                   │
│  ├── reconnectInterval?: number (default: 3000)                         │
│  └── maxReconnectAttempts?: number (default: 10)                        │
│                                                                          │
│  Lifecycle:                                                              │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  useEffect ──▶ connect()                                         │    │
│  │                   │                                              │    │
│  │                   ▼                                              │    │
│  │    new EventSource(url)                                          │    │
│  │         │                                                        │    │
│  │         ├── onopen ──▶ setConnected(true)                        │    │
│  │         │              reset reconnectAttempts                   │    │
│  │         │                                                        │    │
│  │         ├── onmessage ──▶ parse JSON                             │    │
│  │         │                 setLastEventTime(now)                  │    │
│  │         │                 setTrending(data)                      │    │
│  │         │                                                        │    │
│  │         └── onerror ──▶ setConnected(false)                      │    │
│  │                        close connection                          │    │
│  │                        schedule reconnect                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Reconnection Strategy:                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  if attempts < maxAttempts:                                      │    │
│  │    delay = reconnectInterval * 2^attempts                        │    │
│  │    delay = min(delay, 30000)  // cap at 30 seconds              │    │
│  │    setTimeout(connect, delay)                                    │    │
│  │  else:                                                           │    │
│  │    stop trying, show "Reconnect" button                          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Return:                                                                 │
│  ├── isConnected: boolean                                               │
│  ├── reconnectAttempts: number                                          │
│  ├── lastEventTime: Date | null                                         │
│  └── reconnect: () => void  (manual reconnect trigger)                  │
└─────────────────────────────────────────────────────────────────────────┘
```

> "Exponential backoff is essential for SSE reconnection. Starting at 3 seconds and doubling each attempt (capped at 30s) prevents hammering the server while still recovering quickly from transient failures. The manual reconnect button gives users control when auto-reconnect is exhausted."

### Connection Status Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ConnectionStatus Component                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Connected State:                                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [green dot, animate-pulse]  "Live"   "Updated 2 seconds ago"     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Disconnected State:                                                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [red dot]  "Disconnected"   [Reconnect (3)]                      │  │
│  │                              blue button with attempt count       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Uses formatDistanceToNow from date-fns for relative time               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Zustand Store with Optimistic Updates (7 minutes)

### Trending Store Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TrendingStore                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                                                                  │
│  ├── isConnected: boolean                                               │
│  ├── lastEventTime: Date | null                                         │
│  ├── trending: Record<category, CategoryTrending>                       │
│  │   └── CategoryTrending: { videos: Video[], computedAt: Date }       │
│  ├── previousTrending: Record<category, CategoryTrending>              │
│  ├── selectedCategory: string (default: 'all')                         │
│  └── isLoading: boolean                                                 │
│                                                                          │
│  Video Shape:                                                            │
│  ├── videoId: string                                                    │
│  ├── title: string                                                      │
│  ├── viewCount: number                                                  │
│  ├── rank: number                                                       │
│  ├── previousRank?: number  (calculated on update)                      │
│  ├── thumbnail?: string                                                 │
│  └── category?: string                                                  │
│                                                                          │
│  Key Action: setTrending(data)                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  For each category in data:                                      │    │
│  │    1. Get previous videos for this category                      │    │
│  │    2. For each video in new data:                                │    │
│  │       - Find matching video in previous                          │    │
│  │       - Set previousRank = old video's rank                      │    │
│  │    3. Store enriched data                                        │    │
│  │                                                                  │    │
│  │  set({                                                           │    │
│  │    previousTrending: currentTrending,                            │    │
│  │    trending: enrichedData,                                       │    │
│  │    isLoading: false                                              │    │
│  │  })                                                              │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Selectors for Performance

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Zustand Selectors                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  useCurrentCategoryVideos():                                             │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  useTrendingStore(state =>                                       │    │
│  │    state.trending[state.selectedCategory]?.videos || []          │    │
│  │  )                                                               │    │
│  │                                                                  │    │
│  │  Only re-renders when selected category's videos change          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  useVideoRankChange(videoId):                                            │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Returns: { current, previous, change, isNew }                   │    │
│  │                                                                  │    │
│  │  - current: number (current rank)                                │    │
│  │  - previous: number | undefined                                  │    │
│  │  - change: number (previous - current, positive = moved up)     │    │
│  │  - isNew: boolean (no previous rank found)                       │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

> "Keeping previousTrending in state enables rank change animations. When new data arrives, we compare against previous to calculate deltas. The subscribeWithSelector middleware ensures components only re-render when their specific slice of state changes."

---

## Deep Dive: Animated Video Card (8 minutes)

### AnimatedNumber Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AnimatedNumber Component                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Props:                                                                  │
│  ├── value: number                                                      │
│  ├── duration?: number (default: 500ms)                                 │
│  ├── formatFn?: (value: number) => string                               │
│  └── className?: string                                                 │
│                                                                          │
│  Animation Logic:                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  useEffect on [value] change:                                    │    │
│  │    startValue = previousValue.current                            │    │
│  │    endValue = value                                              │    │
│  │    startTime = performance.now()                                 │    │
│  │                                                                  │    │
│  │    animate = (currentTime) => {                                  │    │
│  │      elapsed = currentTime - startTime                           │    │
│  │      progress = min(elapsed / duration, 1)                       │    │
│  │                                                                  │    │
│  │      // Ease-out cubic for natural deceleration                  │    │
│  │      eased = 1 - pow(1 - progress, 3)                            │    │
│  │                                                                  │    │
│  │      current = round(startValue + (endValue - startValue) * eased) │  │
│  │      setDisplayValue(current)                                    │    │
│  │                                                                  │    │
│  │      if progress < 1: requestAnimationFrame(animate)             │    │
│  │      else: previousValue.current = endValue                      │    │
│  │    }                                                             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Output: <span aria-live="polite">{formatFn(displayValue)}</span>       │
└─────────────────────────────────────────────────────────────────────────┘
```

### RankBadge with Change Indicator

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      RankBadge Component                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Visual Structure:                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                                                                  │    │
│  │     ┌───────────┐                                               │    │
│  │     │     1     │  ──▶ Rank number in circle                    │    │
│  │     │  (gold)   │      Gold for #1, Silver for #2, Bronze #3    │    │
│  │     └───────────┘      Gray for #4+                             │    │
│  │          │                                                       │    │
│  │          └──── [+2]  ──▶ Change indicator (if rank changed)     │    │
│  │                         Green bg for up, Red bg for down        │    │
│  │                         animate-bounce for 3 seconds            │    │
│  │                                                                  │    │
│  │          └──── [NEW] ──▶ If video just entered Top K            │    │
│  │                         Blue bg                                  │    │
│  │                                                                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Badge Colors by Rank:                                                   │
│  ├── #1 ──▶ bg-yellow-500 text-white (gold)                             │
│  ├── #2 ──▶ bg-gray-400 text-white (silver)                             │
│  ├── #3 ──▶ bg-amber-600 text-white (bronze)                            │
│  └── #4+ ──▶ bg-gray-200 text-gray-700                                  │
│                                                                          │
│  Change indicator auto-hides after 3 seconds via setTimeout             │
└─────────────────────────────────────────────────────────────────────────┘
```

### VideoCard Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       VideoCard Component                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <article> (hover: shadow-lg scale-[1.02])                        │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │  Thumbnail (aspect-video)                                    │ │  │
│  │  │                                                              │ │  │
│  │  │  ┌─────────┐                        ┌─────────┐             │ │  │
│  │  │  │ #1 RANK │                        │  3:45   │             │ │  │
│  │  │  │ +badge  │                        │duration │             │ │  │
│  │  │  └─────────┘                        └─────────┘             │ │  │
│  │  │      top-left                           bottom-right        │ │  │
│  │  │                                                              │ │  │
│  │  │           ┌───────────────────────┐                         │ │  │
│  │  │           │       [ PLAY ]        │  (on hover)             │ │  │
│  │  │           │    white circle       │  simulates view         │ │  │
│  │  │           └───────────────────────┘                         │ │  │
│  │  │                                                              │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────────┐ │  │
│  │  │  Title (line-clamp-2, min-h-[2.5rem])                       │ │  │
│  │  │  Channel Name (text-sm text-gray-500)                       │ │  │
│  │  │                                                              │ │  │
│  │  │  [eye] 1.2M views                        [fire] Trending    │ │  │
│  │  │        AnimatedNumber                     orange badge      │ │  │
│  │  └─────────────────────────────────────────────────────────────┘ │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  memo() wrapped to prevent unnecessary re-renders                        │
│  Uses lazy loading for thumbnails: loading="lazy"                       │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The view count uses AnimatedNumber with ease-out-cubic easing so changes feel natural - fast at first, then settling. For thumbnails, I use a placeholder gradient when no image exists, maintaining consistent card sizing."

---

## Deep Dive: Category Tabs with Animated Underline (5 minutes)

### CategoryTabs Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CategoryTabs Component                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Categories:                                                             │
│  ├── all ──▶ "All" [star emoji]                                         │
│  ├── music ──▶ "Music" [music note]                                     │
│  ├── gaming ──▶ "Gaming" [controller]                                   │
│  ├── sports ──▶ "Sports" [soccer ball]                                  │
│  ├── news ──▶ "News" [newspaper]                                        │
│  └── education ──▶ "Education" [book]                                   │
│                                                                          │
│  Layout:                                                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <nav role="tablist" aria-label="Video categories">              │  │
│  │                                                                   │  │
│  │  [All]  [Music]  [Gaming]  [Sports]  [News]  [Education]         │  │
│  │   ^selected (text-blue-600)                                      │  │
│  │                                                                   │  │
│  │  ════════  <─── Animated underline                               │  │
│  │             position calculated from selected tab's offsetLeft    │  │
│  │             width matched to selected tab's offsetWidth          │  │
│  │             transition-all duration-300 ease-out                 │  │
│  │                                                                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Implementation:                                                         │
│  ├── useRef<Map> to store button refs by category id                   │
│  ├── useLayoutEffect to update underline position on selection change  │
│  └── overflow-x-auto with scrollbar-hide for mobile                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### TrendingGrid with Layout Animations

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     TrendingGrid Component                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Uses @formkit/auto-animate for smooth reordering                        │
│                                                                          │
│  Grid Layout:                                                            │
│  ├── grid-cols-1 (mobile)                                               │
│  ├── sm:grid-cols-2 (tablet)                                            │
│  ├── lg:grid-cols-3 (laptop)                                            │
│  └── xl:grid-cols-4 (desktop)                                           │
│                                                                          │
│  States:                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  isLoading?                                                      │    │
│  │    ──▶ Render 8 SkeletonCards                                    │    │
│  │                                                                  │    │
│  │  videos.length === 0?                                            │    │
│  │    ──▶ Empty state: [chart emoji]                                │    │
│  │        "No trending videos yet"                                  │    │
│  │        "Start recording views to see trends"                     │    │
│  │                                                                  │    │
│  │  else:                                                           │    │
│  │    ──▶ Map videos to VideoCard components                        │    │
│  │        role="tabpanel" aria-live="polite"                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Skeleton Loading Card

```
┌─────────────────────────────────────────────────────────────────────────┐
│  SkeletonCard: animate-pulse wrapper                                     │
│  ├── [aspect-video bg-gray-200] ──▶ Thumbnail placeholder              │
│  ├── [w-3/4 h-4 bg-gray-200] ──▶ Title line                            │
│  ├── [w-1/2 h-4 bg-gray-200] ──▶ Channel name                          │
│  └── [w-1/4] x 2, justify-between ──▶ Stats placeholders               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: View Simulator Panel (4 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ViewSimulator Component                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Layout:                                                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  bg-gray-50 border-t                                              │  │
│  │                                                                   │  │
│  │  View Simulator                         (15 simulated)            │  │
│  │                                                                   │  │
│  │  [Select a video...  v]  [+1 View]  [+10] [+100] [+1000]         │  │
│  │        dropdown           blue btn    gray buttons                │  │
│  │                                                                   │  │
│  │                                              [Random x10]         │  │
│  │                                               purple btn          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Actions:                                                                │
│  ├── handleSingleView ──▶ api.recordView(videoId)                       │
│  │                        increment simulationCount                     │
│  │                                                                      │
│  ├── handleBulkViews(count) ──▶ api.recordBulkViews(videoId, count)    │
│  │                              add count to simulationCount            │
│  │                                                                      │
│  └── handleRandomViews ──▶ Pick 10 random videos from list            │
│                            Promise.all(api.recordView for each)         │
│                            add 10 to simulationCount                    │
│                                                                          │
│  Dropdown options show: "#{rank} - {title truncated to 40 chars}..."   │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The simulator is essential for testing without real traffic. Bulk view buttons let us quickly generate enough data to see rankings shift. The 'Random x10' distributes views across videos, making it easy to create competition for top spots."

---

## Trade-offs and Alternatives (3 minutes)

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Real-time connection | SSE | Simple, unidirectional | WebSocket for bidirectional |
| State management | Zustand | Lightweight, simple API | Redux for complex flows |
| Layout animations | auto-animate | Easy to use | Framer Motion for more control |
| Number animations | requestAnimationFrame | Smooth, 60fps | CSS transitions (less control) |
| Card updates | memo + key | Prevents unnecessary re-renders | Virtual list for 100+ cards |

### Performance Optimizations

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Performance Strategies                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. Memoize video cards                                                  │
│     export const VideoCard = memo(function VideoCard(props) {...})      │
│                                                                          │
│  2. Use selectors to minimize store subscriptions                        │
│     useTrendingStore(state =>                                           │
│       state.trending[state.selectedCategory]?.videos || []              │
│     )                                                                    │
│                                                                          │
│  3. Debounce rapid SSE updates if needed                                 │
│     const debouncedSetTrending = useMemo(                               │
│       () => debounce(setTrending, 100),                                 │
│       [setTrending]                                                     │
│     )                                                                    │
│                                                                          │
│  4. Use CSS containment for cards                                        │
│     .video-card { contain: layout style; }                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Accessibility Features (2 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Accessibility Implementation                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Keyboard Navigation for Category Tabs:                                  │
│  ├── ArrowRight ──▶ Select next category (wrap to first)               │
│  └── ArrowLeft  ──▶ Select previous category (wrap to last)            │
│                                                                          │
│  Screen Reader Announcements:                                            │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  <div role="status" aria-live="polite" className="sr-only">     │    │
│  │    {`${title} is now ranked #${rank}`}                          │    │
│  │  </div>                                                          │    │
│  │                                                                  │    │
│  │  Announces rank changes without visual disruption                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Focus Management for Video Cards:                                       │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  <article                                                        │    │
│  │    tabIndex={0}                                                  │    │
│  │    onKeyDown={(e) => e.key === 'Enter' && handlePlay()}         │    │
│  │    aria-label={`${title}, ranked #${rank}, ${viewCount} views`} │    │
│  │  >                                                               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary (1 minute)

"The YouTube Top K frontend is built around three key patterns:

1. **Robust SSE connection with auto-reconnect** - The useSSE hook handles connection lifecycle, exponential backoff reconnection, and updates the Zustand store when new trending data arrives.

2. **Animated updates with rank tracking** - The store tracks previous rankings to enable smooth animations. AnimatedNumber provides counting animations, RankBadge shows rank changes, and auto-animate handles grid reordering.

3. **Optimized component architecture** - VideoCards are memoized, selectors minimize re-renders, and skeleton loading provides good perceived performance.

The main trade-off is update frequency vs. visual stability. Rapid updates can cause jarring UI changes, so I'd implement debouncing or batch animations for high-frequency updates. For future improvements, I'd add keyboard shortcuts for power users, picture-in-picture video previews on hover, and offline support with service workers."
