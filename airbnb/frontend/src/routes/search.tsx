import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { searchAPI } from '../services/api';
import { Listing, SearchParams } from '../types';
import { ListingCard } from '../components/ListingCard';
import { useSearchStore } from '../stores/searchStore';
import { getPropertyTypeLabel, getRoomTypeLabel, getAmenityLabel } from '../utils/helpers';

export const Route = createFileRoute('/search')({
  component: SearchPage,
});

const PROPERTY_TYPES = ['apartment', 'house', 'room', 'studio', 'villa', 'cabin', 'cottage', 'loft'];
const ROOM_TYPES = ['entire_place', 'private_room', 'shared_room'];
const AMENITIES = ['wifi', 'kitchen', 'air_conditioning', 'heating', 'washer', 'dryer', 'tv', 'pool', 'parking', 'gym'];

function SearchPage() {
  const searchStore = useSearchStore();
  const [listings, setListings] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);

  // Local filter state
  const [localFilters, setLocalFilters] = useState<Partial<SearchParams>>({
    min_price: undefined,
    max_price: undefined,
    property_type: undefined,
    room_type: undefined,
    amenities: [],
    instant_book: undefined,
    bedrooms: undefined,
  });

  const doSearch = async () => {
    setIsLoading(true);
    try {
      const params = {
        ...searchStore.getSearchParams(),
        ...localFilters,
      };
      const response = await searchAPI.search(params);
      setListings(response.listings);
      setTotal(response.total);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    doSearch();
  }, []);

  const handleApplyFilters = () => {
    searchStore.setFilters(localFilters);
    doSearch();
    setShowFilters(false);
  };

  const handleClearFilters = () => {
    setLocalFilters({
      min_price: undefined,
      max_price: undefined,
      property_type: undefined,
      room_type: undefined,
      amenities: [],
      instant_book: undefined,
      bedrooms: undefined,
    });
    searchStore.clearFilters();
    doSearch();
  };

  const toggleAmenity = (amenity: string) => {
    const current = localFilters.amenities || [];
    const updated = current.includes(amenity)
      ? current.filter((a) => a !== amenity)
      : [...current, amenity];
    setLocalFilters({ ...localFilters, amenities: updated });
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Search Controls */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">
          {searchStore.location ? `Stays in ${searchStore.location}` : 'All stays'}
        </h1>

        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:border-gray-900"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filters
        </button>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Price Range */}
            <div>
              <label className="block text-sm font-medium mb-2">Price range</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  placeholder="Min"
                  value={localFilters.min_price || ''}
                  onChange={(e) => setLocalFilters({ ...localFilters, min_price: parseInt(e.target.value) || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
                <span>-</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={localFilters.max_price || ''}
                  onChange={(e) => setLocalFilters({ ...localFilters, max_price: parseInt(e.target.value) || undefined })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                />
              </div>
            </div>

            {/* Property Type */}
            <div>
              <label className="block text-sm font-medium mb-2">Property type</label>
              <select
                value={localFilters.property_type || ''}
                onChange={(e) => setLocalFilters({ ...localFilters, property_type: e.target.value || undefined })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="">Any</option>
                {PROPERTY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {getPropertyTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>

            {/* Room Type */}
            <div>
              <label className="block text-sm font-medium mb-2">Room type</label>
              <select
                value={localFilters.room_type || ''}
                onChange={(e) => setLocalFilters({ ...localFilters, room_type: e.target.value || undefined })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="">Any</option>
                {ROOM_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {getRoomTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>

            {/* Bedrooms */}
            <div>
              <label className="block text-sm font-medium mb-2">Bedrooms</label>
              <select
                value={localFilters.bedrooms || ''}
                onChange={(e) => setLocalFilters({ ...localFilters, bedrooms: parseInt(e.target.value) || undefined })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              >
                <option value="">Any</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}+ bedrooms
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Amenities */}
          <div className="mt-6">
            <label className="block text-sm font-medium mb-2">Amenities</label>
            <div className="flex flex-wrap gap-2">
              {AMENITIES.map((amenity) => (
                <button
                  key={amenity}
                  onClick={() => toggleAmenity(amenity)}
                  className={`px-3 py-1 rounded-full text-sm ${
                    localFilters.amenities?.includes(amenity)
                      ? 'bg-gray-900 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {getAmenityLabel(amenity)}
                </button>
              ))}
            </div>
          </div>

          {/* Instant Book */}
          <div className="mt-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={localFilters.instant_book || false}
                onChange={(e) => setLocalFilters({ ...localFilters, instant_book: e.target.checked || undefined })}
                className="w-4 h-4"
              />
              <span className="text-sm font-medium">Instant Book only</span>
            </label>
          </div>

          {/* Filter Actions */}
          <div className="mt-6 flex justify-between items-center pt-6 border-t border-gray-200">
            <button onClick={handleClearFilters} className="text-gray-600 underline">
              Clear all
            </button>
            <button onClick={handleApplyFilters} className="btn-primary">
              Show {total} places
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="aspect-[4/3] bg-gray-200 rounded-xl mb-3" />
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-4 bg-gray-200 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : listings.length > 0 ? (
        <>
          <p className="text-gray-600 mb-6">{total} places</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {listings.map((listing) => (
              <ListingCard key={listing.id} listing={listing} />
            ))}
          </div>
        </>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-4">No places found</p>
          <p className="text-gray-400">Try adjusting your search or filters</p>
        </div>
      )}
    </div>
  );
}
