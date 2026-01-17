import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Filter, MapPin, Star } from 'lucide-react';
import { BusinessCard } from '../components/BusinessCard';
import { useSearchStore } from '../stores/searchStore';
import type { Category } from '../types';
import api from '../services/api';

interface SearchParams {
  q?: string;
  category?: string;
  location?: string;
  minRating?: string;
  maxPrice?: string;
  sortBy?: string;
}

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      q: (search.q as string) || undefined,
      category: (search.category as string) || undefined,
      location: (search.location as string) || undefined,
      minRating: (search.minRating as string) || undefined,
      maxPrice: (search.maxPrice as string) || undefined,
      sortBy: (search.sortBy as string) || undefined,
    };
  },
  component: SearchPage,
});

function SearchPage() {
  const search = Route.useSearch();
  const { businesses, isLoading, pagination, search: performSearch } = useSearchStore();
  const [categories, setCategories] = useState<Category[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const [filters, setFilters] = useState({
    query: search.q || '',
    category: search.category || '',
    minRating: search.minRating ? parseInt(search.minRating) : undefined,
    maxPriceLevel: search.maxPrice ? parseInt(search.maxPrice) : undefined,
    sortBy: (search.sortBy as 'relevance' | 'rating' | 'review_count' | 'distance') || 'relevance',
  });

  useEffect(() => {
    loadCategories();
    handleSearch();
  }, []);

  useEffect(() => {
    handleSearch();
  }, [search.q, search.category]);

  const loadCategories = async () => {
    try {
      const response = await api.get<{ categories: Category[] }>('/categories');
      setCategories(response.categories);
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  };

  const handleSearch = () => {
    performSearch({
      query: search.q || filters.query,
      category: search.category || filters.category,
      minRating: filters.minRating,
      maxPriceLevel: filters.maxPriceLevel,
      sortBy: filters.sortBy,
    });
  };

  const handleFilterChange = (key: string, value: unknown) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const applyFilters = () => {
    performSearch(filters);
    setShowFilters(false);
  };

  const handlePageChange = (page: number) => {
    performSearch(filters, page);
    window.scrollTo(0, 0);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex gap-8">
        {/* Sidebar Filters - Desktop */}
        <aside className="hidden lg:block w-64 flex-shrink-0">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="font-semibold text-lg mb-4">Filters</h3>

            {/* Categories */}
            <div className="mb-6">
              <h4 className="font-medium text-gray-900 mb-2">Categories</h4>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="category"
                    checked={!filters.category}
                    onChange={() => handleFilterChange('category', '')}
                    className="mr-2"
                  />
                  <span className="text-sm">All Categories</span>
                </label>
                {categories.slice(0, 10).map((cat) => (
                  <label key={cat.id} className="flex items-center">
                    <input
                      type="radio"
                      name="category"
                      checked={filters.category === cat.slug}
                      onChange={() => handleFilterChange('category', cat.slug)}
                      className="mr-2"
                    />
                    <span className="text-sm">{cat.name}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Rating */}
            <div className="mb-6">
              <h4 className="font-medium text-gray-900 mb-2">Minimum Rating</h4>
              <div className="space-y-2">
                {[0, 2, 3, 4, 4.5].map((rating) => (
                  <label key={rating} className="flex items-center">
                    <input
                      type="radio"
                      name="rating"
                      checked={filters.minRating === rating || (!filters.minRating && rating === 0)}
                      onChange={() => handleFilterChange('minRating', rating || undefined)}
                      className="mr-2"
                    />
                    <span className="text-sm flex items-center">
                      {rating === 0 ? (
                        'Any'
                      ) : (
                        <>
                          {rating}+ <Star className="w-3 h-3 fill-yelp-red text-yelp-red ml-1" />
                        </>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Price */}
            <div className="mb-6">
              <h4 className="font-medium text-gray-900 mb-2">Price</h4>
              <div className="flex gap-2">
                {[1, 2, 3, 4].map((price) => (
                  <button
                    key={price}
                    onClick={() =>
                      handleFilterChange(
                        'maxPriceLevel',
                        filters.maxPriceLevel === price ? undefined : price
                      )
                    }
                    className={`px-3 py-1 border rounded ${
                      filters.maxPriceLevel === price
                        ? 'bg-yelp-red text-white border-yelp-red'
                        : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    {'$'.repeat(price)}
                  </button>
                ))}
              </div>
            </div>

            <button onClick={applyFilters} className="btn-primary w-full">
              Apply Filters
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1">
          {/* Search Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {search.q ? `Results for "${search.q}"` : 'All Businesses'}
              </h1>
              {pagination && (
                <p className="text-gray-600 mt-1">
                  {pagination.total} results found
                </p>
              )}
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="lg:hidden btn-outline flex items-center gap-2"
              >
                <Filter className="w-4 h-4" />
                Filters
              </button>

              <select
                value={filters.sortBy}
                onChange={(e) => {
                  handleFilterChange('sortBy', e.target.value);
                  performSearch({ ...filters, sortBy: e.target.value as typeof filters.sortBy });
                }}
                className="input-field w-auto"
              >
                <option value="relevance">Relevance</option>
                <option value="rating">Highest Rated</option>
                <option value="review_count">Most Reviewed</option>
                <option value="distance">Distance</option>
              </select>
            </div>
          </div>

          {/* Mobile Filters */}
          {showFilters && (
            <div className="lg:hidden bg-white rounded-lg shadow p-4 mb-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Category</label>
                  <select
                    value={filters.category}
                    onChange={(e) => handleFilterChange('category', e.target.value)}
                    className="input-field"
                  >
                    <option value="">All Categories</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.slug}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Min Rating</label>
                  <select
                    value={filters.minRating || ''}
                    onChange={(e) =>
                      handleFilterChange('minRating', e.target.value ? parseInt(e.target.value) : undefined)
                    }
                    className="input-field"
                  >
                    <option value="">Any</option>
                    <option value="2">2+ stars</option>
                    <option value="3">3+ stars</option>
                    <option value="4">4+ stars</option>
                  </select>
                </div>
              </div>
              <button onClick={applyFilters} className="btn-primary w-full mt-4">
                Apply
              </button>
            </div>
          )}

          {/* Results */}
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="flex gap-4">
                    <div className="w-32 h-32 bg-gray-200 rounded" />
                    <div className="flex-1 space-y-2">
                      <div className="h-5 bg-gray-200 rounded w-1/3" />
                      <div className="h-4 bg-gray-200 rounded w-1/4" />
                      <div className="h-4 bg-gray-200 rounded w-1/2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : businesses.length > 0 ? (
            <>
              <div className="space-y-4">
                {businesses.map((business, index) => (
                  <BusinessCard
                    key={business.id}
                    business={business}
                    rank={(pagination?.page || 1 - 1) * (pagination?.limit || 20) + index + 1}
                  />
                ))}
              </div>

              {/* Pagination */}
              {pagination && pagination.pages > 1 && (
                <div className="flex justify-center mt-8 gap-2">
                  {[...Array(Math.min(pagination.pages, 10))].map((_, i) => (
                    <button
                      key={i}
                      onClick={() => handlePageChange(i + 1)}
                      className={`px-4 py-2 rounded ${
                        pagination.page === i + 1
                          ? 'bg-yelp-red text-white'
                          : 'bg-white border hover:bg-gray-50'
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <MapPin className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                No businesses found
              </h3>
              <p className="text-gray-600">
                Try adjusting your search or filters
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
