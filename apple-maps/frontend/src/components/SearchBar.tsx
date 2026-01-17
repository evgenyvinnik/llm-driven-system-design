import { useState, useRef, useEffect } from 'react';
import { useMapStore } from '../stores/mapStore';
import type { Place } from '../types';

export default function SearchBar() {
  const [inputValue, setInputValue] = useState('');
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const {
    searchResults,
    isSearching,
    search,
    clearSearch,
    setSelectedPlace,
    setDestination,
    setCenter,
  } = useMapStore();

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputValue.length >= 2) {
        search(inputValue);
        setShowResults(true);
      } else {
        clearSearch();
        setShowResults(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [inputValue, search, clearSearch]);

  // Close results when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        resultsRef.current &&
        !resultsRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectPlace = (place: Place) => {
    setSelectedPlace(place);
    setDestination(place.location);
    setCenter(place.location);
    setInputValue(place.name);
    setShowResults(false);
  };

  const handleClear = () => {
    setInputValue('');
    clearSearch();
    setShowResults(false);
    inputRef.current?.focus();
  };

  const getCategoryIcon = (category: string): string => {
    switch (category) {
      case 'restaurant': return '🍽️';
      case 'coffee': return '☕';
      case 'gas_station': return '⛽';
      case 'hotel': return '🏨';
      case 'park': return '🌳';
      case 'shopping': return '🛍️';
      case 'hospital': return '🏥';
      case 'museum': return '🏛️';
      case 'attraction': return '🎡';
      case 'entertainment': return '🎭';
      case 'pharmacy': return '💊';
      default: return '📍';
    }
  };

  const formatDistance = (meters?: number): string => {
    if (!meters) return '';
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="relative">
        <svg
          className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-apple-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={() => searchResults.length > 0 && setShowResults(true)}
          placeholder="Search for a place or address"
          className="w-full pl-12 pr-10 py-3 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border-0 outline-none text-apple-gray-600 placeholder:text-apple-gray-400 focus:ring-2 focus:ring-apple-blue/30"
        />

        {inputValue && (
          <button
            onClick={handleClear}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full bg-apple-gray-300 text-white hover:bg-apple-gray-400 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}

        {isSearching && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="w-5 h-5 border-2 border-apple-blue border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {showResults && searchResults.length > 0 && (
        <div
          ref={resultsRef}
          className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden z-50 max-h-80 overflow-y-auto"
        >
          {searchResults.map((place) => (
            <button
              key={place.id}
              onClick={() => handleSelectPlace(place)}
              className="w-full px-4 py-3 flex items-start gap-3 hover:bg-apple-gray-100 transition-colors text-left border-b border-apple-gray-100 last:border-0"
            >
              <span className="text-xl flex-shrink-0">{getCategoryIcon(place.category)}</span>
              <div className="flex-grow min-w-0">
                <p className="font-medium text-apple-gray-600 truncate">{place.name}</p>
                <p className="text-sm text-apple-gray-400 truncate capitalize">{place.category}</p>
                {place.address && (
                  <p className="text-xs text-apple-gray-400 truncate mt-0.5">{place.address}</p>
                )}
              </div>
              <div className="flex-shrink-0 text-right">
                {place.rating && (
                  <p className="text-sm text-apple-gray-500">
                    <span className="text-yellow-500">★</span> {place.rating.toFixed(1)}
                  </p>
                )}
                {place.distance && (
                  <p className="text-xs text-apple-gray-400">{formatDistance(place.distance)}</p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {showResults && !isSearching && searchResults.length === 0 && inputValue.length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-4 text-center text-apple-gray-400 z-50">
          No results found
        </div>
      )}
    </div>
  );
}
