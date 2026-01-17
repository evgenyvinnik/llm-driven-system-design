import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { bookingsAPI, reviewsAPI } from '../services/api';
import { Booking } from '../types';
import { useAuthStore } from '../stores/authStore';
import { formatDateRange, formatCurrency, getBookingStatusLabel, getBookingStatusColor } from '../utils/helpers';

export const Route = createFileRoute('/booking/$id')({
  component: BookingDetailPage,
});

function BookingDetailPage() {
  const { id } = Route.useParams();
  const { user } = useAuthStore();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [reviewStatus, setReviewStatus] = useState<{
    host_reviewed: boolean;
    guest_reviewed: boolean;
    can_review: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Review form
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [rating, setRating] = useState(5);
  const [cleanlinessRating, setCleanlinessRating] = useState(5);
  const [communicationRating, setCommunicationRating] = useState(5);
  const [locationRating, setLocationRating] = useState(5);
  const [valueRating, setValueRating] = useState(5);
  const [reviewContent, setReviewContent] = useState('');

  useEffect(() => {
    const loadData = async () => {
      try {
        const bookingRes = await bookingsAPI.getById(parseInt(id));
        setBooking(bookingRes.booking);

        if (bookingRes.booking.status === 'completed') {
          const reviewRes = await reviewsAPI.getBookingStatus(parseInt(id));
          setReviewStatus(reviewRes);
        }
      } catch (err) {
        console.error('Failed to load booking:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [id]);

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this booking?')) return;

    setActionLoading(true);
    try {
      await bookingsAPI.cancel(parseInt(id));
      setBooking((prev) => prev ? { ...prev, status: 'cancelled' } : null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitReview = async () => {
    setActionLoading(true);
    try {
      await reviewsAPI.create({
        booking_id: parseInt(id),
        rating,
        cleanliness_rating: cleanlinessRating,
        communication_rating: communicationRating,
        location_rating: locationRating,
        value_rating: valueRating,
        content: reviewContent,
      });
      setShowReviewForm(false);
      setReviewStatus((prev) => prev ? { ...prev, can_review: false } : null);
      alert('Review submitted! It will be visible once both parties have reviewed.');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setActionLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/2" />
          <div className="h-64 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold mb-4">Booking not found</h1>
        <Link to="/trips" className="btn-primary">
          View your trips
        </Link>
      </div>
    );
  }

  const isGuest = booking.guest_id === user?.id;
  const isHost = booking.host_id === user?.id;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Status Banner */}
      <div className={`p-4 rounded-xl mb-8 ${getBookingStatusColor(booking.status)}`}>
        <div className="flex items-center justify-between">
          <div>
            <span className="font-semibold">Booking {getBookingStatusLabel(booking.status)}</span>
            {booking.status === 'pending' && (
              <p className="text-sm mt-1">Waiting for host confirmation</p>
            )}
          </div>
          {(booking.status === 'pending' || booking.status === 'confirmed') && (
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              className="text-sm underline hover:no-underline"
            >
              Cancel booking
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Listing Info */}
        <div>
          <div className="rounded-xl overflow-hidden mb-4">
            <img
              src={booking.listing_photos?.[0] || `https://picsum.photos/seed/${booking.listing_id}/400/300`}
              alt={booking.listing_title}
              className="w-full h-48 object-cover"
            />
          </div>

          <Link to={`/listing/${booking.listing_id}`} className="hover:underline">
            <h2 className="text-xl font-semibold mb-1">{booking.listing_title}</h2>
          </Link>
          <p className="text-gray-600">
            {booking.listing_city}, {booking.listing_state || booking.listing_country}
          </p>

          {booking.address_line1 && booking.status === 'confirmed' && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <h3 className="font-medium mb-2">Address</h3>
              <p className="text-gray-600">{booking.address_line1}</p>
            </div>
          )}
        </div>

        {/* Booking Details */}
        <div className="space-y-6">
          <div>
            <h3 className="font-semibold mb-3">Trip details</h3>
            <div className="space-y-2 text-gray-600">
              <div className="flex justify-between">
                <span>Dates</span>
                <span>{formatDateRange(booking.check_in, booking.check_out)}</span>
              </div>
              <div className="flex justify-between">
                <span>Guests</span>
                <span>{booking.guests}</span>
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 pt-6">
            <h3 className="font-semibold mb-3">Price details</h3>
            <div className="space-y-2 text-gray-600">
              <div className="flex justify-between">
                <span>{formatCurrency(booking.price_per_night)} x {booking.nights} nights</span>
                <span>{formatCurrency(booking.price_per_night * booking.nights)}</span>
              </div>
              {booking.cleaning_fee > 0 && (
                <div className="flex justify-between">
                  <span>Cleaning fee</span>
                  <span>{formatCurrency(booking.cleaning_fee)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Service fee</span>
                <span>{formatCurrency(booking.service_fee)}</span>
              </div>
              <div className="flex justify-between font-semibold text-gray-900 pt-2 border-t border-gray-200">
                <span>Total</span>
                <span>{formatCurrency(booking.total_price)}</span>
              </div>
            </div>
          </div>

          {/* Host/Guest Contact */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="font-semibold mb-3">{isGuest ? 'Host' : 'Guest'}</h3>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-gray-200 overflow-hidden">
                <img
                  src={isGuest ? booking.host_avatar : booking.guest_avatar}
                  alt=""
                  className="w-full h-full object-cover"
                />
              </div>
              <div>
                <p className="font-medium">{isGuest ? booking.host_name : booking.guest_name}</p>
                {booking.status === 'confirmed' && (
                  <p className="text-sm text-gray-500">
                    {isGuest ? booking.host_phone : booking.guest_phone || booking.guest_email}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* House Rules */}
          {booking.house_rules && booking.status === 'confirmed' && (
            <div className="border-t border-gray-200 pt-6">
              <h3 className="font-semibold mb-3">House rules</h3>
              <p className="text-gray-600 whitespace-pre-wrap">{booking.house_rules}</p>
            </div>
          )}
        </div>
      </div>

      {/* Review Section */}
      {booking.status === 'completed' && isGuest && reviewStatus?.can_review && (
        <div className="mt-8 border-t border-gray-200 pt-8">
          {!showReviewForm ? (
            <div className="text-center">
              <h3 className="text-xl font-semibold mb-2">How was your stay?</h3>
              <p className="text-gray-500 mb-4">Share your experience with the community</p>
              <button onClick={() => setShowReviewForm(true)} className="btn-primary">
                Write a review
              </button>
            </div>
          ) : (
            <div className="max-w-lg mx-auto">
              <h3 className="text-xl font-semibold mb-6">Write your review</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Overall Rating</label>
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        onClick={() => setRating(n)}
                        className={`w-10 h-10 rounded-full ${n <= rating ? 'bg-yellow-400' : 'bg-gray-200'}`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: 'Cleanliness', value: cleanlinessRating, setter: setCleanlinessRating },
                    { label: 'Communication', value: communicationRating, setter: setCommunicationRating },
                    { label: 'Location', value: locationRating, setter: setLocationRating },
                    { label: 'Value', value: valueRating, setter: setValueRating },
                  ].map(({ label, value, setter }) => (
                    <div key={label}>
                      <label className="block text-sm font-medium mb-1">{label}</label>
                      <select
                        value={value}
                        onChange={(e) => setter(parseInt(e.target.value))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        {[5, 4, 3, 2, 1].map((n) => (
                          <option key={n} value={n}>{n} stars</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Your review</label>
                  <textarea
                    value={reviewContent}
                    onChange={(e) => setReviewContent(e.target.value)}
                    placeholder="Tell others about your experience..."
                    rows={4}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                  />
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={() => setShowReviewForm(false)}
                    className="flex-1 btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmitReview}
                    disabled={actionLoading}
                    className="flex-1 btn-primary disabled:opacity-50"
                  >
                    {actionLoading ? 'Submitting...' : 'Submit Review'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
