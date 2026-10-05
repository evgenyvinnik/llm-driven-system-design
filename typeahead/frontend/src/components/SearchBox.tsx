import { useState, useRef, useEffect, useId } from 'react';
import { useSearchStore } from '../stores/search-store';
import { useDebounce } from '../hooks';
import type { Suggestion } from '../types';

const MAX_RECENT_SHOWN = 5;

interface SearchBoxProps {
  placeholder?: string;
  onSearch?: (query: string) => void;
  className?: string;
}

/** Renders the typeahead search input with debounced suggestions, keyboard navigation, and search history. */
export function SearchBox({ placeholder = 'Search...', onSearch, className = '' }: SearchBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');

  // Generate stable IDs for ARIA relationships
  const instanceId = useId();
  const listboxId = `searchbox-listbox-${instanceId}`;
  const recentLabelId = `searchbox-recent-label-${instanceId}`;
  const getOptionId = (index: number) => `searchbox-option-${instanceId}-${index}`;

  const {
    query,
    suggestions,
    isLoading,
    error,
    responseTime,
    recentSearches,
    fuzzyEnabled,
    maxSuggestions,
    setQuery,
    search,
    selectSuggestion,
    clearSuggestions,
  } = useSearchStore();

  // Debounced search
  const debouncedSearch = useDebounce((value: string) => {
    search(value);
  }, 150);

  // The popup lists suggestions while there is a query and recent searches while the input is
  // empty. Keyboard navigation and Enter operate on whichever list is shown.
  const showingRecent = !query.trim();
  const options = showingRecent
    ? recentSearches.slice(0, MAX_RECENT_SHOWN)
    : suggestions.map(s => s.phrase);
  // aria-expanded and aria-controls follow whether the listbox is actually rendered
  const showListbox = isOpen && !error && options.length > 0;
  const showError = isOpen && !!error;
  const activeIndex = showListbox && selectedIndex < options.length ? selectedIndex : -1;

  // Announce changes to screen readers
  useEffect(() => {
    if (showError) {
      setAnnouncement(error ?? '');
    } else if (showListbox) {
      const what = showingRecent ? 'recent searches' : 'suggestions';
      setAnnouncement(`${options.length} ${what} available. Use up and down arrows to navigate.`);
    } else if (isOpen && !showingRecent && !isLoading) {
      setAnnouncement('No suggestions available.');
    }
  }, [showError, error, showListbox, showingRecent, options.length, isOpen, isLoading]);

  // Announce selected item
  const activePhrase = activeIndex >= 0 ? options[activeIndex] : null;
  useEffect(() => {
    if (activePhrase !== null) {
      setAnnouncement(`${activePhrase}, ${activeIndex + 1} of ${options.length}`);
    }
  }, [activePhrase, activeIndex, options.length]);

  // Re-run the current query when a search setting changes, so the list reflects the setting
  const lastSettings = useRef({ fuzzyEnabled, maxSuggestions });
  useEffect(() => {
    const last = lastSettings.current;
    if (last.fuzzyEnabled === fuzzyEnabled && last.maxSuggestions === maxSuggestions) return;
    lastSettings.current = { fuzzyEnabled, maxSuggestions };
    if (query.trim()) {
      setSelectedIndex(-1);
      search(query);
    }
  }, [fuzzyEnabled, maxSuggestions, query, search]);

  const closePopup = () => {
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  // Handle input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    setSelectedIndex(-1);
    if (value.trim()) {
      setIsOpen(true);
      debouncedSearch(value);
    } else {
      setIsOpen(false);
      debouncedSearch.cancel();
      clearSuggestions();
    }
  };

  // Handle suggestion selection. Focus stays on the input (combobox pattern).
  const handleSelect = (phrase: string) => {
    debouncedSearch.cancel();
    selectSuggestion(phrase);
    closePopup();
    onSearch?.(phrase);
  };

  // Handle form submit (Enter with no highlighted option submits the typed query)
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeIndex >= 0) {
      handleSelect(options[activeIndex]);
    } else if (query.trim()) {
      handleSelect(query.trim());
    }
  };

  // Keyboard navigation, scoped to the input so other controls keep their keys
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    switch (e.key) {
      case 'ArrowDown':
        if (options.length === 0) return;
        e.preventDefault();
        if (!showListbox) {
          setIsOpen(true);
          setSelectedIndex(0);
        } else {
          setSelectedIndex(activeIndex < options.length - 1 ? activeIndex + 1 : activeIndex);
        }
        break;
      case 'ArrowUp':
        if (!showListbox) return;
        e.preventDefault();
        setSelectedIndex(activeIndex > 0 ? activeIndex - 1 : -1);
        break;
      case 'Enter':
        if (activeIndex >= 0) {
          e.preventDefault(); // pick the option instead of submitting the typed text
          handleSelect(options[activeIndex]);
        }
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          closePopup();
        }
        break;
      case 'Tab':
        closePopup();
        break;
    }
  };

  // Focus input to show recent searches (empty query) or the current suggestions
  const handleFocus = () => {
    if (options.length > 0) {
      setIsOpen(true);
    }
  };

  // Highlight matching prefix in suggestion
  const highlightMatch = (text: string, prefix: string): React.ReactNode => {
    const lowerText = text.toLowerCase();
    const lowerPrefix = prefix.toLowerCase();
    const index = lowerText.indexOf(lowerPrefix);

    if (index === -1) {
      return text;
    }

    return (
      <>
        {text.slice(0, index)}
        <span className="highlight">{text.slice(index, index + prefix.length)}</span>
        {text.slice(index + prefix.length)}
      </>
    );
  };

  // Render suggestion item
  const renderSuggestion = (suggestion: Suggestion, index: number) => {
    const isSelected = index === activeIndex;

    return (
      <li
        key={suggestion.phrase}
        id={getOptionId(index)}
        role="option"
        aria-selected={isSelected}
        className={`px-4 py-2 cursor-pointer flex items-center justify-between transition-colors ${
          isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
        }`}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => handleSelect(suggestion.phrase)}
      >
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <span className="text-gray-800">
            {highlightMatch(suggestion.phrase, query.trim())}
          </span>
          {suggestion.isFuzzy && (
            <span className="text-xs text-gray-400 italic">(fuzzy match)</span>
          )}
        </div>
        <span className="text-xs text-gray-400">
          {formatCount(suggestion.count)}
        </span>
      </li>
    );
  };

  // Render recent search item
  const renderRecentSearch = (search: string, index: number) => {
    const isSelected = index === activeIndex;

    return (
      <li
        key={search}
        id={getOptionId(index)}
        role="option"
        aria-selected={isSelected}
        className={`px-4 py-2 cursor-pointer flex items-center gap-2 transition-colors ${
          isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
        }`}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => handleSelect(search)}
      >
        <svg
          className="w-4 h-4 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="text-gray-700">{search}</span>
      </li>
    );
  };

  return (
    <div className={`relative ${className}`}>
      <form onSubmit={handleSubmit}>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={handleInputChange}
            onFocus={handleFocus}
            onBlur={closePopup}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full px-4 py-3 pl-12 text-lg border border-gray-300 rounded-full shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            autoComplete="off"
            spellCheck="false"
            role="combobox"
            aria-expanded={showListbox}
            aria-controls={showListbox ? listboxId : undefined}
            aria-activedescendant={activeIndex >= 0 ? getOptionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-label="Search"
          />
          <div className="absolute left-4 top-1/2 -translate-y-1/2">
            <svg
              className="w-5 h-5 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </div>
          {isLoading && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      </form>

      {/* Dropdown. mousedown is cancelled so clicking an option keeps focus on the input. */}
      {(showListbox || showError) && (
        <div
          className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden animate-fade-in"
          onMouseDown={e => e.preventDefault()}
        >
          {showError ? (
            <div className="px-4 py-3 text-red-500 text-sm">{error}</div>
          ) : (
            <>
              {showingRecent && (
                <div
                  id={recentLabelId}
                  className="px-4 py-2 text-xs text-gray-500 font-medium border-b"
                >
                  Recent Searches
                </div>
              )}
              <ul
                id={listboxId}
                role="listbox"
                aria-label={showingRecent ? undefined : 'Search suggestions'}
                aria-labelledby={showingRecent ? recentLabelId : undefined}
                className="suggestions-dropdown max-h-80 overflow-y-auto"
              >
                {showingRecent
                  ? options.map(renderRecentSearch)
                  : suggestions.map(renderSuggestion)}
              </ul>
            </>
          )}

          {/* Footer */}
          {showListbox && !showingRecent && responseTime !== null && (
            <div className="px-4 py-2 bg-gray-50 border-t text-xs text-gray-400 flex items-center justify-between">
              <span>{suggestions.length} suggestions</span>
              <span>{responseTime}ms</span>
            </div>
          )}
        </div>
      )}

      {/* Live region for screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
    </div>
  );
}

// Format large numbers
function formatCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}
