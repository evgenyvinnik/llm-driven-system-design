/**
 * @fileoverview Category detail page route.
 * Shows apps within a specific category.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCatalogStore } from '../stores/catalogStore';
import { AppCard } from '../components/AppCard';

/** Category detail page route definition */
export const Route = createFileRoute('/category/$slug')({
  component: CategoryPage,
});

/**
 * Category detail page component.
 * Lists all apps in the selected category.
 */
function CategoryPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const { categories, apps, fetchApps, fetchCategories, isLoading } = useCatalogStore();

  const category = categories.find((c) => c.slug === slug) ||
    categories.flatMap((c) => c.subcategories || []).find((c) => c.slug === slug);

  useEffect(() => {
    if (categories.length === 0) {
      fetchCategories();
    }
  }, [categories.length, fetchCategories]);

  useEffect(() => {
    if (slug) {
      fetchApps({ category: slug });
    }
  }, [slug, fetchApps]);

  const handleAppClick = (appId: string) => {
    navigate({ to: '/app/$id', params: { id: appId } });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {category?.name || 'Category'}
        </h1>
        {category?.description && (
          <p className="text-gray-500">{category.description}</p>
        )}
      </div>

      {/* Subcategories */}
      {category?.subcategories && category.subcategories.length > 0 && (
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
          {category.subcategories.map((sub) => (
            <button
              key={sub.id}
              onClick={() => navigate({ to: '/category/$slug', params: { slug: sub.slug } })}
              className="px-4 py-2 bg-white border border-gray-200 rounded-full text-sm font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
            >
              {sub.name}
            </button>
          ))}
        </div>
      )}

      {/* Apps */}
      {isLoading ? (
        <div className="card p-8 text-center text-gray-500">Loading...</div>
      ) : apps.length === 0 ? (
        <div className="card p-8 text-center text-gray-500">
          No apps found in this category
        </div>
      ) : (
        <div className="card divide-y divide-gray-100">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} onClick={() => handleAppClick(app.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
