import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { useSearchStore } from '../stores/search-store';
import { useDebounce, useClickOutside, useKeyboard } from '../hooks';
import type { Suggestion } from '../types';

interface SearchBoxProps {
  placeholder?: string;
  onSearch?: (query: string) => void;
  className?: string;
}

export function SearchBox({ placeholder = 'Search...', onSearch, className = '' }: SearchBoxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [announcement, setAnnouncement] = useState('');

  // Generate stable IDs for ARIA relationships
  const instanceId = useId();
  const listboxId = `searchbox-listbox-${instanceId}`;
  const getOptionId = (index: number) => `searchbox-option-${instanceId}-${index}`;

  const {
    query,
    suggestions,
    isLoading,
    error,
    responseTime,
    recentSearches,
    fuzzyEnabled: _fuzzyEnabled,
    setQuery,
    search,
    selectSuggestion,
    clearSuggestions,
  } = useSearchStore();

  // Debounced search
  const debouncedSearch = useDebounce((value: string) => {
    search(value);
  }, 150);

  // Announce changes to screen readers
  useEffect(() => {
    if (isOpen && suggestions.length > 0) {
      setAnnouncement(`${suggestions.length} suggestions available. Use up and down arrows to navigate.`);
    } else if (isOpen && query.trim() && suggestions.length === 0 && !isLoading) {
      setAnnouncement('No suggestions available.');
    }
  }, [suggestions.length, isOpen, query, isLoading]);

  // Announce selected item
  useEffect(() => {
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      setAnnouncement(`${suggestions[selectedIndex].phrase}, ${selectedIndex + 1} of ${suggestions.length}`);
    }
  }, [selectedIndex, suggestions]);

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
      clearSuggestions();
    }
  };

  // Handle suggestion selection
  const handleSelect = useCallback(
    (phrase: string) => {
      selectSuggestion(phrase);
      setIsOpen(false);
      setSelectedIndex(-1);
      onSearch?.(phrase);
      inputRef.current?.blur();
    },
    [selectSuggestion, onSearch]
  );

  // Handle form submit
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
      handleSelect(suggestions[selectedIndex].phrase);
    } else if (query.trim()) {
      handleSelect(query.trim());
    }
  };

  // Click outside to close
  useClickOutside(containerRef as React.RefObject<HTMLElement>, () => {
    setIsOpen(false);
  });

  // Keyboard navigation
  useKeyboard(
    {
      onArrowDown: () => {
        setSelectedIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
      },
      onArrowUp: () => {
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
      },
      onEnter: () => {
        if (selectedIndex >= 0 && suggestions[selectedIndex]) {
          handleSelect(suggestions[selectedIndex].phrase);
        }
      },
      onEscape: () => {
        setIsOpen(false);
        inputRef.current?.blur();
      },
    },
    isOpen
  );

  // Focus input to show recent searches
  const handleFocus = () => {
    if (!query.trim() && recentSearches.length > 0) {
      setIsOpen(true);
    } else if (suggestions.length > 0) {
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
    const isSelected = index === selectedIndex;

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
            {highlightMatch(suggestion.phrase, query)}
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

  // Render recent searches
  const renderRecentSearches = () => {
    if (query.trim() || recentSearches.length === 0) return null;

    return (
      <>
        <div className="px-4 py-2 text-xs text-gray-500 font-medium border-b">
          Recent Searches
        </div>
        {recentSearches.slice(0, 5).map((search, _index) => (
          <li
            key={search}
            className="px-4 py-2 cursor-pointer flex items-center gap-2 hover:bg-gray-50"
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
        ))}
      </>
    );
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <form onSubmit={handleSubmit}>
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={handleInputChange}
            onFocus={handleFocus}
            placeholder={placeholder}
            className="w-full px-4 py-3 pl-12 text-lg border border-gray-300 rounded-full shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
            autoComplete="off"
            spellCheck="false"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls={listboxId}
            aria-activedescendant={selectedIndex >= 0 ? getOptionId(selectedIndex) : undefined}
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

      {/* Dropdown */}
      {isOpen && (suggestions.length > 0 || recentSearches.length > 0 || error) && (
        <div className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden animate-fade-in">
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Search suggestions"
            className="suggestions-dropdown max-h-80 overflow-y-auto"
          >
            {error ? (
              <li className="px-4 py-3 text-red-500 text-sm">{error}</li>
            ) : suggestions.length > 0 ? (
              suggestions.map((suggestion, index) =>
                renderSuggestion(suggestion, index)
              )
            ) : (
              renderRecentSearches()
            )}
          </ul>

          {/* Footer */}
          {responseTime !== null && suggestions.length > 0 && (
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
