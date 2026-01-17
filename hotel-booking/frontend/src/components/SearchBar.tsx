import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSearchStore } from '@/stores/searchStore';
import { getDefaultCheckIn, getDefaultCheckOut } from '@/utils';

interface SearchBarProps {
  variant?: 'hero' | 'compact';
}

export function SearchBar({ variant = 'hero' }: SearchBarProps) {
  const navigate = useNavigate();
  const { params, setParams } = useSearchStore();
  const [city, setCity] = useState(params.city || '');
  const [checkIn, setCheckIn] = useState(params.checkIn || getDefaultCheckIn());
  const [checkOut, setCheckOut] = useState(params.checkOut || getDefaultCheckOut());
  const [guests, setGuests] = useState(params.guests || 2);
  const [rooms, setRooms] = useState(params.rooms || 1);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setParams({ city, checkIn, checkOut, guests, rooms, page: 1 });
    navigate({ to: '/search' });
  };

  if (variant === 'compact') {
    return (
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <div>
            <label className="label">Destination</label>
            <input
              type="text"
              className="input"
              placeholder="City or hotel name"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Check-in</label>
            <input
              type="date"
              className="input"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
            />
          </div>
          <div>
            <label className="label">Check-out</label>
            <input
              type="date"
              className="input"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
              min={checkIn || new Date().toISOString().split('T')[0]}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Guests</label>
              <select
                className="input"
                value={guests}
                onChange={(e) => setGuests(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'guest' : 'guests'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Rooms</label>
              <select
                className="input"
                value={rooms}
                onChange={(e) => setRooms(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'room' : 'rooms'}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full">
              Search
            </button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSearch} className="bg-white rounded-2xl shadow-xl p-6 md:p-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-2">
          <label className="label">Where are you going?</label>
          <input
            type="text"
            className="input text-lg py-3"
            placeholder="Enter city, hotel name..."
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Check-in</label>
          <input
            type="date"
            className="input text-lg py-3"
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
            min={new Date().toISOString().split('T')[0]}
          />
        </div>
        <div>
          <label className="label">Check-out</label>
          <input
            type="date"
            className="input text-lg py-3"
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
            min={checkIn || new Date().toISOString().split('T')[0]}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-6">
        <div>
          <label className="label">Guests</label>
          <select
            className="input text-lg py-3"
            value={guests}
            onChange={(e) => setGuests(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'guest' : 'guests'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Rooms</label>
          <select
            className="input text-lg py-3"
            value={rooms}
            onChange={(e) => setRooms(Number(e.target.value))}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} {n === 1 ? 'room' : 'rooms'}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className="label invisible">Search</label>
          <button type="submit" className="btn-primary w-full text-lg py-3">
            Search Hotels
          </button>
        </div>
      </div>
    </form>
  );
}
