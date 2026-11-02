import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { searchApi } from '../services/api';
import type { SearchResult } from '../types';

/** Renders a search bar with Gmail-style operator support and results dropdown. */
export function SearchBar() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const navigate = useNavigate();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);
    try {
      const response = await searchApi.search(query);
      setResults(response.results);
      setDegraded(Boolean(response.degraded));
      setShowResults(true);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleResultClick = (threadId: string) => {
    setShowResults(false);
    setQuery('');
    navigate({ to: '/thread/$threadId', params: { threadId } });
  };

  return (
    <div className="relative">
      <form onSubmit={handleSearch} className="relative">
        <div className="flex items-center bg-gray-100 rounded-full px-4 py-2 hover:bg-gray-200 hover:shadow-sm focus-within:bg-white focus-within:shadow-md transition-all">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            className="text-gmail-text-secondary mr-3 flex-shrink-0"
          >
            <path
              fill="currentColor"
              d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search mail"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setShowResults(true)}
            className="flex-1 bg-transparent outline-none text-sm text-gmail-text placeholder-gmail-text-secondary"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setShowResults(false);
              }}
              className="ml-2 text-gmail-text-secondary hover:text-gmail-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          )}
        </div>
      </form>

      {/* Search hint */}
      {showResults && (
        <div className="absolute top-full left-0 right-0 bg-white shadow-lg rounded-b-lg mt-1 z-50 max-h-96 overflow-y-auto">
          {isSearching ? (
            <div className="p-4 text-center text-gmail-text-secondary text-sm">
              Searching...
            </div>
          ) : degraded && results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gmail-text-secondary">
              Search is running in a limited mode; no exact matches found.
            </div>
          ) : results.length === 0 ? (
            <div className="p-4 text-center text-gmail-text-secondary text-sm">
              No results found. Try: from:alice, to:bob, has:attachment
            </div>
          ) : (
            results.map((result) => (
              <button
                key={result.messageId}
                onClick={() => handleResultClick(result.threadId)}
                className="w-full text-left px-4 py-3 hover:bg-gmail-hover border-b border-gmail-border last:border-0"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gmail-text">
                    {result.senderName}
                  </span>
                  <span className="text-xs text-gmail-text-secondary">
                    {result.senderEmail}
                  </span>
                </div>
                {/* The server escapes subjects and snippets; highlights add only <em>. */}
                <div
                  className="text-sm text-gmail-text truncate"
                  dangerouslySetInnerHTML={{ __html: result.subject }}
                />
                <div
                  className="text-xs text-gmail-text-secondary truncate mt-0.5"
                  dangerouslySetInnerHTML={{ __html: result.snippet }}
                />
              </button>
            ))
          )}
          <button
            onClick={() => setShowResults(false)}
            className="w-full text-center py-2 text-xs text-gmail-text-secondary hover:bg-gmail-hover"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
