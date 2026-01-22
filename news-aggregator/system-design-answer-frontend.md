# News Aggregator - Frontend System Design Interview Answer

*A 45-minute system design interview answer focused on UI components, state management, accessibility, and performance optimization.*

---

## Opening Statement

"Today I'll design the frontend for a news aggregator like Google News or Flipboard, focusing on the user interface and experience. The core frontend challenges are: building a responsive feed with virtualized scrolling for thousands of articles, designing intuitive story clustering UI, implementing real-time breaking news alerts, managing complex state across personalization preferences, and optimizing for performance with image lazy loading and skeleton states. I'll walk through the component architecture, state management patterns, and accessibility considerations."

---

## Step 1: Requirements Clarification (3-5 minutes)

### User Personas and Use Cases

**News Reader (Primary User)**
- Browse personalized feed of news stories
- Read articles from multiple sources on same story
- Search for specific topics or keywords
- Customize topic preferences
- Receive breaking news notifications

**Admin User**
- Manage news sources
- Monitor crawl status and errors
- View system statistics
- Moderate content

### Core UI Requirements

1. **Personalized Feed** - Infinite scroll with story cards
2. **Story Detail View** - Multiple sources for same story
3. **Topic Navigation** - Browse by category
4. **Search Interface** - Full-text with filters
5. **Breaking News Banner** - Real-time alerts
6. **Preferences Panel** - Topic and source selection
7. **Reading Progress** - Track what user has read

### Non-Functional Requirements

| Requirement | Target | Frontend Implication |
|-------------|--------|---------------------|
| Initial Load | < 2s | Code splitting, critical CSS |
| Feed Scroll | 60 fps | Virtualized list rendering |
| Image Load | Progressive | Lazy loading, blur-up placeholders |
| Offline | Basic support | Service worker, cached articles |
| Accessibility | WCAG 2.1 AA | Screen reader, keyboard navigation |

---

## Step 2: Component Architecture (10 minutes)

### High-Level Component Tree

```
App
├── AppHeader
│   ├── Logo
│   ├── SearchBar
│   ├── TopicNav
│   └── UserMenu
│       ├── NotificationBell
│       └── ProfileDropdown
├── BreakingNewsBanner
├── MainContent
│   ├── FeedView (/)
│   │   ├── FeedHeader
│   │   │   └── FeedFilters
│   │   ├── StoryList
│   │   │   └── StoryCard (virtualized)
│   │   └── LoadingSpinner
│   ├── StoryDetailView (/story/:id)
│   │   ├── StoryHeader
│   │   ├── SourceList
│   │   │   └── SourceCard
│   │   └── RelatedStories
│   ├── TopicView (/topic/:topic)
│   │   └── StoryList
│   ├── SearchView (/search)
│   │   ├── SearchFilters
│   │   └── SearchResults
│   └── PreferencesView (/preferences)
│       ├── TopicSelector
│       └── SourceSelector
├── AdminPanel (/admin)
│   ├── SourceManager
│   ├── CrawlStatus
│   └── SystemStats
└── ToastContainer
```

### Core Components

#### StoryCard Component

```tsx
interface StoryCardProps {
  story: Story;
  onRead: (storyId: string) => void;
  isRead: boolean;
  priority: 'high' | 'normal';
}

export function StoryCard({ story, onRead, isRead, priority }: StoryCardProps) {
  const { title, summary, primaryImage, sources, topics, publishedAt, isBreaking } = story;

  return (
    <article
      className={cn(
        'group relative rounded-lg border bg-white p-4 shadow-sm transition-shadow hover:shadow-md',
        isRead && 'opacity-75',
        isBreaking && 'border-red-500 ring-2 ring-red-100'
      )}
      aria-label={`Story: ${title}`}
    >
      {/* Breaking badge */}
      {isBreaking && (
        <span className="absolute -top-2 left-4 rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
          BREAKING
        </span>
      )}

      <div className="flex gap-4">
        {/* Story image with lazy loading */}
        {primaryImage && (
          <div className="relative h-24 w-32 flex-shrink-0 overflow-hidden rounded">
            <img
              src={primaryImage.thumbnail}
              alt=""
              loading={priority === 'high' ? 'eager' : 'lazy'}
              className="h-full w-full object-cover"
              onLoad={() => {
                // Swap to full image after thumbnail loads
              }}
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Topic badges */}
          <div className="mb-1 flex flex-wrap gap-1">
            {topics.slice(0, 2).map(topic => (
              <TopicBadge key={topic} topic={topic} size="small" />
            ))}
          </div>

          {/* Title */}
          <h3 className="mb-1 text-lg font-semibold leading-tight">
            <Link
              to="/story/$storyId"
              params={{ storyId: story.id }}
              onClick={() => onRead(story.id)}
              className="hover:text-blue-600"
            >
              {title}
            </Link>
          </h3>

          {/* Summary */}
          <p className="mb-2 line-clamp-2 text-sm text-gray-600">
            {summary}
          </p>

          {/* Meta row */}
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <SourceIndicator sources={sources} />
            <TimeAgo date={publishedAt} />
            {isRead && (
              <span className="flex items-center gap-1">
                <CheckIcon className="h-3 w-3" />
                Read
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
```

#### SourceIndicator Component

Shows multiple sources covering the same story:

```tsx
interface SourceIndicatorProps {
  sources: Source[];
  maxDisplay?: number;
}

export function SourceIndicator({ sources, maxDisplay = 3 }: SourceIndicatorProps) {
  const displaySources = sources.slice(0, maxDisplay);
  const remainingCount = sources.length - maxDisplay;

  return (
    <div className="flex items-center gap-1">
      {/* Source favicons stacked */}
      <div className="flex -space-x-1">
        {displaySources.map((source, index) => (
          <img
            key={source.id}
            src={source.favicon}
            alt={source.name}
            title={source.name}
            className="h-4 w-4 rounded-full border border-white"
            style={{ zIndex: maxDisplay - index }}
          />
        ))}
      </div>

      {/* Count and names */}
      <span className="text-gray-500">
        {sources.length} source{sources.length !== 1 && 's'}
      </span>

      {remainingCount > 0 && (
        <span className="text-gray-400">
          +{remainingCount} more
        </span>
      )}
    </div>
  );
}
```

#### VirtualizedStoryList Component

```tsx
import { useVirtualizer } from '@tanstack/react-virtual';

interface StoryListProps {
  stories: Story[];
  onLoadMore: () => void;
  hasMore: boolean;
  isLoading: boolean;
}

export function StoryList({ stories, onLoadMore, hasMore, isLoading }: StoryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { readStories, markAsRead } = useReadingProgress();

  const virtualizer = useVirtualizer({
    count: stories.length + (hasMore ? 1 : 0), // +1 for loading indicator
    getScrollElement: () => parentRef.current,
    estimateSize: () => 160, // Estimated card height
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Infinite scroll trigger
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (
      lastItem &&
      lastItem.index >= stories.length - 5 &&
      hasMore &&
      !isLoading
    ) {
      onLoadMore();
    }
  }, [virtualizer.getVirtualItems(), stories.length, hasMore, isLoading, onLoadMore]);

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      role="feed"
      aria-busy={isLoading}
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const isLoadingRow = virtualItem.index >= stories.length;

          if (isLoadingRow) {
            return (
              <div
                key="loading"
                className="absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <LoadingSpinner />
              </div>
            );
          }

          const story = stories[virtualItem.index];

          return (
            <div
              key={story.id}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full p-2"
              style={{
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <StoryCard
                story={story}
                isRead={readStories.has(story.id)}
                onRead={markAsRead}
                priority={virtualItem.index < 3 ? 'high' : 'normal'}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## Step 3: Deep Dive - Breaking News Banner (8 minutes)

### Breaking News Component

```tsx
interface BreakingNewsBannerProps {
  story: Story | null;
  onDismiss: () => void;
  onNavigate: (storyId: string) => void;
}

export function BreakingNewsBanner({ story, onDismiss, onNavigate }: BreakingNewsBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Animate in when story appears
  useEffect(() => {
    if (story) {
      // Slight delay for smooth appearance
      const timer = setTimeout(() => setIsVisible(true), 100);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
    }
  }, [story]);

  if (!story) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transform transition-transform duration-300',
        isVisible ? 'translate-y-0' : '-translate-y-full'
      )}
    >
      <div className="bg-red-600 text-white shadow-lg">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex items-center justify-between py-2">
            {/* Breaking label */}
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1 font-bold uppercase tracking-wider">
                <PulsingDot />
                Breaking
              </span>

              {/* Story title (truncated) */}
              <button
                onClick={() => onNavigate(story.id)}
                className="text-left hover:underline"
              >
                <span className="line-clamp-1 font-medium">
                  {story.title}
                </span>
              </button>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="rounded p-1 hover:bg-red-700"
                aria-expanded={isExpanded}
                aria-label={isExpanded ? 'Collapse' : 'Expand'}
              >
                <ChevronIcon
                  className={cn(
                    'h-4 w-4 transition-transform',
                    isExpanded && 'rotate-180'
                  )}
                />
              </button>

              <button
                onClick={onDismiss}
                className="rounded p-1 hover:bg-red-700"
                aria-label="Dismiss breaking news"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Expanded content */}
          <AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden border-t border-red-500"
              >
                <div className="py-3">
                  <p className="mb-2 text-sm text-red-100">
                    {story.summary}
                  </p>
                  <div className="flex items-center gap-4 text-xs text-red-200">
                    <SourceIndicator sources={story.sources} />
                    <TimeAgo date={story.publishedAt} />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// Animated pulsing dot for breaking news
function PulsingDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
    </span>
  );
}
```

### Breaking News Hook

```tsx
function useBreakingNews() {
  const [breakingStory, setBreakingStory] = useState<Story | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  // Poll for breaking news every 30 seconds
  useEffect(() => {
    const fetchBreaking = async () => {
      try {
        const response = await api.get('/api/v1/breaking');
        const stories = response.data.stories as Story[];

        // Find first non-dismissed breaking story
        const newBreaking = stories.find(s => !dismissedIds.has(s.id));

        if (newBreaking && newBreaking.id !== breakingStory?.id) {
          setBreakingStory(newBreaking);

          // Optionally play notification sound
          if (Notification.permission === 'granted') {
            new Notification('Breaking News', {
              body: newBreaking.title,
              icon: '/breaking-news-icon.png',
            });
          }
        }
      } catch (error) {
        console.error('Failed to fetch breaking news:', error);
      }
    };

    fetchBreaking();
    const interval = setInterval(fetchBreaking, 30000);

    return () => clearInterval(interval);
  }, [dismissedIds, breakingStory?.id]);

  const dismiss = useCallback((storyId: string) => {
    setDismissedIds(prev => new Set([...prev, storyId]));
    setBreakingStory(null);
  }, []);

  return { breakingStory, dismiss };
}
```

---

## Step 4: Deep Dive - Search Interface (8 minutes)

### SearchBar Component

```tsx
interface SearchBarProps {
  onSearch: (query: string) => void;
  initialQuery?: string;
}

export function SearchBar({ onSearch, initialQuery = '' }: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const comboboxId = useId();

  // Debounced suggestions
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    if (debouncedQuery.length >= 2) {
      fetchSuggestions(debouncedQuery).then(setSuggestions);
    } else {
      setSuggestions([]);
    }
  }, [debouncedQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
      setIsOpen(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative w-full max-w-lg">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />

        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search news..."
          className="w-full rounded-full border border-gray-300 bg-gray-50 py-2 pl-10 pr-4 text-sm focus:border-blue-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
          role="combobox"
          aria-expanded={isOpen && suggestions.length > 0}
          aria-controls={comboboxId}
          aria-autocomplete="list"
        />

        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            aria-label="Clear search"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Suggestions dropdown */}
      {isOpen && suggestions.length > 0 && (
        <ul
          id={comboboxId}
          role="listbox"
          className="absolute top-full z-10 mt-1 w-full rounded-lg border bg-white py-1 shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion}
              role="option"
              className="cursor-pointer px-4 py-2 hover:bg-gray-100"
              onClick={() => {
                setQuery(suggestion);
                onSearch(suggestion);
                setIsOpen(false);
              }}
            >
              <HighlightedText text={suggestion} highlight={query} />
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function HighlightedText({ text, highlight }: { text: string; highlight: string }) {
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));

  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase() ? (
          <mark key={i} className="bg-yellow-100 font-medium">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </span>
  );
}
```

### SearchFilters Component

```tsx
interface SearchFiltersProps {
  filters: SearchFilters;
  onFilterChange: (filters: SearchFilters) => void;
  topics: Topic[];
  sources: Source[];
}

export function SearchFiltersPanel({
  filters,
  onFilterChange,
  topics,
  sources,
}: SearchFiltersProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const updateFilter = <K extends keyof SearchFilters>(
    key: K,
    value: SearchFilters[K]
  ) => {
    onFilterChange({ ...filters, [key]: value });
  };

  const activeFilterCount = [
    filters.topic,
    filters.source,
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length;

  return (
    <div className="rounded-lg border bg-white p-4">
      {/* Collapsed header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between"
        aria-expanded={isExpanded}
      >
        <span className="flex items-center gap-2 font-medium">
          <FilterIcon className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
              {activeFilterCount}
            </span>
          )}
        </span>
        <ChevronIcon
          className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')}
        />
      </button>

      {/* Expanded filters */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-4 space-y-4 overflow-hidden"
          >
            {/* Topic filter */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Topic
              </label>
              <select
                value={filters.topic || ''}
                onChange={(e) => updateFilter('topic', e.target.value || null)}
                className="w-full rounded border p-2 text-sm"
              >
                <option value="">All topics</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.displayName}
                  </option>
                ))}
              </select>
            </div>

            {/* Source filter */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Source
              </label>
              <select
                value={filters.source || ''}
                onChange={(e) => updateFilter('source', e.target.value || null)}
                className="w-full rounded border p-2 text-sm"
              >
                <option value="">All sources</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  From
                </label>
                <input
                  type="date"
                  value={filters.dateFrom || ''}
                  onChange={(e) => updateFilter('dateFrom', e.target.value || null)}
                  className="w-full rounded border p-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  To
                </label>
                <input
                  type="date"
                  value={filters.dateTo || ''}
                  onChange={(e) => updateFilter('dateTo', e.target.value || null)}
                  className="w-full rounded border p-2 text-sm"
                />
              </div>
            </div>

            {/* Clear button */}
            {activeFilterCount > 0 && (
              <button
                onClick={() =>
                  onFilterChange({
                    topic: null,
                    source: null,
                    dateFrom: null,
                    dateTo: null,
                  })
                }
                className="text-sm text-blue-600 hover:underline"
              >
                Clear all filters
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

---

## Step 5: State Management (8 minutes)

### Zustand Stores

```tsx
// stores/feedStore.ts
interface FeedState {
  stories: Story[];
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchFeed: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refreshFeed: () => Promise<void>;
}

export const useFeedStore = create<FeedState>((set, get) => ({
  stories: [],
  cursor: null,
  hasMore: true,
  isLoading: false,
  error: null,

  fetchFeed: async (reset = false) => {
    const state = get();
    if (state.isLoading) return;

    set({ isLoading: true, error: null });

    try {
      const cursor = reset ? null : state.cursor;
      const response = await api.get('/api/v1/feed', {
        params: { cursor, limit: 20 },
      });

      const { stories, next_cursor, has_more } = response.data;

      set({
        stories: reset ? stories : [...state.stories, ...stories],
        cursor: next_cursor,
        hasMore: has_more,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load feed',
        isLoading: false,
      });
    }
  },

  loadMore: async () => {
    const { hasMore, fetchFeed } = get();
    if (hasMore) {
      await fetchFeed(false);
    }
  },

  refreshFeed: async () => {
    await get().fetchFeed(true);
  },
}));
```

```tsx
// stores/preferencesStore.ts
interface PreferencesState {
  topics: string[];
  preferredSources: string[];
  excludedSources: string[];
  isLoading: boolean;

  // Actions
  fetchPreferences: () => Promise<void>;
  updateTopics: (topics: string[]) => Promise<void>;
  toggleSource: (sourceId: string, preferred: boolean) => Promise<void>;
  excludeSource: (sourceId: string) => Promise<void>;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  topics: [],
  preferredSources: [],
  excludedSources: [],
  isLoading: false,

  fetchPreferences: async () => {
    set({ isLoading: true });

    try {
      const response = await api.get('/api/v1/preferences');
      const { topics, sources, excluded_sources } = response.data;

      set({
        topics,
        preferredSources: sources,
        excludedSources: excluded_sources,
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false });
    }
  },

  updateTopics: async (topics: string[]) => {
    set({ topics });

    await api.put('/api/v1/preferences', { topics });

    // Invalidate feed cache
    useFeedStore.getState().refreshFeed();
  },

  toggleSource: async (sourceId: string, preferred: boolean) => {
    const state = get();
    const preferredSources = preferred
      ? [...state.preferredSources, sourceId]
      : state.preferredSources.filter((id) => id !== sourceId);

    set({ preferredSources });

    await api.put('/api/v1/preferences', { sources: preferredSources });
  },

  excludeSource: async (sourceId: string) => {
    const state = get();
    const excludedSources = [...state.excludedSources, sourceId];

    set({ excludedSources });

    await api.put('/api/v1/preferences', { excluded_sources: excludedSources });
    useFeedStore.getState().refreshFeed();
  },
}));
```

```tsx
// stores/readingProgressStore.ts
interface ReadingProgressState {
  readStories: Set<string>;
  readingTime: Map<string, number>; // storyId -> seconds

  // Actions
  markAsRead: (storyId: string) => void;
  trackDwellTime: (storyId: string, seconds: number) => void;
  syncToServer: () => Promise<void>;
}

export const useReadingProgressStore = create<ReadingProgressState>()(
  persist(
    (set, get) => ({
      readStories: new Set(),
      readingTime: new Map(),

      markAsRead: (storyId: string) => {
        set((state) => ({
          readStories: new Set([...state.readStories, storyId]),
        }));
      },

      trackDwellTime: (storyId: string, seconds: number) => {
        set((state) => {
          const newMap = new Map(state.readingTime);
          const current = newMap.get(storyId) || 0;
          newMap.set(storyId, current + seconds);
          return { readingTime: newMap };
        });
      },

      syncToServer: async () => {
        const { readStories, readingTime } = get();

        // Batch sync reading history
        const entries = Array.from(readStories).map((storyId) => ({
          story_id: storyId,
          dwell_time_seconds: readingTime.get(storyId) || 0,
        }));

        if (entries.length > 0) {
          await api.post('/api/v1/reading-history', { entries });
        }
      },
    }),
    {
      name: 'reading-progress',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        readStories: Array.from(state.readStories),
        readingTime: Object.fromEntries(state.readingTime),
      }),
      merge: (persisted: any, current) => ({
        ...current,
        readStories: new Set(persisted?.readStories || []),
        readingTime: new Map(Object.entries(persisted?.readingTime || {})),
      }),
    }
  )
);
```

### Custom Hooks

```tsx
// hooks/useReadingProgress.ts
export function useReadingProgress() {
  const store = useReadingProgressStore();

  return {
    readStories: store.readStories,
    markAsRead: store.markAsRead,
    isRead: (storyId: string) => store.readStories.has(storyId),
  };
}

// hooks/useDwellTimeTracker.ts
export function useDwellTimeTracker(storyId: string) {
  const trackDwellTime = useReadingProgressStore((s) => s.trackDwellTime);
  const startTime = useRef<number | null>(null);

  useEffect(() => {
    startTime.current = Date.now();

    // Track every 10 seconds while on page
    const interval = setInterval(() => {
      if (startTime.current) {
        const elapsed = Math.floor((Date.now() - startTime.current) / 1000);
        trackDwellTime(storyId, elapsed);
        startTime.current = Date.now(); // Reset for next interval
      }
    }, 10000);

    return () => {
      clearInterval(interval);

      // Track remaining time on unmount
      if (startTime.current) {
        const elapsed = Math.floor((Date.now() - startTime.current) / 1000);
        if (elapsed > 0) {
          trackDwellTime(storyId, elapsed);
        }
      }
    };
  }, [storyId, trackDwellTime]);
}
```

---

## Step 6: Topic Navigation (5 minutes)

### TopicNav Component

```tsx
interface TopicNavProps {
  topics: Topic[];
  activeTopic: string | null;
  onTopicSelect: (topicId: string | null) => void;
}

export function TopicNav({ topics, activeTopic, onTopicSelect }: TopicNavProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);

  // Check scroll position for arrow visibility
  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      setShowLeftArrow(el.scrollLeft > 0);
      setShowRightArrow(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
    }
  }, []);

  useEffect(() => {
    updateArrows();
    window.addEventListener('resize', updateArrows);
    return () => window.removeEventListener('resize', updateArrows);
  }, [updateArrows]);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (el) {
      const scrollAmount = el.clientWidth * 0.8;
      el.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  return (
    <nav aria-label="Topic navigation" className="relative">
      {/* Left scroll arrow */}
      {showLeftArrow && (
        <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-0 z-10 flex h-full w-10 items-center justify-center bg-gradient-to-r from-white to-transparent"
          aria-label="Scroll topics left"
        >
          <ChevronLeftIcon className="h-5 w-5 text-gray-600" />
        </button>
      )}

      {/* Topic pills */}
      <div
        ref={scrollRef}
        onScroll={updateArrows}
        className="flex gap-2 overflow-x-auto scrollbar-hide px-1 py-2"
        role="tablist"
      >
        {/* All topics option */}
        <button
          onClick={() => onTopicSelect(null)}
          role="tab"
          aria-selected={activeTopic === null}
          className={cn(
            'flex-shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
            activeTopic === null
              ? 'bg-blue-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          )}
        >
          For You
        </button>

        {topics.map((topic) => (
          <button
            key={topic.id}
            onClick={() => onTopicSelect(topic.id)}
            role="tab"
            aria-selected={activeTopic === topic.id}
            className={cn(
              'flex-shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              activeTopic === topic.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            )}
          >
            {topic.displayName}
            {topic.articleCount > 0 && (
              <span className="ml-1 text-xs opacity-75">
                ({topic.articleCount})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-0 z-10 flex h-full w-10 items-center justify-center bg-gradient-to-l from-white to-transparent"
          aria-label="Scroll topics right"
        >
          <ChevronRightIcon className="h-5 w-5 text-gray-600" />
        </button>
      )}
    </nav>
  );
}
```

### TopicSelector for Preferences

```tsx
interface TopicSelectorProps {
  allTopics: Topic[];
  selectedTopics: string[];
  onSelectionChange: (topicIds: string[]) => void;
}

export function TopicSelector({
  allTopics,
  selectedTopics,
  onSelectionChange,
}: TopicSelectorProps) {
  const toggleTopic = (topicId: string) => {
    const newSelection = selectedTopics.includes(topicId)
      ? selectedTopics.filter((id) => id !== topicId)
      : [...selectedTopics, topicId];

    onSelectionChange(newSelection);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Select topics you're interested in. These will be used to personalize your feed.
      </p>

      <div
        role="group"
        aria-label="Topic selection"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {allTopics.map((topic) => {
          const isSelected = selectedTopics.includes(topic.id);

          return (
            <button
              key={topic.id}
              onClick={() => toggleTopic(topic.id)}
              aria-pressed={isSelected}
              className={cn(
                'flex items-center gap-2 rounded-lg border-2 p-3 text-left transition-all',
                isSelected
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              )}
            >
              <TopicIcon topic={topic.id} className="h-5 w-5 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{topic.displayName}</div>
                {topic.description && (
                  <div className="truncate text-xs text-gray-500">
                    {topic.description}
                  </div>
                )}
              </div>
              {isSelected && (
                <CheckIcon className="h-5 w-5 flex-shrink-0 text-blue-600" />
              )}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-gray-500">
        {selectedTopics.length} topic{selectedTopics.length !== 1 && 's'} selected
      </p>
    </div>
  );
}
```

---

## Step 7: Accessibility (4 minutes)

### Keyboard Navigation

```tsx
// hooks/useKeyboardNavigation.ts
export function useKeyboardNavigation(stories: Story[]) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not in input/textarea
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA'
      ) {
        return;
      }

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, stories.length - 1));
          break;

        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case 'Enter':
        case 'o':
          if (focusedIndex >= 0 && stories[focusedIndex]) {
            navigate({
              to: '/story/$storyId',
              params: { storyId: stories[focusedIndex].id },
            });
          }
          break;

        case '?':
          // Show keyboard shortcuts help
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [stories, focusedIndex, navigate]);

  return { focusedIndex, setFocusedIndex };
}
```

### Screen Reader Announcements

```tsx
// components/LiveRegion.tsx
export function LiveRegion() {
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    // Subscribe to announcement events
    const handler = (e: CustomEvent<string>) => {
      setAnnouncement(e.detail);
      // Clear after announcement is read
      setTimeout(() => setAnnouncement(''), 1000);
    };

    window.addEventListener('announce', handler as EventListener);
    return () => window.removeEventListener('announce', handler as EventListener);
  }, []);

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

// Utility to trigger announcements
export function announce(message: string) {
  window.dispatchEvent(
    new CustomEvent('announce', { detail: message })
  );
}

// Usage
function onFeedLoaded(count: number) {
  announce(`Loaded ${count} new stories`);
}
```

### Skip Links

```tsx
export function SkipLinks() {
  return (
    <div className="sr-only focus-within:not-sr-only">
      <a
        href="#main-content"
        className="absolute left-2 top-2 z-50 rounded bg-blue-600 px-4 py-2 text-white focus:outline-none focus:ring-2"
      >
        Skip to main content
      </a>
      <a
        href="#topic-nav"
        className="absolute left-2 top-14 z-50 rounded bg-blue-600 px-4 py-2 text-white focus:outline-none focus:ring-2"
      >
        Skip to topic navigation
      </a>
    </div>
  );
}
```

---

## Step 8: Performance Optimizations (3 minutes)

### Image Loading Strategy

```tsx
// components/ProgressiveImage.tsx
interface ProgressiveImageProps {
  src: string;
  thumbnail?: string;
  alt: string;
  className?: string;
  priority?: boolean;
}

export function ProgressiveImage({
  src,
  thumbnail,
  alt,
  className,
  priority = false,
}: ProgressiveImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [currentSrc, setCurrentSrc] = useState(thumbnail || src);

  useEffect(() => {
    if (thumbnail && !priority) {
      // Preload full image
      const img = new Image();
      img.src = src;
      img.onload = () => {
        setCurrentSrc(src);
        setIsLoaded(true);
      };
    }
  }, [src, thumbnail, priority]);

  return (
    <div className={cn('relative overflow-hidden', className)}>
      <img
        src={currentSrc}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        className={cn(
          'h-full w-full object-cover transition-opacity duration-300',
          !isLoaded && thumbnail && 'blur-sm'
        )}
        onLoad={() => !thumbnail && setIsLoaded(true)}
      />

      {/* Loading placeholder */}
      {!isLoaded && !thumbnail && (
        <div className="absolute inset-0 animate-pulse bg-gray-200" />
      )}
    </div>
  );
}
```

### Skeleton Loading

```tsx
export function StoryCardSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border bg-white p-4">
      <div className="flex gap-4">
        {/* Image placeholder */}
        <div className="h-24 w-32 flex-shrink-0 rounded bg-gray-200" />

        <div className="flex-1 space-y-3">
          {/* Topic badges */}
          <div className="flex gap-1">
            <div className="h-5 w-16 rounded bg-gray-200" />
            <div className="h-5 w-12 rounded bg-gray-200" />
          </div>

          {/* Title */}
          <div className="h-5 w-full rounded bg-gray-200" />
          <div className="h-5 w-3/4 rounded bg-gray-200" />

          {/* Summary */}
          <div className="h-4 w-full rounded bg-gray-100" />

          {/* Meta */}
          <div className="flex gap-4">
            <div className="h-4 w-20 rounded bg-gray-100" />
            <div className="h-4 w-16 rounded bg-gray-100" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeedSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <StoryCardSkeleton key={i} />
      ))}
    </div>
  );
}
```

---

## Trade-offs Summary

| Decision | Chosen Approach | Alternative | Trade-off |
|----------|-----------------|-------------|-----------|
| List rendering | Virtualized scroll | Pagination | Infinite scroll UX vs higher memory for page buttons |
| State management | Zustand stores | React Query | Simpler mental model vs built-in caching |
| Breaking news | Polling (30s) | WebSocket | Lower complexity vs real-time delivery |
| Image loading | Progressive blur-up | Lazy only | Better perceived performance vs more network requests |
| Keyboard nav | Custom hook | Focus trap library | Full control vs battle-tested accessibility |
| Reading progress | LocalStorage + sync | Server only | Offline support vs data consistency |

---

## Future Enhancements

1. **PWA with Offline Mode** - Service worker for cached articles
2. **WebSocket for Real-time** - Instant breaking news without polling
3. **Dark Mode** - System preference detection and manual toggle
4. **Text-to-Speech** - Accessibility feature for article reading
5. **Swipe Gestures** - Mobile-optimized story navigation
6. **Customizable Layout** - Grid vs list view, card density options

---

## Closing Summary

"I've designed a frontend architecture for a news aggregator with:

1. **Virtualized Story Feed** - Smooth scrolling through thousands of stories using @tanstack/react-virtual
2. **Breaking News System** - Real-time banner with dismiss functionality and notifications
3. **Search with Filters** - Autocomplete suggestions, topic/source/date filtering
4. **Zustand State Management** - Separate stores for feed, preferences, and reading progress
5. **Full Accessibility** - Keyboard navigation, screen reader support, skip links

The component architecture separates concerns clearly, with StoryCard handling display, StoryList managing virtualization, and dedicated hooks for reading progress and dwell time tracking. Performance is optimized through lazy loading, progressive images, and skeleton states. Happy to dive deeper into any component."
