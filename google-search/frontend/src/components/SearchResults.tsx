import type { SearchResponse } from '@/types';
import { SearchResultItem } from './SearchResultItem';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface SearchResultsProps {
  results: SearchResponse;
  onPageChange: (page: number) => void;
}

export function SearchResults({ results, onPageChange }: SearchResultsProps) {
  if (results.results.length === 0) {
    return (
      <div className="py-8">
        <p className="text-lg text-gray-600">
          No results found for <strong>"{results.query}"</strong>
        </p>
        <p className="mt-2 text-sm text-gray-500">
          Try different keywords or check your spelling.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Results stats */}
      <p className="text-sm text-gray-500 mb-6">
        About {results.total.toLocaleString()} results ({(results.duration / 1000).toFixed(2)} seconds)
        {results.fromCache && <span className="ml-2 text-green-600">(cached)</span>}
      </p>

      {/* Results list */}
      <div className="space-y-1">
        {results.results.map((result) => (
          <SearchResultItem key={result.url_id} result={result} />
        ))}
      </div>

      {/* Pagination */}
      {results.totalPages > 1 && (
        <nav className="mt-8 mb-12 flex items-center justify-center gap-2">
          <button
            onClick={() => onPageChange(results.page - 1)}
            disabled={results.page === 1}
            className={`
              flex items-center gap-1 px-4 py-2 rounded-lg text-sm
              ${results.page === 1
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-search-blue hover:bg-blue-50'
              }
            `}
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          {/* Page numbers */}
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(10, results.totalPages) }, (_, i) => {
              const pageNum = i + 1;
              const isActive = pageNum === results.page;
              return (
                <button
                  key={pageNum}
                  onClick={() => onPageChange(pageNum)}
                  className={`
                    w-10 h-10 rounded-lg text-sm font-medium
                    ${isActive
                      ? 'bg-search-blue text-white'
                      : 'text-search-blue hover:bg-blue-50'
                    }
                  `}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => onPageChange(results.page + 1)}
            disabled={results.page === results.totalPages}
            className={`
              flex items-center gap-1 px-4 py-2 rounded-lg text-sm
              ${results.page === results.totalPages
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-search-blue hover:bg-blue-50'
              }
            `}
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </nav>
      )}
    </div>
  );
}
