import { Loader2 } from 'lucide-react';
import { useSearchStore } from '../stores/searchStore';
import { SearchResultCard } from './SearchResultCard';

interface SearchResultsProps {
  onHashtagClick?: (hashtag: string) => void;
}

export function SearchResults({ onHashtagClick }: SearchResultsProps) {
  const { results, isLoading, error, totalResults, searchTime, query, nextCursor, loadMore } =
    useSearchStore();

  if (isLoading && results.length === 0) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        <p className="font-medium">Search Error</p>
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  if (query && results.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-gray-400 text-6xl mb-4">:(</div>
        <h3 className="text-lg font-medium text-gray-700 mb-2">No results found</h3>
        <p className="text-gray-500">
          Try different keywords or check your spelling
        </p>
      </div>
    );
  }

  if (!query) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Results header */}
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>
          About {totalResults.toLocaleString()} results ({(searchTime / 1000).toFixed(2)} seconds)
        </span>
      </div>

      {/* Results list */}
      <div className="space-y-4">
        {results.map((result) => (
          <SearchResultCard
            key={result.post_id}
            result={result}
            onHashtagClick={onHashtagClick}
          />
        ))}
      </div>

      {/* Load more */}
      {nextCursor && (
        <div className="flex justify-center pt-4">
          <button
            onClick={loadMore}
            disabled={isLoading}
            className="px-6 py-2 bg-primary-500 text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 flex items-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </>
            ) : (
              'Load More'
            )}
          </button>
        </div>
      )}
    </div>
  );
}
