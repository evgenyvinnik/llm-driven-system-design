import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/services/api';
import { useLocationStore } from '@/stores/locationStore';
import { MerchantCard } from '@/components/MerchantCard';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import type { Merchant } from '@/types';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const { location, getCurrentLocation } = useLocationStore();

  useEffect(() => {
    loadCategories();
    initLocation();
  }, []);

  useEffect(() => {
    if (location) {
      loadMerchants();
    }
  }, [location, selectedCategory]);

  const initLocation = async () => {
    await getCurrentLocation();
  };

  const loadCategories = async () => {
    try {
      const data = await api.getCategories();
      setCategories(data as string[]);
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  };

  const loadMerchants = async () => {
    if (!location) return;

    setIsLoading(true);
    try {
      const data = await api.getMerchants(
        location.lat,
        location.lng,
        10,
        selectedCategory || undefined
      );
      setMerchants(data as Merchant[]);
    } catch (error) {
      console.error('Failed to load merchants:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadMerchants();
      return;
    }

    setIsLoading(true);
    try {
      const data = await api.searchMerchants(
        searchQuery,
        location?.lat,
        location?.lng
      );
      setMerchants(data as Merchant[]);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero Section */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          Delivery to Your Door
        </h1>
        <p className="text-xl text-gray-600">
          Order from your favorite local restaurants and stores
        </p>
      </div>

      {/* Search */}
      <div className="flex gap-4 mb-8">
        <input
          type="text"
          placeholder="Search restaurants..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
          className="input flex-1"
        />
        <button onClick={handleSearch} className="btn-primary">
          Search
        </button>
      </div>

      {/* Categories */}
      <div className="flex gap-2 overflow-x-auto pb-4 mb-6">
        <button
          onClick={() => setSelectedCategory('')}
          className={`px-4 py-2 rounded-full whitespace-nowrap ${
            selectedCategory === ''
              ? 'bg-primary-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          All
        </button>
        {categories.map((category) => (
          <button
            key={category}
            onClick={() => setSelectedCategory(category)}
            className={`px-4 py-2 rounded-full whitespace-nowrap capitalize ${
              selectedCategory === category
                ? 'bg-primary-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {category}
          </button>
        ))}
      </div>

      {/* Merchants Grid */}
      {isLoading ? (
        <LoadingSpinner size="lg" className="py-12" />
      ) : merchants.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No restaurants found</p>
          <p className="text-gray-400 mt-2">Try adjusting your search or location</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {merchants.map((merchant) => (
            <MerchantCard key={merchant.id} merchant={merchant} />
          ))}
        </div>
      )}
    </div>
  );
}
