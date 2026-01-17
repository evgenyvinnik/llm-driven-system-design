import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { SearchBox } from '@/components/SearchBox';
import { useSearchStore } from '@/stores/searchStore';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  const { recentSearches } = useSearchStore();

  const handleSearch = (query: string) => {
    navigate({
      to: '/search',
      search: { q: query },
    });
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Header */}
      <header className="flex justify-end p-4 gap-4">
        <a
          href="/admin"
          className="text-sm text-gray-700 hover:underline"
        >
          Admin
        </a>
      </header>

      {/* Main content */}
      <main className="flex-1 flex flex-col items-center justify-center px-4 -mt-20">
        {/* Logo */}
        <div className="mb-8 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-search-blue flex items-center justify-center">
            <Search className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-4xl font-normal tracking-tight">
            <span className="text-search-blue">S</span>
            <span className="text-red-500">e</span>
            <span className="text-yellow-500">a</span>
            <span className="text-search-blue">r</span>
            <span className="text-green-500">c</span>
            <span className="text-red-500">h</span>
          </h1>
        </div>

        {/* Search box */}
        <div className="w-full max-w-[584px]">
          <SearchBox
            onSearch={handleSearch}
            size="large"
            autoFocus
            recentSearches={recentSearches}
          />
        </div>

        {/* Quick links */}
        <div className="mt-8 flex gap-3">
          <button
            onClick={() => handleSearch('programming tutorial')}
            className="px-4 py-2 text-sm bg-search-lightGray text-gray-700 rounded hover:border-gray-300 border border-transparent"
          >
            Programming Tutorial
          </button>
          <button
            onClick={() => handleSearch('web development')}
            className="px-4 py-2 text-sm bg-search-lightGray text-gray-700 rounded hover:border-gray-300 border border-transparent"
          >
            Web Development
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-search-lightGray border-t border-gray-200">
        <div className="px-8 py-3 border-b border-gray-200">
          <p className="text-sm text-gray-500">Educational Search Engine Demo</p>
        </div>
        <div className="px-8 py-3 flex justify-between text-sm text-gray-500">
          <div className="flex gap-6">
            <span>Built with React, Express, Elasticsearch</span>
          </div>
          <div className="flex gap-6">
            <a href="/admin" className="hover:underline">Admin Dashboard</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
