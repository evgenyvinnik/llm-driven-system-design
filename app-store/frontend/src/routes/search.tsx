/**
 * @fileoverview Search results page route.
 * Displays filtered and sorted search results.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCatalogStore } from '../stores/catalogStore';
import { AppCard } from '../components/AppCard';

/**
 * Search query parameters.
 */
interface SearchParams {
  /** Search query string */
  q?: string;
  /** Category filter */
  category?: string;
  /** Price type filter */
  priceType?: 'free' | 'paid' | 'all';
  /** Sort order */
  sortBy?: string;
}

/** Search page route definition with query validation */
export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      q: typeof search.q === 'string' ? search.q : undefined,
      category: typeof search.category === 'string' ? search.category : undefined,
      priceType: search.priceType as SearchParams['priceType'],
      sortBy: typeof search.sortBy === 'string' ? search.sortBy : undefined,
    };
  },
  component: SearchPage,
});

function SearchPage() {
  const { q, category, priceType, sortBy } = Route.useSearch();
  const navigate = useNavigate();
  const { searchResults, pagination, searchApps, isLoading } = useCatalogStore();

  useEffect(() => {
    if (q) {
      const params: Record<string, string> = {};
      if (category) params.category = category;
      if (priceType) params.priceType = priceType;
      if (sortBy) params.sortBy = sortBy;
      searchApps(q, params);
    }
  }, [q, category, priceType, sortBy, searchApps]);

  const handleAppClick = (appId: string) => {
    navigate({ to: '/app/$id', params: { id: appId } });
  };

  const updateSearch = (updates: Partial<SearchParams>) => {
    navigate({
      to: '/search',
      search: { q, category, priceType, sortBy, ...updates },
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Search Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {q ? `Search results for "${q}"` : 'Search Apps'}
          </h1>
          {pagination && (
            <p className="text-gray-500">
              {pagination.total.toLocaleString()} results found
            </p>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <select
          value={priceType || 'all'}
          onChange={(e) => updateSearch({ priceType: e.target.value as SearchParams['priceType'] })}
          className="input w-auto"
        >
          <option value="all">All Prices</option>
          <option value="free">Free</option>
          <option value="paid">Paid</option>
        </select>

        <select
          value={sortBy || 'relevance'}
          onChange={(e) => updateSearch({ sortBy: e.target.value })}
          className="input w-auto"
        >
          <option value="relevance">Relevance</option>
          <option value="rating">Highest Rated</option>
          <option value="downloads">Most Downloaded</option>
          <option value="date">Newest</option>
        </select>
      </div>

      {/* Results */}
      {isLoading ? (
        <div className="card p-8 text-center text-gray-500">Loading...</div>
      ) : !q ? (
        <div className="card p-8 text-center text-gray-500">
          Enter a search term to find apps
        </div>
      ) : searchResults.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-gray-500 mb-4">No apps found for "{q}"</p>
          <p className="text-sm text-gray-400">Try different keywords or filters</p>
        </div>
      ) : (
        <div className="card divide-y divide-gray-100">
          {searchResults.map((app) => (
            <AppCard key={app.id} app={app} onClick={() => handleAppClick(app.id!)} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {Array.from({ length: Math.min(pagination.totalPages, 5) }, (_, i) => i + 1).map(
            (page) => (
              <button
                key={page}
                className={`w-10 h-10 rounded-lg ${
                  page === pagination.page
                    ? 'bg-primary-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {page}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
