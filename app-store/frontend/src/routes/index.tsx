/**
 * @fileoverview Home page route.
 * Displays top app charts, new releases, and category browsing.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCatalogStore } from '../stores/catalogStore';
import { AppCard } from '../components/AppCard';

/** Home page route definition */
export const Route = createFileRoute('/')({
  component: HomePage,
});

/**
 * Home page component.
 * Shows top free/paid apps, new releases, and category grid.
 */
function HomePage() {
  const navigate = useNavigate();
  const { categories, topApps, fetchCategories, fetchTopApps, isLoading } = useCatalogStore();

  useEffect(() => {
    fetchCategories();
    fetchTopApps('free');
    fetchTopApps('paid');
    fetchTopApps('new');
  }, [fetchCategories, fetchTopApps]);

  const handleAppClick = (appId: string) => {
    navigate({ to: '/app/$id', params: { id: appId } });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero Section */}
      <section className="mb-12">
        <div className="bg-gradient-to-r from-primary-600 to-primary-800 rounded-2xl p-8 text-white">
          <h1 className="text-3xl font-bold mb-2">Discover Amazing Apps</h1>
          <p className="text-primary-100 text-lg">
            Explore thousands of apps for productivity, entertainment, and more.
          </p>
        </div>
      </section>

      {/* Top Free Apps */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Top Free Apps</h2>
          <button className="text-primary-600 hover:text-primary-700 font-medium">
            See All
          </button>
        </div>
        <div className="card divide-y divide-gray-100">
          {isLoading && topApps.free.length === 0 ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : topApps.free.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No apps found</div>
          ) : (
            topApps.free.map((app, index) => (
              <div key={app.id} className="flex items-center gap-4">
                <span className="w-8 text-center text-xl font-bold text-gray-300">
                  {index + 1}
                </span>
                <div className="flex-1">
                  <AppCard app={app} onClick={() => handleAppClick(app.id)} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Top Paid Apps */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Top Paid Apps</h2>
          <button className="text-primary-600 hover:text-primary-700 font-medium">
            See All
          </button>
        </div>
        <div className="card divide-y divide-gray-100">
          {topApps.paid.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No paid apps found</div>
          ) : (
            topApps.paid.map((app, index) => (
              <div key={app.id} className="flex items-center gap-4">
                <span className="w-8 text-center text-xl font-bold text-gray-300">
                  {index + 1}
                </span>
                <div className="flex-1">
                  <AppCard app={app} onClick={() => handleAppClick(app.id)} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* New Apps */}
      <section className="mb-12">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-900">New Releases</h2>
          <button className="text-primary-600 hover:text-primary-700 font-medium">
            See All
          </button>
        </div>
        <div className="card divide-y divide-gray-100">
          {topApps.new.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No new apps found</div>
          ) : (
            topApps.new.map((app, index) => (
              <div key={app.id} className="flex items-center gap-4">
                <span className="w-8 text-center text-xl font-bold text-gray-300">
                  {index + 1}
                </span>
                <div className="flex-1">
                  <AppCard app={app} onClick={() => handleAppClick(app.id)} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Categories */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-900">Browse Categories</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => navigate({ to: '/category/$slug', params: { slug: category.slug } })}
              className="card p-4 hover:shadow-md transition-shadow text-left"
            >
              <div className="w-10 h-10 rounded-lg bg-primary-100 flex items-center justify-center mb-3">
                <span className="text-primary-600 text-xl">{getCategoryIcon(category.icon)}</span>
              </div>
              <h3 className="font-medium text-gray-900">{category.name}</h3>
              {category.subcategories && (
                <p className="text-sm text-gray-500">
                  {category.subcategories.length} subcategories
                </p>
              )}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Maps category icon names to emoji representations.
 * @param icon - Icon name from the API
 * @returns Emoji string for the category
 */
function getCategoryIcon(icon: string | null): string {
  const icons: Record<string, string> = {
    gamepad: '🎮',
    briefcase: '💼',
    users: '👥',
    camera: '📷',
    film: '🎬',
    book: '📚',
    heart: '❤️',
    'dollar-sign': '💰',
    tool: '🔧',
    map: '🗺️',
  };
  return icons[icon || ''] || '📱';
}
