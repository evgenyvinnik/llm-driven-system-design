import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { Search, MapPin, Utensils, Coffee, Beer, ShoppingBag, Sparkles, Car, Home, Heart } from 'lucide-react';
import { BusinessGridCard } from '../components/BusinessCard';
import api from '../services/api';
import type { Business, Category } from '../types';

export const Route = createFileRoute('/')({
  component: HomePage,
});

const categoryIcons: Record<string, React.ReactNode> = {
  restaurants: <Utensils className="w-6 h-6" />,
  'coffee-tea': <Coffee className="w-6 h-6" />,
  bars: <Beer className="w-6 h-6" />,
  shopping: <ShoppingBag className="w-6 h-6" />,
  'beauty-spas': <Sparkles className="w-6 h-6" />,
  automotive: <Car className="w-6 h-6" />,
  'home-services': <Home className="w-6 h-6" />,
  'health-medical': <Heart className="w-6 h-6" />,
};

function HomePage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [location, setLocation] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [featuredBusinesses, setFeaturedBusinesses] = useState<Business[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [catResponse, bizResponse] = await Promise.all([
        api.get<{ categories: Category[] }>('/categories'),
        api.get<{ businesses: Business[] }>('/businesses?limit=8'),
      ]);
      setCategories(catResponse.categories.slice(0, 8));
      setFeaturedBusinesses(bizResponse.businesses);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (location) params.set('location', location);
    window.location.href = `/search?${params.toString()}`;
  };

  return (
    <div>
      {/* Hero Section */}
      <div
        className="relative bg-cover bg-center h-96"
        style={{
          backgroundImage:
            'linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url(https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1600)',
        }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Find the best local businesses
          </h1>
          <p className="text-xl mb-8">
            Restaurants, shops, services, and more
          </p>

          {/* Search Form */}
          <form
            onSubmit={handleSearch}
            className="w-full max-w-3xl px-4"
          >
            <div className="flex flex-col md:flex-row gap-2">
              <div className="flex-1 flex items-center bg-white rounded-md px-4">
                <Search className="w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="restaurants, shops, services..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full py-3 px-2 text-gray-900 focus:outline-none"
                />
              </div>
              <div className="flex-1 flex items-center bg-white rounded-md px-4">
                <MapPin className="w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="city, state, or zip"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  className="w-full py-3 px-2 text-gray-900 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="btn-primary py-3 px-8 rounded-md"
              >
                Search
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Categories Section */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">
          Browse Categories
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
          {categories.map((category) => (
            <Link
              key={category.id}
              to="/search"
              search={{ category: category.slug }}
              className="flex flex-col items-center p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow"
            >
              <div className="w-12 h-12 rounded-full bg-yelp-red/10 flex items-center justify-center text-yelp-red mb-2">
                {categoryIcons[category.slug] || <Utensils className="w-6 h-6" />}
              </div>
              <span className="text-sm text-gray-700 text-center">
                {category.name}
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Featured Businesses */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">
            Featured Businesses
          </h2>
          <Link to="/search" className="text-yelp-red hover:underline">
            View all
          </Link>
        </div>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="card animate-pulse">
                <div className="h-40 bg-gray-200" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-gray-200 rounded w-3/4" />
                  <div className="h-4 bg-gray-200 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {featuredBusinesses.map((business) => (
              <BusinessGridCard key={business.id} business={business} />
            ))}
          </div>
        )}
      </div>

      {/* CTA Section */}
      <div className="bg-yelp-red text-white py-16">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Own a Business?</h2>
          <p className="text-xl mb-8">
            Claim your business page and connect with customers
          </p>
          <Link
            to="/register"
            className="bg-white text-yelp-red px-8 py-3 rounded-md font-semibold hover:bg-gray-100 transition-colors"
          >
            Get Started
          </Link>
        </div>
      </div>
    </div>
  );
}
