import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { bookingsApi } from '../services/api';
import type { Booking } from '../types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { formatDateTime, getLocalTimezone } from '../utils/time';

export const Route = createFileRoute('/bookings')({
  beforeLoad: async () => {
    const { isAuthenticated, checkAuth, isLoading } = useAuthStore.getState();
    if (!isAuthenticated && !isLoading) {
      await checkAuth();
      if (!useAuthStore.getState().isAuthenticated) {
        throw redirect({ to: '/login' });
      }
    }
  },
  component: BookingsPage,
});

function BookingsPage() {
  const { user } = useAuthStore();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'past' | 'cancelled'>('upcoming');
  const timezone = user?.time_zone || getLocalTimezone();

  useEffect(() => {
    loadBookings();
  }, [filter]);

  const loadBookings = async () => {
    setIsLoading(true);
    try {
      let response;
      if (filter === 'upcoming') {
        response = await bookingsApi.list('confirmed', true);
      } else if (filter === 'cancelled') {
        response = await bookingsApi.list('cancelled');
      } else {
        response = await bookingsApi.list();
      }

      if (response.success && response.data) {
        let filtered = response.data;
        if (filter === 'past') {
          const now = new Date();
          filtered = response.data.filter(
            (b) => new Date(b.start_time) < now && b.status !== 'cancelled'
          );
        }
        setBookings(filtered);
      }
    } catch (error) {
      console.error('Failed to load bookings:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async (bookingId: string) => {
    const reason = prompt('Cancellation reason (optional):');
    if (reason === null) return; // User clicked cancel

    try {
      const response = await bookingsApi.cancel(bookingId, reason || undefined);
      if (response.success) {
        loadBookings();
      } else {
        alert(response.error || 'Failed to cancel booking');
      }
    } catch (error) {
      console.error('Failed to cancel booking:', error);
      alert('Failed to cancel booking');
    }
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      confirmed: 'bg-green-100 text-green-800',
      cancelled: 'bg-red-100 text-red-800',
      rescheduled: 'bg-yellow-100 text-yellow-800',
    };
    return styles[status as keyof typeof styles] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Bookings</h1>
        <p className="text-gray-600 mt-1">View and manage all your scheduled meetings.</p>
      </div>

      {/* Filter Tabs */}
      <div className="flex space-x-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {(['upcoming', 'past', 'cancelled', 'all'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              filter === tab
                ? 'bg-white text-gray-900 shadow'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center min-h-[30vh]">
          <LoadingSpinner size="lg" />
        </div>
      ) : bookings.length === 0 ? (
        <div className="card text-center py-12">
          <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No {filter === 'all' ? '' : filter} bookings
          </h3>
          <p className="text-gray-500">
            {filter === 'upcoming'
              ? 'Share your booking link to get meetings scheduled!'
              : 'No bookings match this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <div
              key={booking.id}
              className="card hover:shadow-lg transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {booking.invitee_name}
                    </h3>
                    <span className={`px-2 py-1 text-xs rounded-full ${getStatusBadge(booking.status)}`}>
                      {booking.status}
                    </span>
                  </div>
                  <p className="text-gray-600 mb-1">{booking.invitee_email}</p>
                  <p className="text-sm text-gray-500 mb-2">
                    {booking.meeting_type_name} ({booking.meeting_type_duration} min)
                  </p>
                  <p className="text-gray-900 font-medium">
                    {formatDateTime(booking.start_time, timezone)}
                  </p>
                  {booking.notes && (
                    <p className="text-sm text-gray-500 mt-2 italic">
                      Notes: {booking.notes}
                    </p>
                  )}
                  {booking.cancellation_reason && (
                    <p className="text-sm text-red-600 mt-2">
                      Cancellation reason: {booking.cancellation_reason}
                    </p>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <Link
                    to="/bookings/$bookingId"
                    params={{ bookingId: booking.id }}
                    className="btn btn-secondary text-sm"
                  >
                    View
                  </Link>
                  {booking.status === 'confirmed' && new Date(booking.start_time) > new Date() && (
                    <button
                      onClick={() => handleCancel(booking.id)}
                      className="btn btn-danger text-sm"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
