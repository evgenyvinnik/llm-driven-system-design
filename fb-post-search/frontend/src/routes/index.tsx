import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { SearchBar } from '../components/SearchBar';
import { SearchResults } from '../components/SearchResults';
import { SearchFilters } from '../components/SearchFilters';
import { useSearchStore } from '../stores/searchStore';

function IndexPage() {
  const { query, search, setQuery } = useSearchStore();

  const handleHashtagClick = useCallback(
    (hashtag: string) => {
      setQuery(hashtag);
      search(hashtag);
    },
    [setQuery, search]
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Search Section */}
      <div className="mb-8">
        <div className="flex flex-col items-center gap-4 mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Search Posts</h1>
          <p className="text-gray-500">
            Find posts from your friends and the community
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-4 items-center justify-center">
          <SearchBar autoFocus />
          <SearchFilters />
        </div>
      </div>

      {/* Results Section */}
      {query && (
        <div className="mt-8">
          <SearchResults onHashtagClick={handleHashtagClick} />
        </div>
      )}

      {/* Welcome message when no search */}
      {!query && (
        <div className="text-center py-16">
          <div className="text-6xl mb-4">🔍</div>
          <h2 className="text-2xl font-semibold text-gray-700 mb-2">
            Start Searching
          </h2>
          <p className="text-gray-500 max-w-md mx-auto">
            Enter a keyword, hashtag, or phrase to find posts. Try searching for
            &quot;birthday&quot;, &quot;#tech&quot;, or &quot;coffee&quot;.
          </p>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: IndexPage,
});
