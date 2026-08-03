# Facebook Post Search - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

### 1. Requirements Clarification (3 minutes)

**Functional Requirements:**
- Search bar with typeahead suggestions
- Search results display with text highlighting
- Filter controls (date range, post type, author)
- Post cards with engagement actions
- Search history and saved searches
- Responsive layout for mobile and desktop

**Non-Functional Requirements:**
- Typeahead latency: < 100ms perceived
- Search results: First Contentful Paint < 1s
- Accessibility: WCAG 2.1 AA compliance
- Offline: Show cached recent searches

**Frontend Focus Areas:**
- Search bar component with debounced typeahead
- Results virtualization for large result sets
- Highlighting architecture
- State management for filters and results
- Responsive and accessible design

---

### 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Frontend Architecture                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌─────────────────┐  ┌────────────────────────────────┐  │
│  │ SearchBar    │  │ FilterPanel     │  │ SearchResults                  │  │
│  │ ├─Input      │  │ ├─DatePicker    │  │ ├─VirtualList                  │  │
│  │ ├─Suggestions│  │ ├─PostTypeFilter│  │ │ └─PostCard (highlighted)     │  │
│  │ └─SearchIcon │  │ └─AuthorFilter  │  │ └─LoadMore / InfiniteScroll   │  │
│  └──────────────┘  └─────────────────┘  └────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                              State Layer                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ useSearchStore (Zustand)                                                ││
│  │ ├─query, filters, suggestions, results, loading, error                 ││
│  │ ├─searchHistory[], savedSearches[]                                     ││
│  │ └─actions: setQuery, applyFilters, executeSearch, saveCurrent          ││
│  └─────────────────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────────────────┤
│                             Service Layer                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────────────────────┐   │
│  │ SearchAPI     │  │ SuggestionAPI │  │ LocalStorage (history/cache)   │   │
│  └───────────────┘  └───────────────┘  └────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Core Components:**
1. **SearchBar**: Input with typeahead, keyboard navigation, voice input
2. **FilterPanel**: Collapsible filters for refining results
3. **SearchResults**: Virtualized list of PostCard components
4. **PostCard**: Individual result with highlighting and actions
5. **useSearchStore**: Central state for search flow

---

### 3. Frontend Deep-Dives

#### Deep-Dive A: SearchBar with Typeahead (8 minutes)

**Component Architecture:**

The SearchBar component manages local input state, debounced suggestion fetching (150ms delay), and keyboard navigation (ArrowUp/Down, Enter, Escape). Key behaviors:

- Fetches suggestions when input length >= 2 characters
- Shows recent search history when input is short
- Supports keyboard navigation through suggestions with selectedIndex tracking
- Implements ARIA attributes for accessibility (combobox pattern)

**Suggestion Dropdown:**

The dropdown renders as a listbox with option roles. Features include:
- Click outside to close via document mousedown listener
- Visual highlighting of selected item
- History items show clock icon and remove button
- Matched text highlighting within suggestions

**CSS Styling Approach:**

```
┌─────────────────────────────────────────────────┐
│ .search-bar (relative container)                │
│ ┌─────────────────────────────────────────────┐ │
│ │ .search-input-container (pill shape)        │ │
│ │ [icon] [input ─────────────────────] [clear]│ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ .suggestion-dropdown (absolute positioned)  │ │
│ │ ├─ .suggestion-item (hover/selected states) │ │
│ │ ├─ .suggestion-item                         │ │
│ │ └─ .suggestion-item                         │ │
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

Mobile responsive: On small screens, dropdown becomes fixed fullscreen overlay below the search header.

---

#### Deep-Dive B: Search Results with Virtualization (8 minutes)

**Virtualized Results List:**

Uses @tanstack/react-virtual for efficient rendering. Configuration:
- estimateSize: 180px (estimated post card height)
- overscan: 5 items (rendered above/below viewport)
- measureElement: dynamic height measurement via getBoundingClientRect

Infinite scroll trigger: When last visible item index >= results.length - 1 and hasMore is true, fetchNextPage() is called.

**PostCard with Highlighting:**

```
┌─────────────────────────────────────────────────┐
│ ┌─────┐ Author Name  [Verified]    [Menu ...]  │
│ │ Ava │ 2 hours ago                            │
│ └─────┘                                        │
├─────────────────────────────────────────────────┤
│ Post content with <mark>highlighted</mark>     │
│ search terms rendered inline...                │
│                          [Show more]           │
├─────────────────────────────────────────────────┤
│ ┌───────────────────────────────┐              │
│ │     Media Grid (if present)   │              │
│ └───────────────────────────────┘              │
├─────────────────────────────────────────────────┤
│ 42 likes  12 comments  3 shares                │
│ [Like] [Comment] [Share]                       │
└─────────────────────────────────────────────────┘
```

**Highlight Rendering:**

Uses server-provided highlight offsets when available, falls back to client-side computation. Algorithm:
1. Sort highlights by start position
2. Build segments array with {text, highlighted} pairs
3. Handle truncation at 280 chars without breaking highlights
4. Render segments with `<mark>` for highlighted portions

---

#### Deep-Dive C: State Management with Zustand (8 minutes)

**Search Store Structure:**

```
┌─────────────────────────────────────────────────┐
│ useSearchStore (Zustand + persist + immer)     │
├─────────────────────────────────────────────────┤
│ Query State                                    │
│ ├─ query: string                               │
│ └─ filters: {dateRange, postType, authorId}    │
├─────────────────────────────────────────────────┤
│ Suggestions                                    │
│ ├─ suggestions: Suggestion[]                   │
│ └─ isLoadingSuggestions: boolean               │
├─────────────────────────────────────────────────┤
│ Results                                        │
│ ├─ results: SearchResult[]                     │
│ ├─ isLoading, error, hasMore                   │
│ ├─ nextCursor: string | null                   │
│ └─ isFetchingNextPage: boolean                 │
├─────────────────────────────────────────────────┤
│ History (persisted to localStorage)            │
│ ├─ searchHistory: {query, timestamp, count}[]  │
│ └─ savedSearches: {id, query, filters}[]       │
├─────────────────────────────────────────────────┤
│ Actions                                        │
│ ├─ setQuery, setFilters, resetFilters          │
│ ├─ fetchSuggestions, clearSuggestions          │
│ ├─ executeSearch, fetchNextPage, clearResults  │
│ └─ saveCurrentSearch, removeSavedSearch        │
└─────────────────────────────────────────────────┘
```

**Custom Hooks:**

- **useSearchWithUrl**: Syncs search state with URL params for shareable links. On mount, reads ?q, ?type, ?from, ?to from URL and initializes store. On search, updates URL via navigate().

- **useSuggestions**: Encapsulates debounced suggestion fetching with automatic cleanup on unmount.

---

#### Deep-Dive D: Filter Panel and Responsive Layout (7 minutes)

**Filter Panel Component:**

Uses local state for draft filters, only applying to store on "Apply" button click. Filter groups:
- Date Range: Presets (24h, week, month, year) + custom picker
- Post Type: Radio group (all, text, photo, video, link)
- Author: Autocomplete with user search

**Responsive Search Layout:**

```
Desktop (>768px):
┌─────────────────────────────────────────────────────────┐
│ [Search Bar ─────────────────────────────] [Filter Btn] │
├─────────────┬───────────────────────────────────────────┤
│ Filter      │                                           │
│ Panel       │        Search Results                     │
│ (280px)     │        (max-width: 680px, centered)       │
│             │                                           │
└─────────────┴───────────────────────────────────────────┘

Mobile (<768px):
┌─────────────────────────┐
│ [Search ────] [Filter]  │
├─────────────────────────┤
│                         │
│    Search Results       │
│    (full width)         │
│                         │
├─────────────────────────┤
│ Filter Panel            │ <- Slide-over from right
│ (fixed, 320px max)      │    with backdrop overlay
│                         │
└─────────────────────────┘
```

---

### 4. Component Hierarchy

```
SearchPage
├── SearchHeader
│   ├── SearchBar
│   │   ├── SearchIcon
│   │   ├── Input
│   │   ├── ClearButton
│   │   └── SuggestionDropdown
│   │       └── SuggestionItem[]
│   └── FilterToggle
├── FilterPanel
│   ├── DateRangePicker
│   ├── RadioGroup (PostType)
│   ├── AuthorAutocomplete
│   └── ActionButtons
└── SearchResults
    ├── ResultsHeader
    ├── VirtualizedList
    │   └── PostCard[]
    │       ├── Avatar
    │       ├── AuthorInfo
    │       ├── HighlightedContent
    │       ├── MediaGrid
    │       └── PostActions
    └── LoadingIndicator
```

---

### 5. Trade-offs Analysis

| Decision | Pros | Cons |
|----------|------|------|
| Debounced typeahead (150ms) | Reduces API calls, smooth UX | Slight perceived delay |
| Virtualized results | Handles thousands of results efficiently | Complex implementation, dynamic heights |
| Client-side highlighting fallback | Works even if server omits highlights | Less accurate than server highlighting |
| URL-synced search state | Shareable URLs, browser back/forward | Extra sync complexity |
| Local storage for history | Works offline, persists across sessions | Storage limits, privacy concerns |
| Slide-over filters on mobile | Familiar pattern, saves space | Extra tap to access filters |

---

### 6. Accessibility Implementation

**ARIA Live Region for Search Status:**

A visually hidden status region announces loading state, result count, and errors to screen readers via aria-live="polite".

**Keyboard Navigation for Results:**

- j/ArrowDown: Move focus to next result
- k/ArrowUp: Move focus to previous result
- Enter: Navigate to focused post
- Focus management with focusedIndex state

**Search Bar Accessibility:**

- role="combobox" with aria-expanded, aria-autocomplete
- aria-activedescendant points to selected suggestion
- Clear button has aria-label="Clear search"
- Input has explicit aria-label

---

## RADIO Data Model and Interfaces

The search frontend has three separate data lifecycles: URL-owned query state, server-owned result pages, and ephemeral interaction state. Keeping them separate makes browser navigation, caching, and cancellation predictable.

| Entity | Owner | Important fields | Lifecycle |
|---|---|---|---|
| `SearchRequest` | Router/search controller | query, filters, sort, cursor, request ID | URL and in-flight request |
| `Suggestion` | Suggestion cache | text, type, score, expires at | short-lived server state |
| `SearchResultPage` | Results store | results, total/has-more, next cursor, highlights | cursor-paginated server state |
| `SearchHistory` | Local persistence | query, filters, last used | client persisted, user-controlled |
| `SearchInteraction` | Search UI | focused suggestion/result, loading, error | ephemeral client state |

### Server-facing API

```
GET /api/search/suggestions?q=...             → ranked suggestions
GET /api/search/posts?q=...&filters=...       → first result page
GET /api/search/posts?q=...&cursor=...        → next result page
POST /api/searches/saved                       → save a query and filters
GET /api/searches/history                     → recent searches for the user
```

Every request carries a normalized query and an abort signal. When the user types again, the controller cancels the prior suggestion request; an older response must never overwrite the newer query. Result pages use a cursor rather than a page number so inserts do not reorder the user’s current window unexpectedly.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `SearchController` | query, filters, debounce policy | request lifecycle and URL update | coordinates cancellation and navigation |
| `SuggestionList` | suggestions, active index | select, keyboard movement | combobox accessibility |
| `ResultsStore` | result pages, cursor | merged visible results | deduplicates pages and tracks status |
| `HighlightRenderer` | server spans, fallback query | safe highlighted text | never injects unsanitized HTML |
| `VirtualizedResults` | result IDs and measurements | visible cards | bounds DOM work for large result sets |

This makes the central alternative explicit: storing the query and results in one global object is convenient, but it couples URL navigation, server cache, and keyboard state. Separate ownership costs a little coordination and prevents stale responses from corrupting the visible search.

### 7. Future Enhancements

1. **Voice Search**: Add Web Speech API integration for voice queries
2. **Advanced Filters**: Save filter presets, boolean operators
3. **Result Previews**: Hover/long-press to preview full post
4. **Search Analytics**: Track popular queries, zero-result searches
5. **Offline Support**: Service worker caching for recent results
6. **Keyboard Shortcuts**: Power-user navigation (j/k, /, Escape)
7. **Dark Mode**: System preference detection with manual override
8. **Internationalization**: RTL support, translated UI
