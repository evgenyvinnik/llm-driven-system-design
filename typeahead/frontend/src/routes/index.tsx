import { createFileRoute } from '@tanstack/react-router';
import { SearchBox, TrendingList, SearchSettings } from '../components';
import { useSearchStore } from '../stores/search-store';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { setQuery, search } = useSearchStore();

  const handleTrendingSelect = (phrase: string) => {
    setQuery(phrase);
    search(phrase);
  };

  const handleSearch = (query: string) => {
    console.log('Search submitted:', query);
    // In a real app, this would navigate to search results
  };

  return (
    <div className="min-h-[calc(100vh-12rem)]">
      {/* Hero section with search */}
      <div className="bg-gradient-to-b from-blue-50 to-white py-16 lg:py-24">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <h1 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            Search Anything
          </h1>
          <p className="text-lg text-gray-600 mb-8">
            Experience lightning-fast autocomplete with intelligent suggestions
          </p>

          <SearchBox
            placeholder="Start typing to search..."
            onSearch={handleSearch}
            className="max-w-2xl mx-auto"
          />

          <p className="mt-4 text-sm text-gray-500">
            Try typing "javascript", "weather", or "react"
          </p>
        </div>
      </div>

      {/* Content section */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Features */}
          <div className="lg:col-span-2 space-y-6">
            <h2 className="text-2xl font-bold text-gray-900">Features</h2>

            <div className="grid sm:grid-cols-2 gap-4">
              <FeatureCard
                icon={
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                }
                title="Low Latency"
                description="Sub-50ms response times using trie-based prefix matching and Redis caching."
              />

              <FeatureCard
                icon={
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                }
                title="Popularity Ranking"
                description="Suggestions ranked by frequency, recency, and trending signals."
              />

              <FeatureCard
                icon={
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                }
                title="Personalization"
                description="User-specific suggestions based on search history."
              />

              <FeatureCard
                icon={
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                }
                title="Real-time Updates"
                description="Trending topics surface within minutes of becoming popular."
              />
            </div>

            {/* How it works */}
            <div className="mt-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">How It Works</h2>
              <div className="bg-white rounded-lg shadow p-6 space-y-4">
                <Step
                  number={1}
                  title="Type a prefix"
                  description="As you type, the frontend sends requests to the suggestion API."
                />
                <Step
                  number={2}
                  title="Trie lookup"
                  description="The backend traverses a trie data structure to find matching prefixes in O(prefix length) time."
                />
                <Step
                  number={3}
                  title="Ranking"
                  description="Results are ranked using popularity, recency, personalization, and trending signals."
                />
                <Step
                  number={4}
                  title="Display"
                  description="Top suggestions are returned and displayed in real-time as you type."
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            <TrendingList onSelect={handleTrendingSelect} />
            <SearchSettings />
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="text-blue-600">{icon}</div>
        <h3 className="font-semibold text-gray-900">{title}</h3>
      </div>
      <p className="text-sm text-gray-600">{description}</p>
    </div>
  );
}

function Step({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center font-semibold">
        {number}
      </div>
      <div>
        <h4 className="font-medium text-gray-900">{title}</h4>
        <p className="text-sm text-gray-600">{description}</p>
      </div>
    </div>
  );
}
