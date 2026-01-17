import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, TrendingUp, Clock, Hash, User } from 'lucide-react';
import { useSearchStore } from '../stores/searchStore';
import { useAuthStore } from '../stores/authStore';

interface SearchBarProps {
  onSearch?: (query: string) => void;
  autoFocus?: boolean;
}

export function SearchBar({ onSearch, autoFocus = false }: SearchBarProps) {
  const [inputValue, setInputValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const {
    query,
    suggestions,
    trending,
    recentSearches,
    fetchSuggestions,
    fetchTrending,
    fetchRecentSearches,
    search,
    setQuery,
    clearSuggestions,
  } = useSearchStore();

  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    setInputValue(query);
  }, [query]);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    fetchTrending();
    if (isAuthenticated) {
      fetchRecentSearches();
    }
  }, [fetchTrending, fetchRecentSearches, isAuthenticated]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        !inputRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setInputValue(value);
      fetchSuggestions(value);
      setShowSuggestions(true);
    },
    [fetchSuggestions]
  );

  const handleSearch = useCallback(
    (searchQuery: string = inputValue) => {
      setQuery(searchQuery);
      setInputValue(searchQuery);
      search(searchQuery);
      setShowSuggestions(false);
      clearSuggestions();
      onSearch?.(searchQuery);
    },
    [inputValue, setQuery, search, clearSuggestions, onSearch]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch();
      } else if (e.key === 'Escape') {
        setShowSuggestions(false);
      }
    },
    [handleSearch]
  );

  const handleClear = useCallback(() => {
    setInputValue('');
    setQuery('');
    clearSuggestions();
    inputRef.current?.focus();
  }, [setQuery, clearSuggestions]);

  const getSuggestionIcon = (type: string) => {
    switch (type) {
      case 'hashtag':
        return <Hash className="w-4 h-4 text-blue-500" />;
      case 'user':
        return <User className="w-4 h-4 text-green-500" />;
      default:
        return <Search className="w-4 h-4 text-gray-400" />;
    }
  };

  const showDropdown =
    showSuggestions &&
    (suggestions.length > 0 ||
      (inputValue.length < 2 && (trending.length > 0 || recentSearches.length > 0)));

  return (
    <div className="relative w-full max-w-2xl">
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Search posts..."
          className="w-full pl-12 pr-12 py-3 text-lg border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white shadow-sm"
        />
        {inputValue && (
          <button
            onClick={handleClear}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-1 hover:bg-gray-100 rounded-full"
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          ref={suggestionsRef}
          className="absolute z-50 w-full mt-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
        >
          {suggestions.length > 0 ? (
            <ul className="py-2">
              {suggestions.map((suggestion, index) => (
                <li key={index}>
                  <button
                    onClick={() => handleSearch(suggestion.text)}
                    className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-50 text-left"
                  >
                    {getSuggestionIcon(suggestion.type)}
                    <span className="text-gray-900">{suggestion.text}</span>
                    <span className="text-xs text-gray-400 ml-auto capitalize">
                      {suggestion.type}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              {recentSearches.length > 0 && (
                <div className="py-2 border-b border-gray-100">
                  <div className="px-4 py-1 text-xs font-medium text-gray-500 uppercase flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    Recent Searches
                  </div>
                  <ul>
                    {recentSearches.slice(0, 5).map((search, index) => (
                      <li key={index}>
                        <button
                          onClick={() => handleSearch(search)}
                          className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-50 text-left"
                        >
                          <Clock className="w-4 h-4 text-gray-400" />
                          <span className="text-gray-700">{search}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {trending.length > 0 && (
                <div className="py-2">
                  <div className="px-4 py-1 text-xs font-medium text-gray-500 uppercase flex items-center gap-2">
                    <TrendingUp className="w-3 h-3" />
                    Trending
                  </div>
                  <ul>
                    {trending.slice(0, 5).map((item, index) => (
                      <li key={index}>
                        <button
                          onClick={() => handleSearch(item)}
                          className="w-full px-4 py-2 flex items-center gap-3 hover:bg-gray-50 text-left"
                        >
                          <TrendingUp className="w-4 h-4 text-orange-400" />
                          <span className="text-gray-700">{item}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
