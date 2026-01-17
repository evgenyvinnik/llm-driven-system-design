import { useState, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SearchBar, HotelCard } from '@/components';
import { useSearchStore } from '@/stores/searchStore';
import { api } from '@/services/api';
import type { Hotel } from '@/types';

export const Route = createFileRoute('/search')({
  component: SearchPage,
});

function SearchPage() {
  const { params, setParams } = useSearchStore();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    searchHotels();
  }, [params]);

  const searchHotels = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.searchHotels(params);
      setHotels(result.hotels);
      setTotal(result.total);
    } catch (err) {
      setError('Failed to search hotels. Please try again.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Search Bar */}
      <div className="mb-8">
        <SearchBar variant="compact" />
      </div>

      {/* Filters and Sort */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center space-x-4">
          <select
            className="input w-auto"
            value={params.minStars || ''}
            onChange={(e) => setParams({ minStars: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">All Stars</option>
            <option value="5">5 Stars</option>
            <option value="4">4+ Stars</option>
            <option value="3">3+ Stars</option>
          </select>
          <input
            type="number"
            placeholder="Max price"
            className="input w-32"
            value={params.maxPrice || ''}
            onChange={(e) => setParams({ maxPrice: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <div className="flex items-center space-x-4">
          <span className="text-gray-500">
            {total} hotel{total !== 1 ? 's' : ''} found
          </span>
          <select
            className="input w-auto"
            value={params.sortBy || 'relevance'}
            onChange={(e) => setParams({ sortBy: e.target.value as never })}
          >
            <option value="relevance">Sort by: Relevance</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
            <option value="rating">Guest Rating</option>
            <option value="stars">Star Rating</option>
          </select>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
        </div>
      ) : error ? (
        <div className="text-center py-12">
          <p className="text-red-600">{error}</p>
          <button onClick={searchHotels} className="btn-primary mt-4">
            Try Again
          </button>
        </div>
      ) : hotels.length === 0 ? (
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">No hotels found</h2>
          <p className="text-gray-600 mb-4">Try adjusting your search criteria</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {hotels.map((hotel) => (
            <HotelCard
              key={hotel.id}
              hotel={hotel}
              checkIn={params.checkIn}
              checkOut={params.checkOut}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > (params.limit || 20) && (
        <div className="flex justify-center mt-8 space-x-2">
          <button
            onClick={() => setParams({ page: (params.page || 1) - 1 })}
            disabled={(params.page || 1) <= 1}
            className="btn-secondary"
          >
            Previous
          </button>
          <span className="px-4 py-2 text-gray-600">
            Page {params.page || 1} of {Math.ceil(total / (params.limit || 20))}
          </span>
          <button
            onClick={() => setParams({ page: (params.page || 1) + 1 })}
            disabled={(params.page || 1) >= Math.ceil(total / (params.limit || 20))}
            className="btn-secondary"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
