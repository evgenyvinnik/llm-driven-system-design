import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { Product, Category } from '../types';
import { ProductCard } from '../components/ProductCard';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [productsRes, categoriesRes] = await Promise.all([
          api.getProducts({ limit: 12, sort: 'popular' }),
          api.getCategories(),
        ]);
        setProducts(productsRes.products);
        setCategories(categoriesRes.categories);
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-64 bg-gray-300 rounded-lg mb-8" />
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-48 bg-gray-300 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Hero Banner */}
      <div className="bg-gradient-to-b from-slate-800 to-slate-600 text-white py-12">
        <div className="max-w-7xl mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">Welcome to Amazon</h1>
          <p className="text-xl text-gray-300 mb-6">
            Discover millions of products at great prices
          </p>
          <Link
            to="/search"
            search={{ q: '' }}
            className="inline-block bg-amber-400 hover:bg-amber-500 text-black font-bold py-3 px-8 rounded-full"
          >
            Shop Now
          </Link>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Categories */}
        <section className="mb-12">
          <h2 className="text-2xl font-bold mb-6">Shop by Category</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {categories.map((category) => (
              <Link
                key={category.id}
                to="/category/$slug"
                params={{ slug: category.slug }}
                className="bg-white rounded-lg p-6 shadow hover:shadow-lg transition-shadow text-center"
              >
                <div className="w-16 h-16 mx-auto mb-3 bg-gray-100 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                </div>
                <h3 className="font-medium text-gray-900">{category.name}</h3>
                {category.product_count !== undefined && (
                  <p className="text-sm text-gray-500">{category.product_count} products</p>
                )}
              </Link>
            ))}
          </div>
        </section>

        {/* Featured Products */}
        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold">Featured Products</h2>
            <Link
              to="/search"
              search={{ q: '' }}
              className="text-blue-600 hover:underline"
            >
              See all products
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>

        {/* Deals Section */}
        <section className="mt-12 bg-white rounded-lg p-6 shadow">
          <h2 className="text-2xl font-bold mb-6">Today's Deals</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            {products
              .filter((p) => p.compare_at_price && parseFloat(p.compare_at_price) > parseFloat(p.price))
              .slice(0, 4)
              .map((product) => (
                <Link
                  key={product.id}
                  to="/product/$id"
                  params={{ id: product.id.toString() }}
                  className="block hover:opacity-80 transition-opacity"
                >
                  <div className="aspect-square bg-gray-100 rounded-lg overflow-hidden mb-2">
                    {product.images[0] && (
                      <img
                        src={product.images[0]}
                        alt={product.title}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="bg-red-600 text-white text-sm font-bold px-2 py-1 rounded inline-block">
                    {Math.round((1 - parseFloat(product.price) / parseFloat(product.compare_at_price!)) * 100)}% OFF
                  </div>
                  <p className="text-sm mt-1 line-clamp-2">{product.title}</p>
                </Link>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}
