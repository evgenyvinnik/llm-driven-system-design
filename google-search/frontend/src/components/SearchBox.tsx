import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X, Clock, TrendingUp } from 'lucide-react';
import { useAutocomplete } from '@/hooks/useAutocomplete';

interface SearchBoxProps {
  initialValue?: string;
  onSearch: (query: string) => void;
  size?: 'large' | 'small';
  autoFocus?: boolean;
  showSuggestions?: boolean;
  recentSearches?: string[];
}

export function SearchBox({
  initialValue = '',
  onSearch,
  size = 'large',
  autoFocus = false,
  showSuggestions = true,
  recentSearches = [],
}: SearchBoxProps) {
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    query,
    setQuery,
    suggestions,
    selectedIndex,
    setSelectedIndex,
    handleKeyDown,
    clearSuggestions,
    selectedSuggestion,
  } = useAutocomplete();

  useEffect(() => {
    setQuery(initialValue);
  }, [initialValue, setQuery]);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsFocused(false);
        clearSuggestions();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [clearSuggestions]);

  const handleSubmit = useCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    const searchQuery = selectedSuggestion || query;
    if (searchQuery.trim()) {
      onSearch(searchQuery.trim());
      clearSuggestions();
      inputRef.current?.blur();
    }
  }, [query, selectedSuggestion, onSearch, clearSuggestions]);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else {
      handleKeyDown(e);
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setQuery(suggestion);
    onSearch(suggestion);
    clearSuggestions();
  };

  const handleClear = () => {
    setQuery('');
    clearSuggestions();
    inputRef.current?.focus();
  };

  const showDropdown = isFocused && showSuggestions && (suggestions.length > 0 || recentSearches.length > 0);

  const isLarge = size === 'large';

  return (
    <div ref={containerRef} className="relative w-full">
      <form onSubmit={handleSubmit}>
        <div
          className={`
            flex items-center bg-white border rounded-full transition-shadow
            ${isFocused ? 'shadow-md border-transparent' : 'border-search-border hover:shadow-md'}
            ${isLarge ? 'h-12 px-5' : 'h-10 px-4'}
          `}
        >
          <Search
            className={`text-gray-400 flex-shrink-0 ${isLarge ? 'w-5 h-5' : 'w-4 h-4'}`}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search the web"
            className={`
              flex-1 outline-none bg-transparent
              ${isLarge ? 'mx-4 text-base' : 'mx-3 text-sm'}
            `}
            autoComplete="off"
            spellCheck="false"
          />
          {query && (
            <button
              type="button"
              onClick={handleClear}
              className="p-1 hover:bg-gray-100 rounded-full transition-colors"
            >
              <X className={`text-gray-500 ${isLarge ? 'w-5 h-5' : 'w-4 h-4'}`} />
            </button>
          )}
          <div className="border-l border-gray-200 h-6 mx-3" />
          <button
            type="submit"
            className={`
              text-search-blue hover:text-search-blueHover transition-colors
              ${isLarge ? 'p-1' : 'p-0.5'}
            `}
          >
            <Search className={`${isLarge ? 'w-5 h-5' : 'w-4 h-4'}`} />
          </button>
        </div>
      </form>

      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-search-border rounded-2xl shadow-lg overflow-hidden z-50">
          {suggestions.length > 0 && (
            <ul className="py-2">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion}
                  className={`
                    flex items-center px-5 py-2 cursor-pointer
                    ${index === selectedIndex ? 'bg-gray-100' : 'hover:bg-gray-50'}
                  `}
                  onClick={() => handleSuggestionClick(suggestion)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <Search className="w-4 h-4 text-gray-400 mr-3" />
                  <span className="text-sm">{suggestion}</span>
                </li>
              ))}
            </ul>
          )}

          {suggestions.length === 0 && recentSearches.length > 0 && (
            <>
              <div className="px-5 py-2 text-xs text-gray-500 flex items-center gap-2 border-b border-gray-100">
                <Clock className="w-3 h-3" />
                Recent searches
              </div>
              <ul className="py-2">
                {recentSearches.slice(0, 5).map((search, index) => (
                  <li
                    key={search}
                    className={`
                      flex items-center px-5 py-2 cursor-pointer
                      ${index === selectedIndex ? 'bg-gray-100' : 'hover:bg-gray-50'}
                    `}
                    onClick={() => handleSuggestionClick(search)}
                  >
                    <TrendingUp className="w-4 h-4 text-gray-400 mr-3" />
                    <span className="text-sm">{search}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
