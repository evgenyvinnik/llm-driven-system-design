/**
 * MobileTypeahead - Full-screen mobile typeahead experience.
 */
import { useRef, useEffect, useState } from 'react';
import { useTypeahead } from '../../hooks/useTypeahead.js';
import { getHistory, clearHistory, type HistoryEntry } from '../../db/database.js';
import type { MobileTypeaheadProps } from './types.js';

export function MobileTypeahead({
  title: _title = 'Search',
  showCancel = true,
  cancelText = 'Cancel',
  fullScreen = true,
  placeholder = 'Search...',
  userId,
  limit = 10,
  fuzzy = true,
  minChars = 1,
  debounceMs = 150,
  onSelect,
  onSubmit,
  className = '',
  disabled = false,
  autoFocus = true,
}: MobileTypeaheadProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [recentSearches, setRecentSearches] = useState<HistoryEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const typeahead = useTypeahead({
    debounceMs,
    limit,
    userId,
    fuzzy,
    minChars,
    onSelect: (phrase) => {
      onSelect?.(phrase);
      setIsExpanded(false);
    },
    onSubmit: (query) => {
      onSubmit?.(query);
      setIsExpanded(false);
    },
  });

  // Load recent searches when expanded
  useEffect(() => {
    if (isExpanded) {
      getHistory(5).then(setRecentSearches);
    }
  }, [isExpanded]);

  // Focus input when expanded
  useEffect(() => {
    if (isExpanded && autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded, autoFocus]);

  // Prevent body scroll when expanded
  useEffect(() => {
    if (fullScreen && isExpanded) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [isExpanded, fullScreen]);

  const handleCancel = () => {
    setIsExpanded(false);
    typeahead.setQuery('');
    typeahead.setIsOpen(false);
  };

  const handleClearHistory = async () => {
    await clearHistory();
    setRecentSearches([]);
  };

  // Collapsed state - show search button
  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        disabled={disabled}
        className={`flex items-center gap-2 w-full px-4 py-3 bg-gray-100 dark:bg-gray-800 rounded-xl text-gray-500 dark:text-gray-400 ${className}`}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <span>{placeholder}</span>
      </button>
    );
  }

  // Expanded state - full screen overlay
  return (
    <div
      className={`fixed inset-0 z-50 bg-white dark:bg-gray-900 ${fullScreen ? '' : 'top-0'} ${className}`}
    >
      {/* Header */}
      <div className="sticky top-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 safe-area-top">
        <div className="flex items-center gap-3 p-4">
          {/* Back button */}
          <button
            onClick={handleCancel}
            className="flex-shrink-0 p-1 -ml-1 text-gray-600 dark:text-gray-400"
            aria-label="Go back"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>

          {/* Search input */}
          <div className="flex-1 relative">
            <input
              ref={inputRef}
              type="text"
              value={typeahead.query}
              onChange={(e) => typeahead.setQuery(e.target.value)}
              onKeyDown={typeahead.handleKeyDown}
              placeholder={placeholder}
              className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-full text-gray-900 dark:text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-blue-500"
              {...typeahead.inputProps}
            />

            {/* Clear button */}
            {typeahead.query && (
              <button
                onClick={() => typeahead.setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Cancel button */}
          {showCancel && (
            <button
              onClick={handleCancel}
              className="flex-shrink-0 text-blue-600 dark:text-blue-400 font-medium"
            >
              {cancelText}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pb-safe">
        {/* Loading indicator */}
        {typeahead.isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {/* Suggestions */}
        {typeahead.suggestions.length > 0 && (
          <ul {...typeahead.listboxProps}>
            {typeahead.suggestions.map((suggestion, index) => (
              <li
                key={suggestion.phrase}
                onClick={() => typeahead.selectSuggestion(index)}
                className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 ${
                  typeahead.highlightedIndex === index
                    ? 'bg-blue-50 dark:bg-blue-900/30'
                    : 'active:bg-gray-100 dark:active:bg-gray-800'
                }`}
                {...typeahead.getOptionProps(index)}
              >
                <svg
                  className="w-5 h-5 text-gray-400 flex-shrink-0"
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
                <div className="flex-1 min-w-0">
                  <div className="text-gray-900 dark:text-white truncate">
                    {suggestion.phrase}
                  </div>
                  {suggestion.count > 0 && (
                    <div className="text-sm text-gray-500">
                      {suggestion.count.toLocaleString()} searches
                    </div>
                  )}
                </div>
                <svg
                  className="w-5 h-5 text-gray-300 dark:text-gray-600 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 17l9.2-9.2M17 17V7H7"
                  />
                </svg>
              </li>
            ))}
          </ul>
        )}

        {/* Recent searches (when no query) */}
        {!typeahead.query && recentSearches.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800/50">
              <span className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Recent Searches
              </span>
              <button
                onClick={handleClearHistory}
                className="text-sm text-blue-600 dark:text-blue-400"
              >
                Clear
              </button>
            </div>
            <ul>
              {recentSearches.map((entry) => (
                <li
                  key={entry.phrase}
                  onClick={() => {
                    typeahead.setQuery(entry.phrase);
                  }}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 active:bg-gray-100 dark:active:bg-gray-800"
                >
                  <svg
                    className="w-5 h-5 text-gray-400 flex-shrink-0"
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
                  <span className="flex-1 text-gray-900 dark:text-white truncate">
                    {entry.phrase}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Empty state */}
        {typeahead.query &&
          !typeahead.isLoading &&
          typeahead.suggestions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500 dark:text-gray-400">
              <svg
                className="w-12 h-12 mb-4 text-gray-300 dark:text-gray-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-lg font-medium">No results found</p>
              <p className="text-sm mt-1">Try a different search term</p>
            </div>
          )}
      </div>
    </div>
  );
}
