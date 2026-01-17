import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { bookingsAPI } from '../services/api';
import { Booking } from '../types';
import { useAuthStore } from '../stores/authStore';
import { formatDateRange, formatCurrency, getBookingStatusLabel, getBookingStatusColor } from '../utils/helpers';

export const Route = createFileRoute('/trips')({
  component: TripsPage,
});

function TripsPage() {
  const { isAuthenticated } = useAuthStore();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!isAuthenticated) return;

    const loadBookings = async () => {
      try {
        const response = await bookingsAPI.getMyTrips(filter);
        setBookings(response.bookings);
      } catch (err) {
        console.error('Failed to load bookings:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadBookings();
  }, [isAuthenticated, filter]);

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Log in to view your trips</h1>
        <Link to="/login" className="btn-primary">
          Log in
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Trips</h1>

      {/* Filter Tabs */}
      <div className="flex gap-4 mb-8 border-b border-gray-200">
        {[
          { value: undefined, label: 'All' },
          { value: 'confirmed', label: 'Upcoming' },
          { value: 'completed', label: 'Past' },
          { value: 'cancelled', label: 'Cancelled' },
        ].map(({ value, label }) => (
          <button
            key={label}
            onClick={() => setFilter(value)}
            className={`pb-4 px-2 font-medium ${
              filter === value
                ? 'text-gray-900 border-b-2 border-gray-900'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="animate-pulse flex gap-4 p-4 border border-gray-200 rounded-xl">
              <div className="w-48 h-32 bg-gray-200 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-gray-200 rounded w-1/3" />
                <div className="h-4 bg-gray-200 rounded w-1/2" />
                <div className="h-4 bg-gray-200 rounded w-1/4" />
              </div>
            </div>
          ))}
        </div>
      ) : bookings.length > 0 ? (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <Link
              key={booking.id}
              to={`/booking/${booking.id}`}
              className="flex gap-6 p-4 border border-gray-200 rounded-xl hover:shadow-md transition-shadow"
            >
              <div className="w-48 h-32 rounded-lg overflow-hidden shrink-0">
                <img
                  src={booking.listing_photo || `https://picsum.photos/seed/${booking.listing_id}/200/150`}
                  alt={booking.listing_title}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="flex-1">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-lg font-semibold">{booking.listing_title}</h3>
                  <span className={`px-2 py-1 rounded text-xs font-medium ${getBookingStatusColor(booking.status)}`}>
                    {getBookingStatusLabel(booking.status)}
                  </span>
                </div>

                <p className="text-gray-600 mb-1">
                  {booking.listing_city}, {booking.listing_state || booking.listing_country}
                </p>

                <p className="text-gray-600 mb-2">
                  {formatDateRange(booking.check_in, booking.check_out)}
                </p>

                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{booking.guests} guests</span>
                  <span>{formatCurrency(booking.total_price)} total</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-4">No trips found</p>
          <Link to="/search" className="btn-primary">
            Start exploring
          </Link>
        </div>
      )}
    </div>
  );
}
