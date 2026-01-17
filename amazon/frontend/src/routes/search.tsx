import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { Product, Aggregations } from '../types';
import { ProductCard } from '../components/ProductCard';

interface SearchParams {
  q?: string;
  category?: string;
  minPrice?: string;
  maxPrice?: string;
  inStock?: string;
  sortBy?: string;
  page?: number;
}

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      q: (search.q as string) || '',
      category: search.category as string,
      minPrice: search.minPrice as string,
      maxPrice: search.maxPrice as string,
      inStock: search.inStock as string,
      sortBy: search.sortBy as string,
      page: Number(search.page) || 0,
    };
  },
  component: SearchPage,
});

function SearchPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [aggregations, setAggregations] = useState<Aggregations>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchResults() {
      setLoading(true);
      try {
        const result = await api.search(search);
        setProducts(result.products);
        setTotal(result.total);
        setAggregations(result.aggregations);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchResults();
  }, [search.q, search.category, search.minPrice, search.maxPrice, search.inStock, search.sortBy, search.page]);

  const updateFilter = (key: string, value: string | undefined) => {
    navigate({
      to: '/search',
      search: { ...search, [key]: value, page: 0 },
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex gap-6">
        {/* Filters Sidebar */}
        <aside className="w-64 flex-shrink-0">
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="font-bold text-lg mb-4">Filters</h2>

            {/* Categories */}
            {aggregations.categories?.buckets && aggregations.categories.buckets.length > 0 && (
              <div className="mb-6">
                <h3 className="font-medium mb-2">Category</h3>
                <div className="space-y-1">
                  {aggregations.categories.buckets.map((bucket) => (
                    <button
                      key={bucket.key}
                      onClick={() => updateFilter('category', search.category === bucket.key ? undefined : bucket.key)}
                      className={`block text-sm text-left w-full px-2 py-1 rounded ${
                        search.category === bucket.key
                          ? 'bg-amber-100 text-amber-800'
                          : 'hover:bg-gray-100'
                      }`}
                    >
                      {bucket.key} ({bucket.doc_count})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Price Range */}
            {aggregations.price_ranges?.buckets && (
              <div className="mb-6">
                <h3 className="font-medium mb-2">Price</h3>
                <div className="space-y-1">
                  {aggregations.price_ranges.buckets.map((bucket) => (
                    <button
                      key={bucket.key}
                      onClick={() => {
                        const [min, max] = bucket.key.includes('-')
                          ? bucket.key.replace(/[$,]/g, '').split('-').map((s: string) => s.trim())
                          : bucket.key.includes('Under')
                          ? ['', bucket.key.replace(/[^0-9]/g, '')]
                          : [bucket.key.replace(/[^0-9]/g, ''), ''];
                        updateFilter('minPrice', min || undefined);
                        updateFilter('maxPrice', max || undefined);
                      }}
                      className="block text-sm text-left w-full px-2 py-1 rounded hover:bg-gray-100"
                    >
                      {bucket.key} ({bucket.doc_count})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* In Stock */}
            <div className="mb-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={search.inStock === 'true'}
                  onChange={(e) => updateFilter('inStock', e.target.checked ? 'true' : undefined)}
                  className="w-4 h-4"
                />
                <span className="text-sm">In Stock Only</span>
              </label>
            </div>

            {/* Clear Filters */}
            <button
              onClick={() => navigate({ to: '/search', search: { q: search.q } })}
              className="w-full py-2 text-sm text-blue-600 hover:underline"
            >
              Clear all filters
            </button>
          </div>
        </aside>

        {/* Results */}
        <div className="flex-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              {search.q && (
                <h1 className="text-xl font-bold">
                  Results for "{search.q}"
                </h1>
              )}
              <p className="text-gray-500">{total} results</p>
            </div>

            <select
              value={search.sortBy || ''}
              onChange={(e) => updateFilter('sortBy', e.target.value || undefined)}
              className="border rounded px-3 py-2"
            >
              <option value="">Sort by: Relevance</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="rating">Avg. Customer Review</option>
              <option value="newest">Newest Arrivals</option>
            </select>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="animate-pulse">
                  <div className="aspect-square bg-gray-300 rounded-lg mb-2" />
                  <div className="h-4 bg-gray-300 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-gray-300 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-lg">No products found</p>
              <p className="text-gray-400 mt-2">Try adjusting your search or filters</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {products.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>

              {/* Pagination */}
              {total > 20 && (
                <div className="flex justify-center gap-2 mt-8">
                  <button
                    disabled={!search.page || search.page === 0}
                    onClick={() => navigate({ to: '/search', search: { ...search, page: (search.page || 0) - 1 } })}
                    className="px-4 py-2 border rounded disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="px-4 py-2">
                    Page {(search.page || 0) + 1} of {Math.ceil(total / 20)}
                  </span>
                  <button
                    disabled={(search.page || 0) >= Math.ceil(total / 20) - 1}
                    onClick={() => navigate({ to: '/search', search: { ...search, page: (search.page || 0) + 1 } })}
                    className="px-4 py-2 border rounded disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
