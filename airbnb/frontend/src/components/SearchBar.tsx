import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSearchStore } from '../stores/searchStore';

export function SearchBar() {
  const navigate = useNavigate();
  const { location, checkIn, checkOut, guests, setLocation, setDates, setGuests } =
    useSearchStore();

  const [localLocation, setLocalLocation] = useState(location);
  const [localCheckIn, setLocalCheckIn] = useState(checkIn || '');
  const [localCheckOut, setLocalCheckOut] = useState(checkOut || '');
  const [localGuests, setLocalGuests] = useState(guests);

  const handleSearch = () => {
    setLocation(localLocation);
    setDates(localCheckIn || undefined, localCheckOut || undefined);
    setGuests(localGuests);
    navigate({ to: '/search' });
  };

  return (
    <div className="flex items-center bg-white rounded-full border border-gray-300 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex-1 px-6 py-3 border-r border-gray-300">
        <label className="block text-xs font-bold text-gray-800">Where</label>
        <input
          type="text"
          placeholder="Search destinations"
          value={localLocation}
          onChange={(e) => setLocalLocation(e.target.value)}
          className="w-full text-sm text-gray-600 placeholder-gray-400 outline-none bg-transparent"
        />
      </div>

      <div className="px-4 py-3 border-r border-gray-300">
        <label className="block text-xs font-bold text-gray-800">Check in</label>
        <input
          type="date"
          value={localCheckIn}
          onChange={(e) => setLocalCheckIn(e.target.value)}
          className="text-sm text-gray-600 outline-none bg-transparent"
        />
      </div>

      <div className="px-4 py-3 border-r border-gray-300">
        <label className="block text-xs font-bold text-gray-800">Check out</label>
        <input
          type="date"
          value={localCheckOut}
          onChange={(e) => setLocalCheckOut(e.target.value)}
          min={localCheckIn}
          className="text-sm text-gray-600 outline-none bg-transparent"
        />
      </div>

      <div className="px-4 py-3">
        <label className="block text-xs font-bold text-gray-800">Guests</label>
        <input
          type="number"
          min={1}
          max={16}
          value={localGuests}
          onChange={(e) => setLocalGuests(parseInt(e.target.value) || 1)}
          className="w-16 text-sm text-gray-600 outline-none bg-transparent"
        />
      </div>

      <button
        onClick={handleSearch}
        className="m-2 p-3 bg-airbnb rounded-full text-white hover:bg-airbnb-dark transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </button>
    </div>
  );
}

export function SearchBarCompact() {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate({ to: '/search' })}
      className="flex items-center gap-4 px-4 py-2 bg-white rounded-full border border-gray-300 shadow-sm hover:shadow-md transition-shadow"
    >
      <span className="text-sm font-medium">Anywhere</span>
      <span className="text-gray-300">|</span>
      <span className="text-sm font-medium">Any week</span>
      <span className="text-gray-300">|</span>
      <span className="text-sm text-gray-500">Add guests</span>
      <div className="p-2 bg-airbnb rounded-full text-white">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      </div>
    </button>
  );
}
