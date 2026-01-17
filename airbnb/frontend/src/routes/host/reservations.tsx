import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { bookingsAPI } from '../../services/api';
import { Booking } from '../../types';
import { useAuthStore } from '../../stores/authStore';
import { formatDateRange, formatCurrency, getBookingStatusLabel, getBookingStatusColor } from '../../utils/helpers';

export const Route = createFileRoute('/host/reservations')({
  component: HostReservationsPage,
});

function HostReservationsPage() {
  const { user, isAuthenticated } = useAuthStore();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const loadBookings = async () => {
    try {
      const response = await bookingsAPI.getHostReservations(filter);
      setBookings(response.bookings);
    } catch (err) {
      console.error('Failed to load reservations:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated || !user?.is_host) return;
    loadBookings();
  }, [isAuthenticated, user?.is_host, filter]);

  const handleRespond = async (bookingId: number, action: 'confirm' | 'decline') => {
    setActionLoading(bookingId);
    try {
      await bookingsAPI.respond(bookingId, action);
      loadBookings();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to respond');
    } finally {
      setActionLoading(null);
    }
  };

  if (!isAuthenticated || !user?.is_host) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Host access required</h1>
        <Link to="/become-host" className="btn-primary">
          Become a Host
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Reservations</h1>

      {/* Filter Tabs */}
      <div className="flex gap-4 mb-8 border-b border-gray-200">
        {[
          { value: undefined, label: 'All' },
          { value: 'pending', label: 'Pending' },
          { value: 'confirmed', label: 'Upcoming' },
          { value: 'completed', label: 'Past' },
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
            <div key={i} className="animate-pulse p-4 border border-gray-200 rounded-xl">
              <div className="h-4 bg-gray-200 rounded w-1/3 mb-2" />
              <div className="h-4 bg-gray-200 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : bookings.length > 0 ? (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <div
              key={booking.id}
              className="p-6 border border-gray-200 rounded-xl"
            >
              <div className="flex gap-6">
                <div className="w-24 h-24 rounded-lg overflow-hidden shrink-0">
                  <img
                    src={booking.listing_photo || `https://picsum.photos/seed/${booking.listing_id}/200/150`}
                    alt={booking.listing_title}
                    className="w-full h-full object-cover"
                  />
                </div>

                <div className="flex-1">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-semibold">{booking.listing_title}</h3>
                      <p className="text-sm text-gray-500">
                        {formatDateRange(booking.check_in, booking.check_out)}
                      </p>
                    </div>
                    <span className={`px-2 py-1 rounded text-xs font-medium ${getBookingStatusColor(booking.status)}`}>
                      {getBookingStatusLabel(booking.status)}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-gray-200 overflow-hidden">
                      {booking.guest_avatar && (
                        <img src={booking.guest_avatar} alt="" className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{booking.guest_name}</p>
                      <p className="text-xs text-gray-500">{booking.guests} guests</p>
                    </div>
                  </div>

                  {booking.guest_message && (
                    <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg mb-3">
                      "{booking.guest_message}"
                    </p>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="font-medium">{formatCurrency(booking.total_price)}</span>

                    {booking.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleRespond(booking.id, 'decline')}
                          disabled={actionLoading === booking.id}
                          className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
                        >
                          Decline
                        </button>
                        <button
                          onClick={() => handleRespond(booking.id, 'confirm')}
                          disabled={actionLoading === booking.id}
                          className="px-4 py-2 bg-airbnb text-white rounded-lg text-sm hover:bg-airbnb-dark"
                        >
                          {actionLoading === booking.id ? 'Processing...' : 'Accept'}
                        </button>
                      </div>
                    )}

                    {booking.status === 'confirmed' && (
                      <Link
                        to={`/booking/${booking.id}`}
                        className="text-sm text-airbnb font-medium hover:underline"
                      >
                        View details
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No reservations found</p>
        </div>
      )}
    </div>
  );
}
