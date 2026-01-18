import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { bookingsApi } from '../services/api';
import type { Booking } from '../types';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { formatDateTime, getLocalTimezone, getTimezoneDisplayName } from '../utils/time';

export const Route = createFileRoute('/bookings/$bookingId')({
  component: BookingDetailPage,
});

function BookingDetailPage() {
  const { bookingId } = Route.useParams();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadBooking();
  }, [bookingId]);

  const loadBooking = async () => {
    try {
      const response = await bookingsApi.get(bookingId);
      if (response.success && response.data) {
        setBooking(response.data);
      } else {
        setError('Booking not found');
      }
    } catch (err) {
      setError('Failed to load booking');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!booking) return;
    const reason = prompt('Cancellation reason (optional):');
    if (reason === null) return;

    try {
      const response = await bookingsApi.cancel(booking.id, reason || undefined);
      if (response.success && response.data) {
        setBooking(response.data);
      } else {
        alert(response.error || 'Failed to cancel booking');
      }
    } catch (err) {
      alert('Failed to cancel booking');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          {error || 'Booking not found'}
        </h1>
        <Link to="/bookings" className="btn btn-primary">
          Back to Bookings
        </Link>
      </div>
    );
  }

  const statusStyles = {
    confirmed: 'bg-green-100 text-green-800 border-green-200',
    cancelled: 'bg-red-100 text-red-800 border-red-200',
    rescheduled: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <Link to="/bookings" className="text-primary-600 hover:text-primary-700 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Bookings
        </Link>
      </div>

      <div className="card">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">
              {booking.meeting_type_name}
            </h1>
            <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium border ${statusStyles[booking.status]}`}>
              {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
            </span>
          </div>
          {booking.status === 'confirmed' && new Date(booking.start_time) > new Date() && (
            <button
              onClick={handleCancel}
              className="btn btn-danger"
            >
              Cancel Booking
            </button>
          )}
        </div>

        <div className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">Guest</h3>
              <p className="text-lg text-gray-900">{booking.invitee_name}</p>
              <p className="text-gray-600">{booking.invitee_email}</p>
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-500 mb-1">Host</h3>
              <p className="text-lg text-gray-900">{booking.host_name}</p>
              <p className="text-gray-600">{booking.host_email}</p>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-medium text-gray-500 mb-2">Date & Time</h3>
            <p className="text-lg text-gray-900">
              {formatDateTime(booking.start_time, getLocalTimezone())}
            </p>
            <p className="text-sm text-gray-500">
              Duration: {booking.meeting_type_duration} minutes
            </p>
            <p className="text-sm text-gray-500 mt-2">
              Guest timezone: {getTimezoneDisplayName(booking.invitee_timezone)}
            </p>
          </div>

          {booking.notes && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-sm font-medium text-gray-500 mb-2">Notes</h3>
              <p className="text-gray-700 whitespace-pre-wrap">{booking.notes}</p>
            </div>
          )}

          {booking.cancellation_reason && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="text-sm font-medium text-red-600 mb-2">Cancellation Reason</h3>
              <p className="text-gray-700">{booking.cancellation_reason}</p>
            </div>
          )}

          <div className="border-t border-gray-200 pt-6 text-sm text-gray-500">
            <p>Created: {new Date(booking.created_at).toLocaleString()}</p>
            {booking.updated_at !== booking.created_at && (
              <p>Last updated: {new Date(booking.updated_at).toLocaleString()}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
