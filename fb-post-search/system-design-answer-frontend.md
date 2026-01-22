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

```typescript
interface SearchBarProps {
  placeholder?: string;
  onSearch: (query: string) => void;
  autoFocus?: boolean;
}

export function SearchBar({ placeholder, onSearch, autoFocus }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const {
    suggestions,
    searchHistory,
    isLoadingSuggestions,
    fetchSuggestions,
    clearSuggestions
  } = useSearchStore();

  // Debounced suggestion fetching
  const debouncedFetch = useMemo(
    () => debounce((query: string) => {
      if (query.length >= 2) {
        fetchSuggestions(query);
      } else {
        clearSuggestions();
      }
    }, 150),
    [fetchSuggestions, clearSuggestions]
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    setSelectedIndex(-1);
    debouncedFetch(value);

    if (value.length > 0) {
      setIsOpen(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = getSuggestionItems();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, items.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && items[selectedIndex]) {
          handleSelect(items[selectedIndex]);
        } else {
          handleSubmit();
        }
        break;
      case 'Escape':
        setIsOpen(false);
        inputRef.current?.blur();
        break;
    }
  };

  const handleSubmit = () => {
    if (inputValue.trim()) {
      onSearch(inputValue.trim());
      setIsOpen(false);
    }
  };

  const handleSelect = (suggestion: Suggestion) => {
    setInputValue(suggestion.text);
    onSearch(suggestion.text);
    setIsOpen(false);
  };

  const getSuggestionItems = (): Suggestion[] => {
    if (inputValue.length < 2) {
      // Show recent searches when input is short
      return searchHistory.slice(0, 5).map(h => ({
        type: 'history',
        text: h.query,
        icon: 'clock'
      }));
    }
    return suggestions;
  };

  return (
    <div className="search-bar" role="combobox" aria-expanded={isOpen}>
      <div className="search-input-container">
        <SearchIcon className="search-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder ?? 'Search posts'}
          autoFocus={autoFocus}
          aria-label="Search posts"
          aria-autocomplete="list"
          aria-controls="search-suggestions"
          aria-activedescendant={
            selectedIndex >= 0 ? `suggestion-${selectedIndex}` : undefined
          }
        />
        {inputValue && (
          <button
            className="clear-button"
            onClick={() => {
              setInputValue('');
              clearSuggestions();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <XIcon />
          </button>
        )}
        {isLoadingSuggestions && <Spinner className="loading-spinner" />}
      </div>

      {isOpen && (
        <SuggestionDropdown
          suggestions={getSuggestionItems()}
          selectedIndex={selectedIndex}
          onSelect={handleSelect}
          onClose={() => setIsOpen(false)}
        />
      )}
    </div>
  );
}
```

**Suggestion Dropdown:**

```typescript
interface SuggestionDropdownProps {
  suggestions: Suggestion[];
  selectedIndex: number;
  onSelect: (suggestion: Suggestion) => void;
  onClose: () => void;
}

function SuggestionDropdown({
  suggestions,
  selectedIndex,
  onSelect,
  onClose
}: SuggestionDropdownProps) {
  const dropdownRef = useRef<HTMLUListElement>(null);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <ul
      ref={dropdownRef}
      id="search-suggestions"
      className="suggestion-dropdown"
      role="listbox"
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={`${suggestion.type}-${suggestion.text}`}
          id={`suggestion-${index}`}
          role="option"
          aria-selected={index === selectedIndex}
          className={cn(
            'suggestion-item',
            index === selectedIndex && 'selected'
          )}
          onClick={() => onSelect(suggestion)}
        >
          <SuggestionIcon type={suggestion.type} />
          <HighlightedText text={suggestion.text} />
          {suggestion.type === 'history' && (
            <button
              className="remove-history"
              onClick={(e) => {
                e.stopPropagation();
                // Remove from history
              }}
              aria-label={`Remove ${suggestion.text} from history`}
            >
              <XIcon size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
```

**CSS Styling:**

```css
.search-bar {
  position: relative;
  width: 100%;
  max-width: 600px;
}

.search-input-container {
  display: flex;
  align-items: center;
  background: var(--surface-secondary);
  border-radius: 24px;
  padding: 8px 16px;
  transition: box-shadow 0.2s ease;
}

.search-input-container:focus-within {
  box-shadow: 0 0 0 2px var(--primary-color);
  background: var(--surface-primary);
}

.search-input-container input {
  flex: 1;
  border: none;
  background: transparent;
  font-size: 16px;
  padding: 4px 8px;
  outline: none;
}

.search-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.suggestion-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--surface-primary);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  max-height: 400px;
  overflow-y: auto;
  z-index: 100;
}

.suggestion-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.suggestion-item:hover,
.suggestion-item.selected {
  background: var(--surface-hover);
}

.suggestion-item[aria-selected="true"] {
  background: var(--primary-light);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .search-bar {
    max-width: 100%;
  }

  .search-input-container {
    border-radius: 8px;
  }

  .suggestion-dropdown {
    position: fixed;
    top: 60px;
    left: 0;
    right: 0;
    margin: 0;
    border-radius: 0;
    max-height: calc(100vh - 60px);
  }
}
```

---

#### Deep-Dive B: Search Results with Virtualization (8 minutes)

**Virtualized Results List:**

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

interface SearchResultsProps {
  query: string;
}

export function SearchResults({ query }: SearchResultsProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    results,
    isLoading,
    hasMore,
    fetchNextPage,
    isFetchingNextPage
  } = useSearchStore();

  const virtualizer = useVirtualizer({
    count: hasMore ? results.length + 1 : results.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180, // Estimated post card height
    overscan: 5,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // Infinite scroll trigger
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;

    if (
      lastItem.index >= results.length - 1 &&
      hasMore &&
      !isFetchingNextPage
    ) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasMore, isFetchingNextPage, results.length]);

  if (isLoading && results.length === 0) {
    return <SearchResultsSkeleton />;
  }

  if (results.length === 0) {
    return <EmptyState query={query} />;
  }

  return (
    <div className="search-results">
      <ResultsHeader count={results.length} query={query} />

      <div
        ref={parentRef}
        className="results-scroll-container"
        role="feed"
        aria-busy={isLoading}
        aria-label={`Search results for ${query}`}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative'
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const isLoaderRow = virtualRow.index >= results.length;

            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`
                }}
              >
                {isLoaderRow ? (
                  <LoadingIndicator />
                ) : (
                  <PostCard
                    post={results[virtualRow.index]}
                    query={query}
                    index={virtualRow.index}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

**PostCard with Highlighting:**

```typescript
interface PostCardProps {
  post: SearchResult;
  query: string;
  index: number;
}

const PostCard = memo(function PostCard({ post, query, index }: PostCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <article
      className="post-card"
      aria-posinset={index + 1}
      aria-setsize={-1}
    >
      <header className="post-header">
        <Avatar
          src={post.author.avatar_url}
          alt={post.author.display_name}
          size={40}
        />
        <div className="post-meta">
          <a href={`/profile/${post.author.id}`} className="author-name">
            {post.author.display_name}
            {post.author.is_verified && <VerifiedBadge />}
          </a>
          <time dateTime={post.created_at} className="post-time">
            {formatRelativeTime(post.created_at)}
          </time>
        </div>
        <PostMenu postId={post.id} />
      </header>

      <div className="post-content">
        <HighlightedContent
          content={post.content}
          highlights={post.highlights}
          query={query}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded(!isExpanded)}
        />
      </div>

      {post.media && post.media.length > 0 && (
        <MediaGrid media={post.media} />
      )}

      <footer className="post-footer">
        <EngagementStats
          likes={post.like_count}
          comments={post.comment_count}
          shares={post.share_count}
        />
        <PostActions postId={post.id} />
      </footer>
    </article>
  );
});
```

**Highlight Rendering:**

```typescript
interface HighlightedContentProps {
  content: string;
  highlights: Highlight[];
  query: string;
  isExpanded: boolean;
  onToggle: () => void;
}

function HighlightedContent({
  content,
  highlights,
  query,
  isExpanded,
  onToggle
}: HighlightedContentProps) {
  const TRUNCATE_LENGTH = 280;

  // Use server-provided highlights if available, otherwise compute client-side
  const effectiveHighlights = highlights.length > 0
    ? highlights
    : computeHighlights(content, query);

  // Build highlighted segments
  const segments = useMemo(() => {
    const result: Array<{ text: string; highlighted: boolean }> = [];
    let lastIndex = 0;

    // Sort highlights by start position
    const sorted = [...effectiveHighlights].sort((a, b) => a.start - b.start);

    for (const highlight of sorted) {
      // Add non-highlighted text before this highlight
      if (highlight.start > lastIndex) {
        result.push({
          text: content.slice(lastIndex, highlight.start),
          highlighted: false
        });
      }

      // Add highlighted text
      result.push({
        text: content.slice(highlight.start, highlight.end),
        highlighted: true
      });

      lastIndex = highlight.end;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      result.push({
        text: content.slice(lastIndex),
        highlighted: false
      });
    }

    return result;
  }, [content, effectiveHighlights]);

  // Truncate if needed
  const displayContent = useMemo(() => {
    if (isExpanded || content.length <= TRUNCATE_LENGTH) {
      return segments;
    }

    // Find truncation point that doesn't break a highlight
    let charCount = 0;
    const truncated: typeof segments = [];

    for (const segment of segments) {
      if (charCount + segment.text.length <= TRUNCATE_LENGTH) {
        truncated.push(segment);
        charCount += segment.text.length;
      } else {
        const remaining = TRUNCATE_LENGTH - charCount;
        truncated.push({
          text: segment.text.slice(0, remaining) + '...',
          highlighted: segment.highlighted
        });
        break;
      }
    }

    return truncated;
  }, [segments, isExpanded]);

  return (
    <div className="highlighted-content">
      <p>
        {displayContent.map((segment, i) =>
          segment.highlighted ? (
            <mark key={i} className="search-highlight">
              {segment.text}
            </mark>
          ) : (
            <span key={i}>{segment.text}</span>
          )
        )}
      </p>

      {content.length > TRUNCATE_LENGTH && (
        <button
          className="toggle-expand"
          onClick={onToggle}
          aria-expanded={isExpanded}
        >
          {isExpanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// Client-side highlight computation fallback
function computeHighlights(content: string, query: string): Highlight[] {
  const highlights: Highlight[] = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  const contentLower = content.toLowerCase();

  for (const word of words) {
    let startIndex = 0;
    while (true) {
      const index = contentLower.indexOf(word, startIndex);
      if (index === -1) break;

      highlights.push({
        start: index,
        end: index + word.length
      });

      startIndex = index + 1;
    }
  }

  return highlights;
}
```

---

#### Deep-Dive C: State Management with Zustand (8 minutes)

**Search Store:**

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

interface SearchFilters {
  dateRange: { start: Date; end: Date } | null;
  postType: 'all' | 'text' | 'photo' | 'video' | 'link';
  authorId: string | null;
}

interface SearchHistoryItem {
  query: string;
  timestamp: number;
  resultCount: number;
}

interface SearchState {
  // Query state
  query: string;
  filters: SearchFilters;

  // Suggestions
  suggestions: Suggestion[];
  isLoadingSuggestions: boolean;

  // Results
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  isFetchingNextPage: boolean;

  // History
  searchHistory: SearchHistoryItem[];
  savedSearches: SavedSearch[];

  // Actions
  setQuery: (query: string) => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  resetFilters: () => void;

  fetchSuggestions: (query: string) => Promise<void>;
  clearSuggestions: () => void;

  executeSearch: (query?: string) => Promise<void>;
  fetchNextPage: () => Promise<void>;
  clearResults: () => void;

  saveCurrentSearch: () => void;
  removeSavedSearch: (id: string) => void;
  clearHistory: () => void;
}

const DEFAULT_FILTERS: SearchFilters = {
  dateRange: null,
  postType: 'all',
  authorId: null
};

export const useSearchStore = create<SearchState>()(
  persist(
    immer((set, get) => ({
      // Initial state
      query: '',
      filters: DEFAULT_FILTERS,
      suggestions: [],
      isLoadingSuggestions: false,
      results: [],
      isLoading: false,
      error: null,
      hasMore: false,
      nextCursor: null,
      isFetchingNextPage: false,
      searchHistory: [],
      savedSearches: [],

      // Query actions
      setQuery: (query) => set({ query }),

      setFilters: (newFilters) => set((state) => {
        state.filters = { ...state.filters, ...newFilters };
      }),

      resetFilters: () => set({ filters: DEFAULT_FILTERS }),

      // Suggestion actions
      fetchSuggestions: async (query) => {
        set({ isLoadingSuggestions: true });

        try {
          const response = await searchApi.getSuggestions(query);
          set({
            suggestions: response.suggestions,
            isLoadingSuggestions: false
          });
        } catch (error) {
          console.error('Failed to fetch suggestions:', error);
          set({ isLoadingSuggestions: false });
        }
      },

      clearSuggestions: () => set({ suggestions: [] }),

      // Search actions
      executeSearch: async (searchQuery) => {
        const { query, filters } = get();
        const effectiveQuery = searchQuery ?? query;

        if (!effectiveQuery.trim()) return;

        set({
          query: effectiveQuery,
          isLoading: true,
          error: null,
          results: [],
          nextCursor: null
        });

        try {
          const response = await searchApi.search({
            query: effectiveQuery,
            filters,
            limit: 20
          });

          set((state) => {
            state.results = response.results;
            state.hasMore = response.has_more;
            state.nextCursor = response.next_cursor;
            state.isLoading = false;

            // Add to history
            state.searchHistory.unshift({
              query: effectiveQuery,
              timestamp: Date.now(),
              resultCount: response.total
            });

            // Keep only last 50 history items
            if (state.searchHistory.length > 50) {
              state.searchHistory = state.searchHistory.slice(0, 50);
            }
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Search failed',
            isLoading: false
          });
        }
      },

      fetchNextPage: async () => {
        const { query, filters, nextCursor, isFetchingNextPage } = get();

        if (!nextCursor || isFetchingNextPage) return;

        set({ isFetchingNextPage: true });

        try {
          const response = await searchApi.search({
            query,
            filters,
            cursor: nextCursor,
            limit: 20
          });

          set((state) => {
            state.results.push(...response.results);
            state.hasMore = response.has_more;
            state.nextCursor = response.next_cursor;
            state.isFetchingNextPage = false;
          });
        } catch (error) {
          console.error('Failed to fetch next page:', error);
          set({ isFetchingNextPage: false });
        }
      },

      clearResults: () => set({
        results: [],
        hasMore: false,
        nextCursor: null,
        error: null
      }),

      // History actions
      saveCurrentSearch: () => {
        const { query, filters } = get();
        if (!query.trim()) return;

        set((state) => {
          state.savedSearches.push({
            id: crypto.randomUUID(),
            query,
            filters,
            createdAt: Date.now()
          });
        });
      },

      removeSavedSearch: (id) => set((state) => {
        state.savedSearches = state.savedSearches.filter(s => s.id !== id);
      }),

      clearHistory: () => set({ searchHistory: [] })
    })),
    {
      name: 'search-storage',
      partialize: (state) => ({
        searchHistory: state.searchHistory,
        savedSearches: state.savedSearches
      })
    }
  )
);
```

**Custom Hooks:**

```typescript
// Hook for search with URL sync
export function useSearchWithUrl() {
  const navigate = useNavigate();
  const { q, type, from, to } = useSearch({ from: '/search' });
  const { setQuery, setFilters, executeSearch } = useSearchStore();

  // Sync URL params to store on mount
  useEffect(() => {
    if (q) {
      setQuery(q);
      setFilters({
        postType: type ?? 'all',
        dateRange: from && to ? { start: new Date(from), end: new Date(to) } : null
      });
      executeSearch(q);
    }
  }, []);

  // Update URL when search is executed
  const searchWithUrl = useCallback((query: string) => {
    const { filters } = useSearchStore.getState();

    const params = new URLSearchParams();
    params.set('q', query);

    if (filters.postType !== 'all') {
      params.set('type', filters.postType);
    }

    if (filters.dateRange) {
      params.set('from', filters.dateRange.start.toISOString());
      params.set('to', filters.dateRange.end.toISOString());
    }

    navigate({ search: params.toString() });
    executeSearch(query);
  }, [navigate, executeSearch]);

  return { searchWithUrl };
}

// Hook for debounced suggestions
export function useSuggestions(inputValue: string) {
  const { suggestions, isLoadingSuggestions, fetchSuggestions, clearSuggestions } = useSearchStore();

  const debouncedFetch = useDebouncedCallback(
    (value: string) => {
      if (value.length >= 2) {
        fetchSuggestions(value);
      } else {
        clearSuggestions();
      }
    },
    150
  );

  useEffect(() => {
    debouncedFetch(inputValue);
    return () => debouncedFetch.cancel();
  }, [inputValue, debouncedFetch]);

  return { suggestions, isLoading: isLoadingSuggestions };
}
```

---

#### Deep-Dive D: Filter Panel and Responsive Layout (7 minutes)

**Filter Panel Component:**

```typescript
interface FilterPanelProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function FilterPanel({ isOpen, onToggle }: FilterPanelProps) {
  const { filters, setFilters, resetFilters, executeSearch } = useSearchStore();
  const [localFilters, setLocalFilters] = useState(filters);

  const handleApply = () => {
    setFilters(localFilters);
    executeSearch();
    onToggle();
  };

  const handleReset = () => {
    resetFilters();
    setLocalFilters(DEFAULT_FILTERS);
    executeSearch();
  };

  return (
    <aside
      className={cn('filter-panel', isOpen && 'open')}
      aria-label="Search filters"
      aria-hidden={!isOpen}
    >
      <header className="filter-header">
        <h2>Filters</h2>
        <button
          className="close-filters"
          onClick={onToggle}
          aria-label="Close filters"
        >
          <XIcon />
        </button>
      </header>

      <div className="filter-content">
        {/* Date Range */}
        <fieldset className="filter-group">
          <legend>Date Range</legend>
          <DateRangePicker
            value={localFilters.dateRange}
            onChange={(dateRange) =>
              setLocalFilters(prev => ({ ...prev, dateRange }))
            }
            presets={[
              { label: 'Past 24 hours', value: { start: subDays(new Date(), 1), end: new Date() } },
              { label: 'Past week', value: { start: subWeeks(new Date(), 1), end: new Date() } },
              { label: 'Past month', value: { start: subMonths(new Date(), 1), end: new Date() } },
              { label: 'Past year', value: { start: subYears(new Date(), 1), end: new Date() } }
            ]}
          />
        </fieldset>

        {/* Post Type */}
        <fieldset className="filter-group">
          <legend>Post Type</legend>
          <RadioGroup
            value={localFilters.postType}
            onChange={(postType) =>
              setLocalFilters(prev => ({ ...prev, postType }))
            }
            options={[
              { value: 'all', label: 'All types' },
              { value: 'text', label: 'Text posts' },
              { value: 'photo', label: 'Photos' },
              { value: 'video', label: 'Videos' },
              { value: 'link', label: 'Links' }
            ]}
          />
        </fieldset>

        {/* Author Filter */}
        <fieldset className="filter-group">
          <legend>Posted by</legend>
          <AuthorAutocomplete
            value={localFilters.authorId}
            onChange={(authorId) =>
              setLocalFilters(prev => ({ ...prev, authorId }))
            }
            placeholder="Search for a person..."
          />
        </fieldset>
      </div>

      <footer className="filter-actions">
        <button
          className="btn-secondary"
          onClick={handleReset}
        >
          Reset
        </button>
        <button
          className="btn-primary"
          onClick={handleApply}
        >
          Apply Filters
        </button>
      </footer>
    </aside>
  );
}
```

**Responsive Search Layout:**

```typescript
export function SearchPage() {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const { query, results, isLoading } = useSearchStore();
  const { searchWithUrl } = useSearchWithUrl();

  return (
    <div className="search-page">
      <header className="search-header">
        <SearchBar
          onSearch={searchWithUrl}
          autoFocus
        />
        <button
          className="filter-toggle"
          onClick={() => setIsFilterOpen(!isFilterOpen)}
          aria-expanded={isFilterOpen}
          aria-controls="filter-panel"
        >
          <FilterIcon />
          <span className="sr-only">Toggle filters</span>
          {hasActiveFilters() && <ActiveFilterBadge />}
        </button>
      </header>

      <div className="search-layout">
        <FilterPanel
          isOpen={isFilterOpen}
          onToggle={() => setIsFilterOpen(false)}
        />

        <main className="search-main">
          {query ? (
            <SearchResults query={query} />
          ) : (
            <SearchLanding />
          )}
        </main>
      </div>
    </div>
  );
}
```

**CSS Layout:**

```css
.search-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.search-header {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--surface-primary);
  border-bottom: 1px solid var(--border-color);
}

.search-layout {
  display: flex;
  flex: 1;
}

.filter-panel {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  background: var(--surface-secondary);
  padding: 16px;
  overflow-y: auto;
}

.search-main {
  flex: 1;
  padding: 16px;
  max-width: 680px;
  margin: 0 auto;
}

/* Mobile: Filters as slide-over */
@media (max-width: 768px) {
  .filter-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-width: 320px;
    z-index: 100;
    transform: translateX(100%);
    transition: transform 0.3s ease;
  }

  .filter-panel.open {
    transform: translateX(0);
  }

  .filter-panel::before {
    content: '';
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: -1;
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  .filter-panel.open::before {
    opacity: 1;
  }

  .search-main {
    padding: 12px;
    max-width: 100%;
  }
}

/* Tablet */
@media (min-width: 769px) and (max-width: 1024px) {
  .filter-panel {
    width: 240px;
  }
}

/* Results container */
.results-scroll-container {
  height: calc(100vh - 180px);
  overflow-y: auto;
}

/* Post card */
.post-card {
  background: var(--surface-primary);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  box-shadow: var(--shadow-sm);
}

/* Highlight styling */
.search-highlight {
  background: var(--highlight-color, #fff3cd);
  padding: 1px 2px;
  border-radius: 2px;
  font-weight: 500;
}

/* Dark mode */
@media (prefers-color-scheme: dark) {
  .search-highlight {
    background: rgba(255, 213, 79, 0.3);
  }
}
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

```typescript
// ARIA live region for search status
function SearchStatus() {
  const { isLoading, results, error } = useSearchStore();

  const message = useMemo(() => {
    if (isLoading) return 'Searching...';
    if (error) return `Error: ${error}`;
    if (results.length === 0) return 'No results found';
    return `Found ${results.length} results`;
  }, [isLoading, results, error]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}

// Keyboard navigation for results
function useResultsNavigation() {
  const { results } = useSearchStore();
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setFocusedIndex(prev => Math.min(prev + 1, results.length - 1));
        }
        break;
      case 'k':
      case 'ArrowUp':
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setFocusedIndex(prev => Math.max(prev - 1, 0));
        }
        break;
      case 'Enter':
        if (focusedIndex >= 0) {
          // Navigate to post
        }
        break;
    }
  }, [results, focusedIndex]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return { focusedIndex, setFocusedIndex };
}
```

---

### 7. Future Enhancements

1. **Voice Search**: Add Web Speech API integration for voice queries
2. **Advanced Filters**: Save filter presets, boolean operators
3. **Result Previews**: Hover/long-press to preview full post
4. **Search Analytics**: Track popular queries, zero-result searches
5. **Offline Support**: Service worker caching for recent results
6. **Keyboard Shortcuts**: Power-user navigation (j/k, /, Escape)
7. **Dark Mode**: System preference detection with manual override
8. **Internationalization**: RTL support, translated UI
