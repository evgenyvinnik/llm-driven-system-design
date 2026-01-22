# Strava - Fitness Tracking Platform - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a fitness tracking platform like Strava, focusing on the frontend systems that handle GPS route visualization, activity feeds, interactive maps, and real-time leaderboards. This involves map rendering with Leaflet, efficient list virtualization, and responsive mobile-first design. Let me clarify requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements (Frontend Perspective)

1. **Activity Upload** - GPX file upload with progress indication and simulated activity creation
2. **Map Visualization** - Display GPS routes on interactive maps with elevation profiles
3. **Activity Feed** - Infinite-scrolling personalized feed with kudos and comments
4. **Segment Leaderboards** - Interactive leaderboards with filtering and personal records
5. **User Profiles** - Following/followers, activity history, personal statistics
6. **Achievement Display** - Badge grid with progress indicators

### Non-Functional Requirements

- **Performance** - Sub-100ms interactions, smooth map panning
- **Responsiveness** - Mobile-first design, works on all screen sizes
- **Accessibility** - WCAG 2.1 AA compliance for core features
- **Offline Support** - Cached feed viewing when offline (future)

### Frontend-Specific Considerations

- Map tile loading and caching strategy
- Large GPS point arrays (1000s of points per activity)
- Real-time kudos/comment updates
- Form validation for activity metadata

---

## 2. Technology Stack (3 minutes)

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | React 19 + Vite | Fast HMR, TypeScript support |
| Routing | TanStack Router | File-based routing, type-safe |
| State | Zustand | Minimal boilerplate, performant |
| Maps | Leaflet + React-Leaflet | Open source, widely supported |
| Styling | Tailwind CSS | Utility-first, consistent design |
| Data Fetching | TanStack Query | Caching, background refresh |
| Forms | React Hook Form | Performant, validation built-in |

---

## 3. Application Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              App Shell                                   │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         Navigation                                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │   │
│  │  │   Home   │  │ Explore  │  │ Segments │  │ Profile  │        │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Main Content                               │   │
│  │                                                                   │   │
│  │   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │
│  │   │  Activity   │  │   Map       │  │ Leaderboard │             │   │
│  │   │    Feed     │  │   View      │  │    Panel    │             │   │
│  │   └─────────────┘  └─────────────┘  └─────────────┘             │   │
│  │                                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Zustand Store                                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │   │
│  │  │   Auth   │  │Activities│  │ Segments │  │   Feed   │        │   │
│  │  │  Slice   │  │  Slice   │  │  Slice   │  │  Slice   │        │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Route Structure

| Route | Description |
|-------|-------------|
| / | Activity feed (home) |
| /explore | Public activities |
| /upload | Activity upload |
| /activity/:id | Activity detail with map |
| /segments | Segment explorer |
| /segment/:id | Segment detail with leaderboard |
| /profile/:username | User profile |
| /settings | User settings |
| /login | Authentication |

---

## 4. Component Architecture (8 minutes)

### Activity Feed Component

```
┌─────────────────────────────────────────────────────────────────┐
│                    VIRTUALIZED FEED                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  useInfiniteQuery (TanStack Query)                        │  │
│  │  ├── Cursor-based pagination                              │  │
│  │  └── getNextPageParam extracts cursor                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  useVirtualizer (TanStack Virtual)                        │  │
│  │  ├── Estimated row height: 400px                          │  │
│  │  ├── Overscan: 3 items                                    │  │
│  │  └── Dynamic measurement for varying heights              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Render Logic                                              │  │
│  │  ├── Only visible items rendered                          │  │
│  │  ├── Absolute positioning within container                │  │
│  │  └── Loader shown for infinite scroll trigger             │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Activity Card Component

```
┌─────────────────────────────────────────────────────────────────┐
│  ACTIVITY CARD                                                   │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Header                                                  │    │
│  │  ├── Avatar (links to profile)                          │    │
│  │  ├── Username                                           │    │
│  │  └── Relative timestamp                                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Activity Details (clickable, links to detail)          │    │
│  │  ├── Activity name                                      │    │
│  │  ├── Mini map preview (polyline)                        │    │
│  │  └── Stats grid: Distance │ Time │ Pace                 │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Footer (social actions)                                 │    │
│  │  ├── Kudos button (toggle with count)                   │    │
│  │  ├── Comments button (expandable)                       │    │
│  │  └── Comment section (lazy loaded)                      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Activity Map Component

```
┌─────────────────────────────────────────────────────────────────┐
│  MAP CONTAINER (Leaflet)                                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Data Processing                                         │    │
│  │  ├── Decode polyline (useMemo)                          │    │
│  │  ├── Calculate bounds (useMemo)                         │    │
│  │  └── Convert to [lat, lng] tuples                       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Layers                                                  │    │
│  │  ├── TileLayer (OpenStreetMap)                          │    │
│  │  ├── Polyline (main route, orange #fc4c02)              │    │
│  │  ├── Start Marker                                       │    │
│  │  ├── End Marker                                         │    │
│  │  └── Segment Overlays (if segment efforts exist)        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  FitBoundsOnLoad (helper component)                      │    │
│  │  └── Auto-fits map to route bounds with padding         │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Segment Leaderboard Component

```
┌─────────────────────────────────────────────────────────────────┐
│  SEGMENT LEADERBOARD                                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Filter Tabs                                             │    │
│  │  ┌──────────┬──────────┬──────────┐                     │    │
│  │  │ All      │ Following │ My       │                     │    │
│  │  │ Athletes │           │ Results  │                     │    │
│  │  └──────────┴──────────┴──────────┘                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Leaderboard Rows                                        │    │
│  │  ┌────┬──────────────────────────────────┬────────────┐ │    │
│  │  │Rank│ Athlete (avatar + username)       │ Time       │ │    │
│  │  ├────┼──────────────────────────────────┼────────────┤ │    │
│  │  │ 1st│ (gold styling)                   │ 00:05:23   │ │    │
│  │  │ 2nd│ (silver styling)                 │ 00:05:45   │ │    │
│  │  │ 3rd│ (bronze styling)                 │ 00:05:52   │ │    │
│  │  │ 4  │ (highlight if current user)      │ 00:06:01   │ │    │
│  │  └────┴──────────────────────────────────┴────────────┘ │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. State Management (5 minutes)

### Zustand Store Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                      ZUSTAND STORES                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  authStore                                                │   │
│  │  ├── user: User | null                                   │   │
│  │  ├── isAuthenticated: boolean                            │   │
│  │  ├── login(email, password) ──▶ Promise<void>            │   │
│  │  ├── logout() ──▶ Promise<void>                          │   │
│  │  └── checkAuth() ──▶ Promise<void>                       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  feedStore                                                │   │
│  │  ├── activities: Activity[]                              │   │
│  │  ├── cursor: string | null                               │   │
│  │  ├── hasMore: boolean                                    │   │
│  │  ├── loadFeed() ──▶ Promise<void>                        │   │
│  │  ├── loadMore() ──▶ Promise<void>                        │   │
│  │  ├── addKudos(activityId) ──▶ optimistic update          │   │
│  │  └── removeKudos(activityId) ──▶ optimistic update       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Optimistic Updates Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    KUDOS TOGGLE FLOW                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. OPTIMISTIC UPDATE                                            │
│     ├── Increment/decrement kudosCount                           │
│     └── Toggle hasKudos flag                                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. API CALL (async)                                             │
│     └── POST /api/activities/:id/kudos                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│      SUCCESS         │        │       FAILURE        │
│  State confirmed     │        │  Rollback state      │
│  (no action needed)  │        │  Show error toast    │
└──────────────────────┘        └──────────────────────┘
```

---

## 6. Deep Dive: Activity Upload Flow (8 minutes)

### Upload Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    UPLOAD PAGE FLOW                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  STAGE 1: Dropzone                                        │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │                                                      │ │  │
│  │  │   [Drag & drop zone]                                 │ │  │
│  │  │   - Accepts .gpx files                               │ │  │
│  │  │   - Max 10MB                                         │ │  │
│  │  │   - Visual feedback on drag                          │ │  │
│  │  │                                                      │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼ (file selected)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  STAGE 2: Preview + Metadata                              │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  Map Preview (decoded polyline)                     │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────┬─────────────┬─────────────┐            │  │
│  │  │  Distance   │  Duration   │  Elevation  │            │  │
│  │  └─────────────┴─────────────┴─────────────┘            │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  Activity Name: [________________]                  │ │  │
│  │  │  Activity Type: [Run v]                             │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │  [Upload Activity] (shows progress %)              │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼ (success)                         │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  REDIRECT: /activity/:id                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Client-Side GPX Preview Parser

```
┌─────────────────────────────────────────────────────────────────┐
│                    GPX PARSING FLOW                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. Parse XML with DOMParser                                     │
│     └── Extract all <trkpt> elements                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. For each trackpoint:                                         │
│     ├── Extract lat, lng, elevation                              │
│     ├── Calculate Haversine distance from previous              │
│     ├── Sum positive elevation changes                          │
│     └── Collect [lat, lng] for polyline                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Generate preview data:                                       │
│     ├── Encode points to polyline string                        │
│     ├── Calculate duration from timestamps                      │
│     ├── Generate suggested activity name                        │
│     └── Return ActivityPreview object                           │
└─────────────────────────────────────────────────────────────────┘
```

"I parse GPX client-side for immediate preview before upload. This provides instant feedback and helps users verify they selected the correct file. The full parsing happens again on the server for validation."

---

## 7. Accessibility Considerations (3 minutes)

### Keyboard Navigation

```
┌─────────────────────────────────────────────────────────────────┐
│  LEADERBOARD TABLE KEYBOARD SUPPORT                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  role="grid" aria-label="Segment leaderboard"           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Key Bindings:                                                   │
│  ├── ArrowDown ──▶ Move focus to next row                       │
│  ├── ArrowUp ──▶ Move focus to previous row                     │
│  ├── Enter ──▶ Navigate to athlete profile                      │
│  └── Tab ──▶ Move to next focusable element                     │
│                                                                  │
│  Focus Management:                                               │
│  ├── tabIndex={0} on focused row                                │
│  ├── tabIndex={-1} on other rows                                │
│  └── aria-selected on focused row                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Screen Reader Announcements

```
┌─────────────────────────────────────────────────────────────────┐
│  LIVE REGION PATTERN                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  <div id="live-region" aria-live="polite" />            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Announcements:                                                  │
│  ├── "Kudos given to {username}" (on kudos add)                 │
│  ├── "Kudos removed" (on kudos remove)                          │
│  ├── "Loading more activities" (on infinite scroll)             │
│  └── "Upload complete" (on activity upload)                     │
│                                                                  │
│  Kudos Button:                                                   │
│  └── aria-label="{action} kudos. Current count: {count}"        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Performance Optimizations (5 minutes)

### Map Tile Caching

```
┌─────────────────────────────────────────────────────────────────┐
│  MAP TILE CACHING STRATEGY                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  On user location obtained:                                      │
│  ├── Open cache: 'strava-map-tiles-v1'                          │
│  ├── For zoom levels 10-15:                                     │
│  │   ├── Convert lat/lng to tile coordinates                   │
│  │   └── Pre-cache tiles around user location                  │
│  └── Fail silently on cache errors                              │
│                                                                  │
│  Benefits:                                                       │
│  ├── Faster map loading for local activities                    │
│  ├── Works offline for familiar areas                           │
│  └── Reduced server load                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Polyline Simplification for Large Routes

```
┌─────────────────────────────────────────────────────────────────┐
│  ZOOM-BASED SIMPLIFICATION                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Algorithm: Douglas-Peucker (via simplify-js)                    │
│                                                                  │
│  Tolerance calculation:                                          │
│  └── tolerance = 2^(15 - zoom) * 0.00001                        │
│                                                                  │
│  Effect by zoom level:                                           │
│  ┌────────────┬─────────────┬──────────────────┐                │
│  │ Zoom Level │ Tolerance   │ Point Reduction  │                │
│  ├────────────┼─────────────┼──────────────────┤                │
│  │ 10 (low)   │ 0.00032     │ ~90% reduction   │                │
│  │ 13 (med)   │ 0.00004     │ ~50% reduction   │                │
│  │ 16 (high)  │ 0.000005    │ ~10% reduction   │                │
│  └────────────┴─────────────┴──────────────────┘                │
│                                                                  │
│  Implementation:                                                 │
│  ├── Track zoom level with useMapEvents                         │
│  ├── Recalculate simplified points with useMemo                 │
│  └── Re-render Polyline when zoom changes significantly         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Lazy Loading Activity Cards

```
┌─────────────────────────────────────────────────────────────────┐
│  LAZY LOADING PATTERN                                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  LazyActivityCard                                          │  │
│  │  ├── useInView hook (triggerOnce, threshold 0.1)          │  │
│  │  └── ref attached to article element                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│              ┌───────────────┴───────────────┐                   │
│              ▼                               ▼                   │
│  ┌──────────────────────┐        ┌──────────────────────┐       │
│  │    NOT IN VIEW       │        │     IN VIEW          │       │
│  │  ┌────────────────┐  │        │  ┌────────────────┐  │       │
│  │  │ Header         │  │        │  │ Header         │  │       │
│  │  ├────────────────┤  │        │  ├────────────────┤  │       │
│  │  │ MapSkeleton    │  │        │  │ Suspense       │  │       │
│  │  │ (placeholder)  │  │        │  │ └── MapPreview │  │       │
│  │  ├────────────────┤  │        │  ├────────────────┤  │       │
│  │  │ Stats          │  │        │  │ Stats          │  │       │
│  │  ├────────────────┤  │        │  ├────────────────┤  │       │
│  │  │ Actions        │  │        │  │ Actions        │  │       │
│  │  └────────────────┘  │        │  └────────────────┘  │       │
│  └──────────────────────┘        └──────────────────────┘       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Trade-offs and Alternatives

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Map Library | Leaflet | Open source, larger bundle | Mapbox GL (better perf, paid) |
| State Management | Zustand | Simple, less boilerplate | Redux Toolkit (more features, verbose) |
| Virtualization | TanStack Virtual | Manual setup | react-window (simpler API) |
| Styling | Tailwind CSS | Utility classes, large CSS | CSS Modules (scoped, smaller) |
| GPX Parsing | Client-side | Immediate preview | Server-only (simpler, no preview) |
| Polyline Display | Encoded | Compact storage | Raw points (easier debug) |

---

## 10. Future Enhancements

1. **Offline Support**
   - Service Worker for feed caching
   - IndexedDB for offline activity viewing
   - Background sync for kudos/comments

2. **Real-time Updates**
   - WebSocket for live kudos notifications
   - Server-Sent Events for feed updates
   - Optimistic UI updates

3. **Elevation Profile Chart**
   - D3.js or Chart.js integration
   - Synchronized hover with map
   - Gradient analysis visualization

4. **Mobile App Shell**
   - PWA with install prompt
   - Native-like navigation
   - Push notifications for achievements

---

## Summary

"To summarize the frontend architecture:

1. **React 19 + TanStack Router** - File-based routing with type-safe navigation and data loading

2. **Leaflet for maps** - Interactive GPS route visualization with polyline encoding for efficient storage and transfer

3. **TanStack Virtual for feeds** - Virtualized infinite-scrolling feed that renders only visible items

4. **Zustand for state** - Lightweight global state for auth, feed, and UI state with minimal boilerplate

5. **Progressive enhancement** - Client-side GPX preview before upload, lazy-loaded map components, cached map tiles

The key insight is balancing immediate feedback (client-side GPX parsing, optimistic updates) with performance (virtualization, lazy loading, polyline simplification) to create a responsive experience even with large GPS datasets."
