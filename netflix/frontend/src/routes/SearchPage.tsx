import React from 'react';
import { useSearch } from '@tanstack/react-router';
import { Navbar, VideoCard } from '../components';
import { useBrowseStore } from '../stores/browseStore';

export function SearchPage() {
  const searchParams = useSearch({ from: '/search' });
  const query = (searchParams as { q?: string }).q || '';

  const { searchResults, isLoading, search, clearSearch } = useBrowseStore();

  React.useEffect(() => {
    if (query) {
      search(query);
    } else {
      clearSearch();
    }
  }, [query, search, clearSearch]);

  return (
    <div className="min-h-screen bg-netflix-black">
      <Navbar />

      <div className="pt-24 px-4 md:px-12">
        {query && (
          <h1 className="text-white text-2xl mb-8">
            {isLoading ? 'Searching...' : `Results for "${query}"`}
          </h1>
        )}

        {!query && (
          <div className="text-center py-16">
            <p className="text-netflix-light-gray text-lg">
              Enter a search term to find movies and TV shows
            </p>
          </div>
        )}

        {query && !isLoading && searchResults.length === 0 && (
          <div className="text-center py-16">
            <p className="text-netflix-light-gray text-lg mb-4">
              No results found for "{query}"
            </p>
            <p className="text-netflix-gray">
              Try different keywords or browse our categories
            </p>
          </div>
        )}

        {searchResults.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {searchResults.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
