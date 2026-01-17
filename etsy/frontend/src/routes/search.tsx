import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { Product } from '../types';
import { ProductCard } from '../components/ProductCard';

interface SearchParams {
  q?: string;
  categoryId?: string;
  priceMin?: string;
  priceMax?: string;
  isVintage?: string;
  isHandmade?: string;
  sort?: string;
}

export const Route = createFileRoute('/search')({
  component: SearchPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      q: search.q as string | undefined,
      categoryId: search.categoryId as string | undefined,
      priceMin: search.priceMin as string | undefined,
      priceMax: search.priceMax as string | undefined,
      isVintage: search.isVintage as string | undefined,
      isHandmade: search.isHandmade as string | undefined,
      sort: search.sort as string | undefined,
    };
  },
});

function SearchPage() {
  const search = Route.useSearch();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState({
    priceMin: search.priceMin || '',
    priceMax: search.priceMax || '',
    isVintage: search.isVintage === 'true',
    isHandmade: search.isHandmade === 'true',
    sort: search.sort || 'relevance',
  });

  useEffect(() => {
    async function fetchProducts() {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.q) params.set('q', search.q);
        if (search.categoryId) params.set('categoryId', search.categoryId);
        if (filters.priceMin) params.set('priceMin', filters.priceMin);
        if (filters.priceMax) params.set('priceMax', filters.priceMax);
        if (filters.isVintage) params.set('isVintage', 'true');
        if (filters.isHandmade) params.set('isHandmade', 'true');
        if (filters.sort) params.set('sort', filters.sort);

        const response = await api.get<{ products: Product[]; total: number }>(
          `/products/search?${params.toString()}`
        );
        setProducts(response.products);
        setTotal(response.total);
      } catch (error) {
        console.error('Search error:', error);
        // Fallback to regular products endpoint
        try {
          const response = await api.get<{ products: Product[] }>('/products');
          setProducts(response.products);
          setTotal(response.products.length);
        } catch {
          setProducts([]);
          setTotal(0);
        }
      } finally {
        setIsLoading(false);
      }
    }
    fetchProducts();
  }, [search.q, search.categoryId, filters]);

  const applyFilters = () => {
    const params = new URLSearchParams(window.location.search);
    if (filters.priceMin) params.set('priceMin', filters.priceMin);
    else params.delete('priceMin');
    if (filters.priceMax) params.set('priceMax', filters.priceMax);
    else params.delete('priceMax');
    if (filters.isVintage) params.set('isVintage', 'true');
    else params.delete('isVintage');
    if (filters.isHandmade) params.set('isHandmade', 'true');
    else params.delete('isHandmade');
    if (filters.sort !== 'relevance') params.set('sort', filters.sort);
    else params.delete('sort');
    window.history.pushState({}, '', `?${params.toString()}`);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex gap-8">
        {/* Filters Sidebar */}
        <aside className="w-64 flex-shrink-0">
          <div className="card p-6">
            <h2 className="font-semibold text-gray-900 mb-4">Filters</h2>

            {/* Price Range */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Price</h3>
              <div className="flex gap-2 items-center">
                <input
                  type="number"
                  placeholder="Min"
                  value={filters.priceMin}
                  onChange={(e) => setFilters({ ...filters, priceMin: e.target.value })}
                  className="input w-20 text-sm"
                />
                <span className="text-gray-500">-</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={filters.priceMax}
                  onChange={(e) => setFilters({ ...filters, priceMax: e.target.value })}
                  className="input w-20 text-sm"
                />
              </div>
            </div>

            {/* Type Filters */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">Type</h3>
              <label className="flex items-center mb-2">
                <input
                  type="checkbox"
                  checked={filters.isHandmade}
                  onChange={(e) => setFilters({ ...filters, isHandmade: e.target.checked })}
                  className="rounded border-gray-300 text-primary-600 mr-2"
                />
                <span className="text-sm text-gray-600">Handmade</span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={filters.isVintage}
                  onChange={(e) => setFilters({ ...filters, isVintage: e.target.checked })}
                  className="rounded border-gray-300 text-primary-600 mr-2"
                />
                <span className="text-sm text-gray-600">Vintage</span>
              </label>
            </div>

            <button onClick={applyFilters} className="btn btn-primary w-full">
              Apply Filters
            </button>
          </div>
        </aside>

        {/* Results */}
        <div className="flex-1">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h1 className="text-2xl font-display font-bold text-gray-900">
                {search.q ? `Results for "${search.q}"` : 'All Products'}
              </h1>
              <p className="text-gray-600">{total} results</p>
            </div>

            <select
              value={filters.sort}
              onChange={(e) => {
                setFilters({ ...filters, sort: e.target.value });
              }}
              className="input w-48"
            >
              <option value="relevance">Most Relevant</option>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
              <option value="popular">Most Popular</option>
            </select>
          </div>

          {isLoading ? (
            <div className="flex justify-center items-center min-h-96">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-600 mb-4">No products found</p>
              <Link to="/" className="btn btn-secondary">
                Back to Home
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
              {products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
