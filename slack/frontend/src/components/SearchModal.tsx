/**
 * @fileoverview Full-text search modal component.
 * Provides a search interface with debounced queries and result highlighting.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { searchApi } from '../services/api';
import { useWorkspaceStore, useUIStore } from '../stores';
import { formatMessageTime } from '../utils';
import type { SearchResult } from '../types';

/**
 * Search modal component.
 * Provides full-text search across all messages in the workspace.
 * Features debounced search input, result highlighting, and navigation
 * to the channel containing the selected message.
 */
export function SearchModal() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const { currentWorkspace } = useWorkspaceStore();
  const { isSearchOpen, setSearchOpen } = useUIStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const debounceTimer = setTimeout(() => {
      handleSearch();
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [query]);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      const searchResults = await searchApi.search(query.trim());
      setResults(searchResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResultClick = (result: SearchResult) => {
    setSearchOpen(false);
    navigate({
      to: '/workspace/$workspaceId/channel/$channelId',
      params: { workspaceId: currentWorkspace!.id, channelId: result.channel_id },
    });
  };

  const handleClose = () => {
    setSearchOpen(false);
    setQuery('');
    setResults([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  if (!isSearchOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50">
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[70vh] flex flex-col"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-200">
          <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 focus:outline-none text-lg"
            autoFocus
          />
          <button
            onClick={handleClose}
            className="p-1 hover:bg-gray-100 rounded text-gray-500"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center p-8">
              <div className="text-gray-500">Searching...</div>
            </div>
          )}

          {error && (
            <div className="p-4 text-red-500">{error}</div>
          )}

          {!isLoading && !error && query && results.length === 0 && (
            <div className="flex flex-col items-center justify-center p-8 text-gray-500">
              <p className="text-lg">No results found</p>
              <p className="text-sm">Try a different search term</p>
            </div>
          )}

          {!isLoading && results.length > 0 && (
            <div className="divide-y divide-gray-100">
              {results.map((result) => (
                <button
                  key={result.id}
                  onClick={() => handleResultClick(result)}
                  className="w-full text-left p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-gray-900">
                      {result.user?.display_name || result.user?.username}
                    </span>
                    <span className="text-xs text-gray-400">in</span>
                    <span className="text-sm text-slack-blue">#{result.channel_name}</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {formatMessageTime(result.created_at)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-700 line-clamp-2">
                    {result.highlight?.[0] ? (
                      <span dangerouslySetInnerHTML={{ __html: result.highlight[0] }} />
                    ) : (
                      result.content
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {!query && (
            <div className="flex flex-col items-center justify-center p-8 text-gray-500">
              <svg className="w-12 h-12 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <p className="text-lg">Search messages</p>
              <p className="text-sm">Find messages across all channels</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
