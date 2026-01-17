import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { restaurantAPI } from '../services/api';
import { RestaurantCard } from '../components/RestaurantCard';
import type { Restaurant } from '../types';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [cuisines, setCuisines] = useState<string[]>([]);
  const [selectedCuisine, setSelectedCuisine] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadCuisines();
  }, []);

  useEffect(() => {
    loadRestaurants();
  }, [selectedCuisine]);

  const loadCuisines = async () => {
    try {
      const { cuisines } = await restaurantAPI.getCuisines();
      setCuisines(cuisines);
    } catch (err) {
      console.error('Failed to load cuisines:', err);
    }
  };

  const loadRestaurants = async () => {
    setIsLoading(true);
    try {
      const { restaurants } = await restaurantAPI.getAll({
        cuisine: selectedCuisine || undefined,
        search: searchQuery || undefined,
      });
      setRestaurants(restaurants);
    } catch (err) {
      console.error('Failed to load restaurants:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    loadRestaurants();
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Hero Section */}
      <div className="bg-gradient-to-r from-doordash-red to-orange-500 rounded-2xl p-8 mb-8 text-white">
        <h1 className="text-3xl font-bold mb-2">Hungry? We've got you covered</h1>
        <p className="text-lg opacity-90 mb-6">Order from your favorite restaurants</p>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search restaurants..."
            className="flex-1 px-4 py-3 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-white"
          />
          <button
            type="submit"
            className="bg-white text-doordash-red px-6 py-3 rounded-lg font-medium hover:bg-gray-100 transition"
          >
            Search
          </button>
        </form>
      </div>

      {/* Cuisine Filter */}
      <div className="mb-6">
        <div className="flex gap-2 overflow-x-auto pb-2">
          <button
            onClick={() => setSelectedCuisine('')}
            className={`px-4 py-2 rounded-full whitespace-nowrap font-medium transition ${
              selectedCuisine === ''
                ? 'bg-doordash-red text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            All
          </button>
          {cuisines.map((cuisine) => (
            <button
              key={cuisine}
              onClick={() => setSelectedCuisine(cuisine)}
              className={`px-4 py-2 rounded-full whitespace-nowrap font-medium transition ${
                selectedCuisine === cuisine
                  ? 'bg-doordash-red text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100'
              }`}
            >
              {cuisine}
            </button>
          ))}
        </div>
      </div>

      {/* Restaurant Grid */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-doordash-red border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : restaurants.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No restaurants found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {restaurants.map((restaurant) => (
            <RestaurantCard key={restaurant.id} restaurant={restaurant} />
          ))}
        </div>
      )}
    </div>
  );
}
