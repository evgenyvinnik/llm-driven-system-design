/**
 * @fileoverview Categories listing page route.
 * Displays all app categories for browsing.
 */

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCatalogStore } from '../stores/catalogStore';

/** Categories page route definition */
export const Route = createFileRoute('/categories')({
  component: CategoriesPage,
});

/**
 * Categories listing page component.
 * Shows all categories with icons and subcategory counts.
 */
function CategoriesPage() {
  const navigate = useNavigate();
  const { categories, fetchCategories } = useCatalogStore();

  useEffect(() => {
    if (categories.length === 0) {
      fetchCategories();
    }
  }, [categories.length, fetchCategories]);

  const getCategoryIcon = (icon: string | null): string => {
    const icons: Record<string, string> = {
      gamepad: 'gamepad',
      briefcase: 'briefcase',
      users: 'users',
      camera: 'camera',
      film: 'film',
      book: 'book',
      heart: 'heart',
      'dollar-sign': 'dollar-sign',
      tool: 'tool',
      map: 'map',
    };
    return icons[icon || ''] || 'grid';
  };

  const getEmoji = (icon: string | null): string => {
    const emojis: Record<string, string> = {
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
    return emojis[icon || ''] || '📱';
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Browse Categories</h1>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {categories.map((category) => (
          <div
            key={category.id}
            className="card p-6 hover:shadow-lg transition-shadow cursor-pointer"
            onClick={() => navigate({ to: '/category/$slug', params: { slug: category.slug } })}
          >
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-100 to-primary-200 flex items-center justify-center text-3xl">
                {getEmoji(category.icon)}
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-gray-900 mb-1">{category.name}</h2>
                {category.description && (
                  <p className="text-sm text-gray-500 mb-3">{category.description}</p>
                )}

                {category.subcategories && category.subcategories.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {category.subcategories.slice(0, 3).map((sub) => (
                      <span
                        key={sub.id}
                        className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-full"
                      >
                        {sub.name}
                      </span>
                    ))}
                    {category.subcategories.length > 3 && (
                      <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-full">
                        +{category.subcategories.length - 3} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
