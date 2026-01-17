import { useState, useEffect } from 'react';
import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { Booking } from '@/types';
import { formatCurrency, formatDateRange, getNights, getStatusColor, getStatusLabel } from '@/utils';

export const Route = createFileRoute('/bookings/$bookingId')({
  component: BookingDetailPage,
});

function BookingDetailPage() {
  const { bookingId } = Route.useParams();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuthStore();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewData, setReviewData] = useState({ rating: 5, title: '', content: '' });
  const [submittingReview, setSubmittingReview] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    if (isAuthenticated) {
      loadBooking();
    }
  }, [bookingId, isAuthenticated, authLoading]);

  const loadBooking = async () => {
    setLoading(true);
    try {
      const data = await api.getBooking(bookingId);
      setBooking(data);
    } catch (err) {
      setError('Failed to load booking details');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    try {
      await api.cancelBooking(bookingId);
      loadBooking();
    } catch (err) {
      console.error('Failed to cancel booking:', err);
      alert('Failed to cancel booking. Please try again.');
    }
  };

  const handleConfirm = async () => {
    try {
      await api.confirmBooking(bookingId, `demo_payment_${Date.now()}`);
      loadBooking();
    } catch (err) {
      console.error('Failed to confirm booking:', err);
      alert('Failed to confirm booking. Please try again.');
    }
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittingReview(true);

    try {
      await api.submitReview(bookingId, reviewData);
      setShowReviewForm(false);
      alert('Thank you for your review!');
    } catch (err) {
      console.error('Failed to submit review:', err);
      alert('Failed to submit review. Please try again.');
    } finally {
      setSubmittingReview(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error || 'Booking not found'}</p>
        <Link to="/bookings" className="btn-primary mt-4">
          Back to Bookings
        </Link>
      </div>
    );
  }

  const nights = getNights(booking.checkIn, booking.checkOut);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link to="/bookings" className="text-primary-600 hover:text-primary-700 mb-4 inline-flex items-center">
        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Bookings
      </Link>

      <div className="card p-6 mt-4">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Booking Confirmation</h1>
            <p className="text-gray-500">Booking ID: {booking.id.slice(0, 8).toUpperCase()}</p>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-medium ${getStatusColor(booking.status)}`}>
            {getStatusLabel(booking.status)}
          </span>
        </div>

        {booking.status === 'reserved' && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
            <h3 className="font-medium text-yellow-800 mb-1">Action Required</h3>
            <p className="text-yellow-700 text-sm mb-3">
              Please confirm your booking to complete the reservation. Your room is held for 15 minutes.
            </p>
            <button onClick={handleConfirm} className="btn-primary">
              Confirm & Pay
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Hotel Details */}
          <div>
            <h2 className="text-lg font-semibold mb-4">Hotel Details</h2>
            <div className="flex gap-4">
              <img
                src={booking.hotelImages?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=200'}
                alt={booking.hotelName || 'Hotel'}
                className="w-24 h-24 object-cover rounded-lg"
              />
              <div>
                <Link
                  to={`/hotels/${booking.hotelId}`}
                  className="text-lg font-medium text-gray-900 hover:text-primary-600"
                >
                  {booking.hotelName}
                </Link>
                <p className="text-gray-500">{booking.hotelAddress}</p>
                <p className="text-gray-500">{booking.hotelCity}</p>
              </div>
            </div>
          </div>

          {/* Stay Details */}
          <div>
            <h2 className="text-lg font-semibold mb-4">Stay Details</h2>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-500">Room Type</span>
                <span className="font-medium">{booking.roomTypeName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Dates</span>
                <span className="font-medium">{formatDateRange(booking.checkIn, booking.checkOut)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Duration</span>
                <span className="font-medium">{nights} night{nights !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Rooms</span>
                <span className="font-medium">{booking.roomCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Guests</span>
                <span className="font-medium">{booking.guestCount}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Guest Information */}
        <div className="border-t mt-6 pt-6">
          <h2 className="text-lg font-semibold mb-4">Guest Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-gray-500 text-sm">Name</span>
              <p className="font-medium">{booking.guestFirstName} {booking.guestLastName}</p>
            </div>
            <div>
              <span className="text-gray-500 text-sm">Email</span>
              <p className="font-medium">{booking.guestEmail}</p>
            </div>
            {booking.guestPhone && (
              <div>
                <span className="text-gray-500 text-sm">Phone</span>
                <p className="font-medium">{booking.guestPhone}</p>
              </div>
            )}
            {booking.specialRequests && (
              <div className="md:col-span-2">
                <span className="text-gray-500 text-sm">Special Requests</span>
                <p className="font-medium">{booking.specialRequests}</p>
              </div>
            )}
          </div>
        </div>

        {/* Price Summary */}
        <div className="border-t mt-6 pt-6">
          <h2 className="text-lg font-semibold mb-4">Price Summary</h2>
          <div className="flex justify-between text-xl font-bold">
            <span>Total Paid</span>
            <span>{formatCurrency(booking.totalPrice)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="border-t mt-6 pt-6 flex flex-wrap gap-4">
          {(booking.status === 'reserved' || booking.status === 'confirmed') && (
            <button onClick={handleCancel} className="btn-secondary text-red-600 border-red-600 hover:bg-red-50">
              Cancel Booking
            </button>
          )}
          {(booking.status === 'confirmed' || booking.status === 'completed') && !showReviewForm && (
            <button onClick={() => setShowReviewForm(true)} className="btn-secondary">
              Write a Review
            </button>
          )}
        </div>

        {/* Review Form */}
        {showReviewForm && (
          <div className="border-t mt-6 pt-6">
            <h2 className="text-lg font-semibold mb-4">Write a Review</h2>
            <form onSubmit={handleSubmitReview} className="space-y-4">
              <div>
                <label className="label">Rating</label>
                <div className="flex space-x-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      onClick={() => setReviewData({ ...reviewData, rating: star })}
                      className={`text-3xl ${
                        star <= reviewData.rating ? 'text-yellow-400' : 'text-gray-300'
                      }`}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="label">Title</label>
                <input
                  type="text"
                  className="input"
                  value={reviewData.title}
                  onChange={(e) => setReviewData({ ...reviewData, title: e.target.value })}
                  placeholder="Summarize your experience"
                />
              </div>
              <div>
                <label className="label">Review</label>
                <textarea
                  className="input"
                  rows={4}
                  value={reviewData.content}
                  onChange={(e) => setReviewData({ ...reviewData, content: e.target.value })}
                  placeholder="Tell us about your stay..."
                />
              </div>
              <div className="flex space-x-4">
                <button type="submit" disabled={submittingReview} className="btn-primary">
                  {submittingReview ? 'Submitting...' : 'Submit Review'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReviewForm(false)}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
