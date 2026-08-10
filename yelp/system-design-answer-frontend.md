# Yelp - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. As a frontend engineer, I'll focus on the search experience with autocomplete, geo-location integration, business detail pages with photo galleries, the review submission flow, and map-based browsing. Let me start by clarifying what we need to build."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Search Experience** - Autocomplete with category/business suggestions, location-aware search, filters (rating, price, distance, open now), sort options
2. **Business Detail Pages** - Photo gallery with lightbox, business info (hours, address, phone), interactive map, paginated reviews
3. **Review System** - Star rating selector (1-5), rich text form with photo upload, helpful/not helpful voting, optimistic updates
4. **Map Browsing** - Interactive map with markers, clustering for dense areas, "search this area" functionality
5. **User Dashboard** - Business owner management, user review history, admin moderation

### Non-Functional Requirements

- **Performance**: LCP < 2.5s, FID < 100ms, CLS < 0.1
- **Accessibility**: WCAG 2.1 AA compliance
- **Responsive**: Mobile-first with desktop optimization
- **Offline**: Service worker for cached searches

---

## 2. Frontend Architecture Overview (4-5 minutes)

### Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | React 19 | Component model, hooks, concurrent features |
| Routing | TanStack Router | Type-safe file-based routing |
| State | Zustand | Lightweight global state |
| Styling | Tailwind CSS | Utility-first, responsive |
| Maps | Mapbox GL JS | Vector tiles, clustering, performance |
| Forms | React Hook Form + Zod | Validation, type safety |
| HTTP | Axios | Interceptors, cancellation |

### Component Architecture

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           Frontend Application                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                              Routes Layer                                │  │
│  │  ┌─────────┐ ┌─────────┐ ┌───────────────┐ ┌───────────┐ ┌───────────┐  │  │
│  │  │  Home   │ │ Search  │ │ Business.$slug│ │ Dashboard │ │   Admin   │  │  │
│  │  └────┬────┘ └────┬────┘ └───────┬───────┘ └─────┬─────┘ └─────┬─────┘  │  │
│  └───────┼──────────┼───────────────┼───────────────┼─────────────┼────────┘  │
│          │          │               │               │             │           │
│  ┌───────┴──────────┴───────────────┴───────────────┴─────────────┴────────┐  │
│  │                           Components Layer                               │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │  │
│  │  │ search/                                                             │ │  │
│  │  │  SearchBar ─── FilterPanel ─── SearchResults ─── MapView           │ │  │
│  │  └────────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │  │
│  │  │ business/                                                           │ │  │
│  │  │  PhotoGallery ─── BusinessHeader ─── BusinessSidebar ─── ReviewForm│ │  │
│  │  └────────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │  │
│  │  │ common/                                                             │ │  │
│  │  │  StarRating ─── PriceLevel ─── Badge ─── Modal                     │ │  │
│  │  └────────────────────────────────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│          │                                                                     │
│  ┌───────┴───────────────────────────────────────────────────────────────┐    │
│  │                          State & Services                              │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │    │
│  │  │  authStore  │  │ searchStore │  │ useDebounce │  │ API Client  │   │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │    │
│  └───────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Deep Dive: Search Experience (8-10 minutes)

### Autocomplete Search Bar

"I'm choosing a debounced autocomplete with 200ms delay to balance responsiveness with API efficiency. The component uses AbortController to cancel in-flight requests when new input arrives, preventing race conditions."

**SearchBar Component Behavior:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                            SearchBar Flow                                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌──────────────┐    200ms     ┌──────────────┐    API      ┌──────────────┐ │
│  │  User Input  │───debounce──▶│  Fetch Call  │───request──▶│  Suggestions │ │
│  └──────────────┘              └──────┬───────┘             └──────────────┘ │
│                                       │                                       │
│                            ┌──────────┴──────────┐                            │
│                            │  AbortController    │                            │
│                            │  (cancel on new     │                            │
│                            │   input)            │                            │
│                            └─────────────────────┘                            │
│                                                                                │
│  Keyboard Navigation:                                                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                           │
│  │ Arrow ↓ │  │ Arrow ↑ │  │  Enter  │  │  Escape │                           │
│  │ Next    │  │ Previous│  │ Select  │  │ Close   │                           │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘                           │
│                                                                                │
│  Suggestion Types:                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │ business: Navigate to /business/$slug                                  │   │
│  │ category: Set query and trigger search                                 │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                │
│  ARIA Attributes: aria-expanded, aria-haspopup="listbox", role="option"       │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Geolocation Hook

"I'm implementing a custom useGeolocation hook that wraps the browser Geolocation API with proper error handling and caching. The 5-minute maximumAge prevents excessive GPS polling on mobile."

**Hook State Machine:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         useGeolocation States                                  │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│   ┌────────────┐     getLocation()      ┌────────────┐                        │
│   │   IDLE     │──────────────────────▶│  LOADING   │                        │
│   │ lat: null  │                        │ lat: null  │                        │
│   │ lng: null  │                        │ lng: null  │                        │
│   └────────────┘                        └──────┬─────┘                        │
│                                                │                               │
│                         ┌──────────────────────┼──────────────────────┐       │
│                         │                      │                      │       │
│                         ▼                      ▼                      ▼       │
│                  ┌────────────┐         ┌────────────┐         ┌────────────┐ │
│                  │  SUCCESS   │         │   ERROR    │         │  TIMEOUT   │ │
│                  │ lat: 37.7  │         │ "denied"   │         │ "timed out"│ │
│                  │ lng:-122.4 │         │            │         │            │ │
│                  └────────────┘         └────────────┘         └────────────┘ │
│                                                                                │
│  Options: enableHighAccuracy=true, timeout=10s, maximumAge=5min               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Filter Panel with URL Sync

"I'm choosing to sync filters with URL search params via TanStack Router. This enables shareable search URLs and proper back/forward navigation. Filters reset pagination to page 1."

**Filter Panel Behavior:**

- Rating filter: Radio buttons with star display (5 & up, 4 & up, etc.)
- Price filter: Toggle buttons ($ $$ $$$ $$$$), clicking selected clears
- Distance filter: Dropdown (walking 0.5mi to 25mi)
- Open Now: Checkbox toggle
- Clear filters: Removes all except query and location

---

## 4. Deep Dive: Business Detail Page (7-8 minutes)

### Photo Gallery with Lightbox

"I'm implementing a responsive grid for the gallery that shows 5 photos initially: a large hero and 4 thumbnails. The lightbox uses createPortal to render outside the DOM hierarchy, preventing z-index conflicts."

**Photo Gallery Architecture:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           Photo Gallery                                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  Grid View (2x4 layout):                                                       │
│  ┌─────────────────────────────┬──────────────┬──────────────┐                │
│  │                             │   Photo 2    │   Photo 3    │                │
│  │         Photo 1             ├──────────────┼──────────────┤                │
│  │         (Hero)              │   Photo 4    │   Photo 5    │                │
│  │                             │              │  "+N more"   │                │
│  └─────────────────────────────┴──────────────┴──────────────┘                │
│                                                                                │
│  Lightbox (Portal to document.body):                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  ┌──────┐                                                     ┌──────┐  │  │
│  │  │  ◀   │            [Current Photo - Max 90vh/90vw]          │  ▶   │  │  │
│  │  └──────┘                                                     └──────┘  │  │
│  │                                                                          │  │
│  │                        Counter: 3 / 15                                   │  │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐               │  │
│  │  │    │ │    │ │ ▪▪ │ │    │ │    │ │    │ │    │ │    │  Thumbnails   │  │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘               │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Keyboard: ← Previous | → Next | Escape Close                                 │
│  Body scroll locked when open (overflow: hidden)                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Business Sidebar

"I'm implementing a smart hours display that calculates open/closed status client-side using the current day and time. The component memoizes the calculation to avoid recalculating on every render."

**BusinessSidebar Features:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          Business Sidebar                                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  ┌──────────────────────┐                                                │  │
│  │  │ Open  │ Closes at 9 PM │ ◀─── Dynamic calculation using useMemo     │  │
│  │  └──────────────────────┘                                                │  │
│  │                                                                          │  │
│  │  📞 (415) 555-1234      ◀─── Formatted phone, tel: link                 │  │
│  │  🌐 example.com         ◀─── Truncated hostname, external link          │  │
│  │  📍 123 Main Street     ◀─── Google Maps directions link                │  │
│  │     San Francisco, CA                                                    │  │
│  │                                                                          │  │
│  │  Hours:                                                                  │  │
│  │  Monday      9:00 AM - 9:00 PM                                          │  │
│  │  Tuesday     9:00 AM - 9:00 PM  ◀─── Bold if current day               │  │
│  │  Wednesday   9:00 AM - 9:00 PM                                          │  │
│  │  Thursday    9:00 AM - 9:00 PM                                          │  │
│  │  Friday      9:00 AM - 10:00 PM                                         │  │
│  │  Saturday    10:00 AM - 10:00 PM                                        │  │
│  │  Sunday      Closed                                                      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Time format: 12-hour with AM/PM, calculated from 24-hour input               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Deep Dive: Star Rating Component (4-5 minutes)

"I'm building a dual-purpose StarRating component that works for both display (read-only) and input (interactive). Half-star display is supported for averaged ratings, and full ARIA compliance ensures screen reader accessibility."

**StarRating Component:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           StarRating Component                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  Display Mode (readonly):                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │   ★ ★ ★ ★ ☆    4.2                                                      │  │
│  │   role="img" aria-label="4.2 out of 5 stars"                            │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Interactive Mode:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │   ☆ ☆ ☆ ☆ ☆   "Select your rating"                                     │  │
│  │                                                                          │  │
│  │   Hover: ★ ★ ★ ☆ ☆  (visual preview)                                   │  │
│  │   Click: commits selection                                               │  │
│  │   role="radiogroup" with individual role="radio" buttons                │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Fill Logic:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │   fillAmount >= 0.75  →  Full star (filled SVG)                         │  │
│  │   fillAmount >= 0.25  →  Half star (linear gradient)                    │  │
│  │   fillAmount < 0.25   →  Empty star (outline only)                      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Size variants: sm (16px) | md (20px) | lg (28px)                             │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Deep Dive: Review Form (6-7 minutes)

"I'm using React Hook Form with Zod validation for the review form. The idempotency key prevents duplicate submissions on retry, and photo uploads use FileReader for instant previews before actual upload."

| Step | Constraint | Why it's a client-side concern |
|------|-----------|-------------------------------|
| Rating | 1–5, each with a word label ("Not good" … "Great") | The label is what makes ratings comparable between users; a bare star count invites everyone's private scale |
| Title | 3–200 chars | Cheap guard against empty submissions |
| Body | 50–5000 chars | The 50-char floor is anti-abuse, not formatting — one-word reviews are the cheapest possible attack on a rating |
| Photos | ≤5, ≤5MB each, `FileReader` preview | Previewing locally means the user sees their photo before any byte is uploaded |
| Submit | Client-generated UUID sent as an idempotency key | The retry problem below |

Two things here are load-bearing rather than cosmetic.

**Photos upload before the review, not with it.** The alternative — one multipart request carrying text and images — is simpler and fails badly on mobile: a 20MB upload that dies at 95% loses the written review too, and the user has to retype it. Uploading photos first means the review submission is a small JSON request that is fast and safely retryable, and a failed photo upload can be retried on its own without touching the text.

**The idempotency key is generated when the form mounts, not when it is submitted.** Generating at submit time defeats the purpose: a user who taps Submit twice produces two keys and two reviews. Minted at mount, the key is stable across every retry of that one composition, so the server can recognize the second attempt as the same review. A `409` then has an unambiguous meaning the UI can render honestly — "you have already reviewed this business" — rather than a generic failure the user will respond to by trying again.

---

## 7. Deep Dive: Map View (5-6 minutes)

"I'm choosing Mapbox GL JS for its vector tile performance and built-in clustering. The 'search this area' button appears after map movement, allowing users to explore without losing their current results."

**MapView Architecture:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              MapView Component                                 │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                     [ Search this area ]  ◀─── Appears on map move      │  │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │  │
│  │  │                                                                    │  │  │
│  │  │      (4.2)                    Mapbox GL JS Map                    │  │  │
│  │  │        ●────────────────────┐                                     │  │  │
│  │  │                             │ Popup: Name, Rating, Categories     │  │  │
│  │  │      (4.8)                  └──────────────────────────────┐      │  │  │
│  │  │        ●                                                    │      │  │  │
│  │  │                                                             │      │  │  │
│  │  │                     (3.9)                                   │      │  │  │
│  │  │                       ●                                     │      │  │  │
│  │  │                                                             │      │  │  │
│  │  │                                                        [⊕][⊖]│ Nav  │  │  │
│  │  │                                                        [⛶] │Fit    │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Marker: Custom div with rating badge, hover:scale-110 transition              │
│  Popup: Business name, star rating, review count, top 2 categories            │
│  Fit bounds: Adjust view to show all markers with 50px padding                │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Map Lifecycle:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           Map Lifecycle                                        │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  1. Initialize (useEffect with empty deps)                                     │
│     new mapboxgl.Map({ container, style, center, zoom })                       │
│     addControl(NavigationControl)                                              │
│     on('moveend') → setShowSearchArea(true)                                    │
│                                                                                │
│  2. Update Markers (useEffect with [businesses])                               │
│     Clear existing markers                                                     │
│     For each business:                                                         │
│       - Create custom marker element                                           │
│       - Create popup with business info                                        │
│       - Add click handler → onBusinessClick                                    │
│       - marker.addTo(map)                                                      │
│                                                                                │
│  3. Cleanup (useEffect return)                                                 │
│     map.remove()                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. State Management with Zustand (3-4 minutes)

"I'm using Zustand with the persist middleware to remember recent searches and last location. The partialize option ensures we only persist non-sensitive, useful data to localStorage."

| Slice | Holds | Persisted? |
|-------|-------|-----------|
| `query`, `location` | The current text and place ("pizza", "San Francisco, CA") | No — belongs to the URL |
| `coordinates` | Resolved lat/lng for the location | Last one only |
| `filters` | minRating, price, distance, openNow, categories[] | No |
| `recentSearches` | Last 10, de-duplicated | Yes |

The interesting decision is **what is deliberately not in the store: the results.** Search results live with the query that produced them, keyed by the URL, so a shared link reproduces exactly what the sender saw and the back button works without any restoration logic. Putting results in a global store makes both of those things something you have to implement by hand, and makes "which query do these results belong to?" a question the UI can get wrong during a race between two in-flight searches.

`partialize` persists only `recentSearches` and the last coordinates. That split is a privacy decision as much as a technical one: recent searches are a convenience the user can see and clear, whereas persisting every filter combination silently rebuilds a profile of someone's browsing in localStorage for no product benefit. Filters also *should* reset between sessions — a "open now, under $" filter set at 11pm is actively wrong the next morning.

---

## 9. Performance Optimizations (3-4 minutes)

### Image Optimization

"I'm implementing lazy loading with IntersectionObserver and responsive images with srcset. The 200px root margin preloads images before they enter the viewport."

**OptimizedImage Component:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        OptimizedImage Component                                │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  State Machine:                                                                │
│  ┌─────────────┐    IntersectionObserver     ┌─────────────┐                  │
│  │ NOT_IN_VIEW │────(rootMargin: 200px)────▶│  IN_VIEW    │                  │
│  │ (skeleton)  │                             │ (loading)   │                  │
│  └─────────────┘                             └──────┬──────┘                  │
│                                                      │                         │
│                                                   onLoad                       │
│                                                      ▼                         │
│                                              ┌─────────────┐                   │
│                                              │   LOADED    │                   │
│                                              │ (visible)   │                   │
│                                              └─────────────┘                   │
│                                                                                │
│  srcSet Generation:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  widths = [320, 640, 960, 1280]                                          │  │
│  │  srcset = "image.jpg?w=320 320w, image.jpg?w=640 640w, ..."             │  │
│  │  sizes = "(max-width: 640px) 100vw, ${width}px"                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Attributes: loading="lazy", decoding="async"                                  │
│  Priority images: loading="eager" (above fold)                                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Infinite Scroll for Reviews

"I'm using IntersectionObserver with a sentinel element at the end of the list. When the sentinel becomes visible, we fetch the next page of reviews."

**useInfiniteScroll Hook:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         useInfiniteScroll                                      │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │   Review 1                                                               │  │
│  │   Review 2                                                               │  │
│  │   Review 3                                                               │  │
│  │   ...                                                                    │  │
│  │   Review N                                                               │  │
│  │   ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │   │              Sentinel (10px height, invisible)                   │   │  │
│  │   │   When visible: loadMore() if hasMore && !isLoading             │   │  │
│  │   └─────────────────────────────────────────────────────────────────┘   │  │
│  │   [Loading Spinner] if isLoading                                        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Options: threshold=0.1, rootMargin="100px"                                    │
│  Returns: { sentinelRef, isLoading }                                           │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Accessibility Features (3-4 minutes)

"I'm implementing keyboard navigation for the star rating that follows WAI-ARIA radiogroup pattern. Arrow keys move between options, Home/End jump to first/last."

**Accessible Rating Pattern:**

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                      Accessible Rating Selector                                │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ARIA Structure:                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  <div role="radiogroup" aria-labelledby="rating-label">                  │  │
│  │    <span id="rating-label">Your rating</span>                            │  │
│  │    <input type="radio" name="rating" value="1" aria-label="1 star" />   │  │
│  │    <input type="radio" name="rating" value="2" aria-label="2 stars" />  │  │
│  │    <input type="radio" name="rating" value="3" aria-label="3 stars" />  │  │
│  │    <input type="radio" name="rating" value="4" aria-label="4 stars" />  │  │
│  │    <input type="radio" name="rating" value="5" aria-label="5 stars" />  │  │
│  │  </div>                                                                  │  │
│  │  <div role="status" aria-live="polite" class="sr-only">                 │  │
│  │    {value} star(s) selected                                              │  │
│  │  </div>                                                                  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Keyboard Controls:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │  Arrow Right/Up   →  Increment rating (max 5)                            │  │
│  │  Arrow Left/Down  →  Decrement rating (min 1)                            │  │
│  │  Home             →  Set to 1 star                                       │  │
│  │  End              →  Set to 5 stars                                      │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
│  Focus management: Focus moves to newly selected radio button                  │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 11. Trade-offs and Alternatives (3-4 minutes)

### Component Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ Custom Tailwind | Full control, smaller bundle | More development time | **Chosen** - Yelp-specific UI |
| ❌ Radix UI | Accessible primitives | Additional dependency | Use for complex widgets |
| ❌ shadcn/ui | Copy-paste components | May need customization | Good alternative |

### Map Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ Mapbox GL JS | Vector tiles, clustering, smooth | Paid at scale | **Chosen** - best performance |
| ❌ Google Maps | Familiar, comprehensive | Pricing, less customizable | Standard alternative |
| ❌ Leaflet | Open source, free | Raster tiles, less smooth | Budget option |

### Form Handling

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| ✅ React Hook Form + Zod | Type-safe, performant | Learning curve | **Chosen** - validation needs |
| ❌ Formik | Mature, flexible | More boilerplate | Established choice |
| ❌ Native forms | No dependencies | Manual validation | Simple forms only |

---

## 12. Future Enhancements (2-3 minutes)

Roughly in priority order: a service worker for offline search caching and review-draft auto-save (localStorage), then a full PWA with install prompt; WebGL map clustering for dense areas and "search this area" refinements; real-time review notifications over WebSocket; and personalized recommendations driven by review history. Each is additive to the architecture above rather than a rework of it — the state and data-fetching seams already accommodate them.

---

## Summary

The key frontend insights for Yelp's design are:

1. **Autocomplete with debouncing**: 200ms debounce, request cancellation, keyboard navigation with ARIA support

2. **Geolocation integration**: Browser API with graceful fallback, cached results, "near me" functionality

3. **Photo gallery with lightbox**: Grid layout for thumbnails, keyboard navigation, touch gestures, lazy loading

4. **Interactive star rating**: Both display and input modes, half-star support, accessible with keyboard/screen reader

5. **Map-based browsing**: Mapbox GL JS with clustering, custom markers, "search this area" functionality

6. **Form validation**: React Hook Form + Zod for type-safe validation, idempotency keys for retry safety

7. **Performance optimizations**: Image lazy loading with intersection observer, infinite scroll for reviews, responsive images with srcset

This frontend architecture delivers a responsive, accessible search-and-discover experience that works seamlessly across desktop and mobile devices.
