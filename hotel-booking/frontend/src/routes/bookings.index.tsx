import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BookingCard } from '@/components';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Booking } from '@/types';

export const Route = createFileRoute('/bookings/')({
  component: BookingsPage,
});

function BookingsPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuthStore();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    if (isAuthenticated) {
      loadBookings();
    }
  }, [isAuthenticated, authLoading, filter]);

  const loadBookings = async () => {
    setLoading(true);
    try {
      const data = await api.getMyBookings(filter || undefined);
      setBookings(data);
    } catch (err) {
      console.error('Failed to load bookings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (bookingId: string) => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    try {
      await api.cancelBooking(bookingId);
      loadBookings();
    } catch (err) {
      console.error('Failed to cancel booking:', err);
      alert('Failed to cancel booking. Please try again.');
    }
  };

  const handleConfirm = async (bookingId: string) => {
    try {
      await api.confirmBooking(bookingId, `demo_payment_${Date.now()}`);
      loadBookings();
    } catch (err) {
      console.error('Failed to confirm booking:', err);
      alert('Failed to confirm booking. Please try again.');
    }
  };

  if (authLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-gray-900">My Bookings</h1>
        <select
          className="input w-auto"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All Bookings</option>
          <option value="reserved">Reserved</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="text-center py-12">
          <h2 className="text-xl font-medium text-gray-900 mb-2">No bookings found</h2>
          <p className="text-gray-500 mb-4">
            {filter ? 'Try changing the filter or ' : ''}Start exploring hotels to make your first booking!
          </p>
          <button onClick={() => navigate({ to: '/' })} className="btn-primary">
            Explore Hotels
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              onCancel={handleCancel}
              onConfirm={handleConfirm}
            />
          ))}
        </div>
      )}
    </div>
  );
}
