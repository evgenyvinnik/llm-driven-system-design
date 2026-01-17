import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import { ProductCard } from '../components/ProductCard';
import type { Product, Category } from '../types';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [trendingProducts, setTrendingProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [productsRes, categoriesRes] = await Promise.all([
          api.get<{ products: Product[] }>('/products/trending?limit=12'),
          api.get<{ categories: Category[] }>('/categories'),
        ]);
        setTrendingProducts(productsRes.products);
        setCategories(categoriesRes.categories);
      } catch (error) {
        console.error('Error fetching data:', error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, []);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div>
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-primary-50 to-amber-50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-display font-bold text-gray-900 mb-4">
            Discover Unique Handmade Treasures
          </h1>
          <p className="text-lg text-gray-600 mb-8 max-w-2xl mx-auto">
            Support independent artisans and find one-of-a-kind items crafted with love and care.
          </p>
          <Link to="/search" className="btn btn-primary text-lg px-8 py-3">
            Start Shopping
          </Link>
        </div>
      </section>

      {/* Categories */}
      <section className="py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-display font-bold text-gray-900 mb-6">
            Browse Categories
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
            {categories.map((category) => (
              <Link
                key={category.id}
                to={`/category/${category.slug}`}
                className="group text-center"
              >
                <div className="bg-gray-100 rounded-full p-4 mb-2 group-hover:bg-primary-100 transition-colors">
                  <div className="w-12 h-12 mx-auto flex items-center justify-center text-2xl">
                    {getCategoryEmoji(category.slug)}
                  </div>
                </div>
                <span className="text-sm text-gray-700 group-hover:text-primary-600">
                  {category.name}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Trending Products */}
      <section className="py-12 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-display font-bold text-gray-900">
              Trending Now
            </h2>
            <Link to="/search" className="text-primary-600 hover:text-primary-700">
              View all
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {trendingProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      </section>

      {/* Sell CTA */}
      <section className="py-16 bg-primary-600">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-display font-bold text-white mb-4">
            Start Selling Today
          </h2>
          <p className="text-primary-100 mb-8 max-w-xl mx-auto">
            Turn your passion into profit. Join our community of artisans and reach customers worldwide.
          </p>
          <Link
            to="/seller/create-shop"
            className="btn bg-white text-primary-600 hover:bg-gray-100"
          >
            Open Your Shop
          </Link>
        </div>
      </section>
    </div>
  );
}

function getCategoryEmoji(slug: string): string {
  const emojis: Record<string, string> = {
    'jewelry-accessories': '💍',
    'clothing-shoes': '👗',
    'home-living': '🏠',
    'art-collectibles': '🎨',
    'craft-supplies': '🧶',
    'vintage': '📻',
    'weddings': '💒',
    'toys-games': '🎮',
  };
  return emojis[slug] || '📦';
}
