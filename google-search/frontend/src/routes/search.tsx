import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { SearchBox } from '@/components/SearchBox';
import { SearchResults } from '@/components/SearchResults';
import { useSearchStore } from '@/stores/searchStore';

interface SearchParams {
  q?: string;
  page?: number;
}

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      q: (search.q as string) || '',
      page: Number(search.page) || 1,
    };
  },
});

function SearchPage() {
  const navigate = useNavigate();
  const { q: query, page } = Route.useSearch();
  const { results, isLoading, error, search, recentSearches } = useSearchStore();

  useEffect(() => {
    if (query) {
      search(query, page);
    }
  }, [query, page, search]);

  const handleSearch = (newQuery: string) => {
    navigate({
      to: '/search',
      search: { q: newQuery, page: 1 },
    });
  };

  const handlePageChange = (newPage: number) => {
    navigate({
      to: '/search',
      search: { q: query, page: newPage },
    });
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="sticky top-0 bg-white border-b border-gray-200 z-40">
        <div className="flex items-center gap-6 px-6 py-3">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 flex-shrink-0">
            <div className="w-8 h-8 rounded-full bg-search-blue flex items-center justify-center">
              <Search className="w-4 h-4 text-white" />
            </div>
            <span className="text-xl font-normal hidden sm:block">
              <span className="text-search-blue">S</span>
              <span className="text-red-500">e</span>
              <span className="text-yellow-500">a</span>
              <span className="text-search-blue">r</span>
              <span className="text-green-500">c</span>
              <span className="text-red-500">h</span>
            </span>
          </Link>

          {/* Search box */}
          <div className="flex-1 max-w-2xl">
            <SearchBox
              initialValue={query || ''}
              onSearch={handleSearch}
              size="small"
              recentSearches={recentSearches}
            />
          </div>

          {/* Admin link */}
          <Link
            to="/admin"
            className="text-sm text-gray-600 hover:underline hidden sm:block"
          >
            Admin
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="px-6 py-4 max-w-4xl">
        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-search-blue animate-spin" />
            <span className="ml-3 text-gray-600">Searching...</span>
          </div>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <div className="py-8">
            <p className="text-red-600">Error: {error}</p>
            <p className="mt-2 text-sm text-gray-500">
              Please try again or check if the backend is running.
            </p>
          </div>
        )}

        {/* Results */}
        {results && !isLoading && (
          <SearchResults results={results} onPageChange={handlePageChange} />
        )}

        {/* No query */}
        {!query && !isLoading && !results && (
          <div className="py-8 text-center">
            <p className="text-gray-600">Enter a search query to get started.</p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 bg-search-lightGray border-t border-gray-200 px-6 py-3">
        <p className="text-sm text-gray-500">Educational Search Engine Demo</p>
      </footer>
    </div>
  );
}
