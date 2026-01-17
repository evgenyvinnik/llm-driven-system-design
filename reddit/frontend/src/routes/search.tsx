import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { Subreddit } from '../types';
import api from '../services/api';
import { formatNumber } from '../utils/format';

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>): { q?: string } => ({
    q: search.q as string | undefined,
  }),
});

function SearchPage() {
  const { q } = Route.useSearch();
  const [results, setResults] = useState<Subreddit[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!q) {
      setResults([]);
      return;
    }

    setIsLoading(true);
    api
      .searchSubreddits(q)
      .then(setResults)
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [q]);

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-lg font-medium mb-4">
        {q ? `Search results for "${q}"` : 'Search'}
      </h1>

      {isLoading ? (
        <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
          Searching...
        </div>
      ) : results.length === 0 ? (
        <div className="bg-white rounded border border-gray-200 p-8 text-center text-gray-500">
          {q ? 'No communities found.' : 'Enter a search term to find communities.'}
        </div>
      ) : (
        <div className="bg-white rounded border border-gray-200 divide-y divide-gray-200">
          {results.map((sub) => (
            <Link
              key={sub.id}
              to="/r/$subreddit"
              params={{ subreddit: sub.name }}
              className="block p-4 hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-reddit-blue rounded-full flex items-center justify-center text-white font-bold">
                  r/
                </div>
                <div className="flex-1">
                  <div className="font-medium">r/{sub.name}</div>
                  <div className="text-sm text-gray-500">
                    {formatNumber(sub.subscriber_count)} members
                  </div>
                  {sub.description && (
                    <p className="text-sm text-gray-600 line-clamp-1 mt-1">{sub.description}</p>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
