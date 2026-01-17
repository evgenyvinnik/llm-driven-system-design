/**
 * Search page route.
 * Provides full-text article search with results display.
 * @module routes/search
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { feedApi } from '../services/api';
import { useState, useEffect } from 'react';
import { Search, ExternalLink, Clock } from 'lucide-react';
import type { Article } from '../types';

/**
 * Search page route configuration.
 * Validates search query parameter and loads matching articles.
 */
export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>) => ({
    q: (search.q as string) || '',
  }),
  loaderDeps: ({ search: { q } }) => ({ q }),
  loader: async ({ deps: { q } }) => {
    if (!q || q.length < 2) {
      return { articles: [], query: q };
    }
    const response = await feedApi.search(q);
    return { articles: response.articles, query: q };
  },
  component: SearchPage,
});

/**
 * Format a date as a short readable string.
 * @param dateString - ISO 8601 timestamp string
 * @returns Formatted date (e.g., "Jan 15, 2024")
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Search page component.
 * Provides search input and displays matching article results.
 * @returns Search page with input form and result list
 */
function SearchPage() {
  const { articles, query } = Route.useLoaderData();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState(query);

  // Sync search input with URL query
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

  /**
   * Handle search form submission.
   * Navigates to search page with new query parameter.
   */
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      navigate({ to: '/search', search: { q: searchInput } });
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSearch} className="max-w-2xl">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search news articles..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-lg"
          />
        </div>
      </form>

      {query && (
        <p className="text-gray-600">
          {articles.length} result{articles.length !== 1 ? 's' : ''} for "{query}"
        </p>
      )}

      {articles.length === 0 && query && (
        <div className="text-center py-12 text-gray-500">
          <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No articles found for "{query}"</p>
          <p className="text-sm mt-2">Try different keywords or check the spelling</p>
        </div>
      )}

      <div className="space-y-4">
        {articles.map((article: Article) => (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="card block hover:border-primary-300"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="text-sm font-medium text-primary-600 mb-1">
                  {article.source_name}
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{article.title}</h3>
                <p className="text-sm text-gray-600 line-clamp-2">{article.summary}</p>
                <div className="mt-2 flex items-center gap-4">
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDate(article.published_at)}
                  </span>
                  {article.topics.slice(0, 3).map((topic) => (
                    <span key={topic} className="topic-badge">
                      {topic}
                    </span>
                  ))}
                </div>
              </div>
              <ExternalLink className="w-5 h-5 text-gray-400 flex-shrink-0" />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
