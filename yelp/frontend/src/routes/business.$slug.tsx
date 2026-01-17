import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import {
  MapPin,
  Phone,
  Globe,
  Clock,
  CheckCircle,
  Star,
  Camera,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { StarRating, InteractiveStarRating } from '../components/StarRating';
import { ReviewCard } from '../components/ReviewCard';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import type { Business, Review, Pagination } from '../types';

export const Route = createFileRoute('/business/$slug')({
  component: BusinessDetailPage,
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function BusinessDetailPage() {
  const { slug } = Route.useParams();
  const { user, isAuthenticated } = useAuthStore();
  const [business, setBusiness] = useState<Business | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBusiness();
  }, [slug]);

  const loadBusiness = async () => {
    setIsLoading(true);
    try {
      const [bizResponse, reviewsResponse] = await Promise.all([
        api.get<{ business: Business }>(`/businesses/${slug}`),
        api.get<{ reviews: Review[]; pagination: Pagination }>(`/businesses/${slug}/reviews`),
      ]);
      setBusiness(bizResponse.business);
      setReviews(reviewsResponse.reviews);
      setPagination(reviewsResponse.pagination);
    } catch (err) {
      console.error('Failed to load business:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadMoreReviews = async (page: number) => {
    if (!business) return;
    try {
      const response = await api.get<{ reviews: Review[]; pagination: Pagination }>(
        `/businesses/${business.id}/reviews?page=${page}`
      );
      setReviews(response.reviews);
      setPagination(response.pagination);
    } catch (err) {
      console.error('Failed to load reviews:', err);
    }
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!business || !reviewRating) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await api.post<{ review: Review }>('/reviews', {
        business_id: business.id,
        rating: reviewRating,
        text: reviewText,
      });
      setReviews([response.review, ...reviews]);
      setShowReviewForm(false);
      setReviewRating(0);
      setReviewText('');
      loadBusiness(); // Refresh to get updated rating
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit review');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVote = async (reviewId: string, voteType: 'helpful' | 'funny' | 'cool') => {
    if (!isAuthenticated) {
      window.location.href = '/login';
      return;
    }

    try {
      await api.post(`/reviews/${reviewId}/vote`, { vote_type: voteType });
      // Optimistically update the UI
      setReviews(
        reviews.map((r) =>
          r.id === reviewId
            ? { ...r, [`${voteType}_count`]: r[`${voteType}_count`] + 1 }
            : r
        )
      );
    } catch (err) {
      console.error('Failed to vote:', err);
    }
  };

  const formatTime = (time: string) => {
    const [hours, minutes] = time.split(':');
    const h = parseInt(hours);
    const period = h >= 12 ? 'PM' : 'AM';
    const formattedHour = h % 12 || 12;
    return `${formattedHour}:${minutes} ${period}`;
  };

  const isOpenNow = () => {
    if (!business?.hours) return null;
    const now = new Date();
    const dayOfWeek = now.getDay();
    const currentHours = business.hours.find((h) => h.day_of_week === dayOfWeek);

    if (!currentHours || currentHours.is_closed) return false;

    const currentTime = now.toTimeString().slice(0, 5);
    return currentTime >= currentHours.open_time && currentTime <= currentHours.close_time;
  };

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-64 bg-gray-200 rounded" />
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-200 rounded w-1/4" />
        </div>
      </div>
    );
  }

  if (!business) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Business not found</h1>
        <Link to="/search" className="text-yelp-red hover:underline mt-4 inline-block">
          Back to search
        </Link>
      </div>
    );
  }

  const photos = business.photos || [];
  const priceLevel = business.price_level ? '$'.repeat(business.price_level) : null;
  const openStatus = isOpenNow();

  return (
    <div>
      {/* Photo Gallery */}
      {photos.length > 0 && (
        <div className="relative h-64 md:h-96 bg-gray-900">
          <img
            src={photos[currentPhotoIndex]?.url}
            alt={business.name}
            className="w-full h-full object-cover"
          />
          {photos.length > 1 && (
            <>
              <button
                onClick={() => setCurrentPhotoIndex((i) => (i > 0 ? i - 1 : photos.length - 1))}
                className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2 hover:bg-white"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
              <button
                onClick={() => setCurrentPhotoIndex((i) => (i < photos.length - 1 ? i + 1 : 0))}
                className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-2 hover:bg-white"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
                {photos.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setCurrentPhotoIndex(i)}
                    className={`w-2 h-2 rounded-full ${
                      i === currentPhotoIndex ? 'bg-white' : 'bg-white/50'
                    }`}
                  />
                ))}
              </div>
            </>
          )}
          <button className="absolute bottom-4 right-4 bg-white rounded-md px-4 py-2 flex items-center gap-2 hover:bg-gray-100">
            <Camera className="w-4 h-4" />
            See all {photos.length} photos
          </button>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Main Content */}
          <div className="flex-1">
            {/* Business Header */}
            <div className="mb-8">
              <h1 className="text-3xl font-bold text-gray-900 mb-2">{business.name}</h1>
              <div className="flex flex-wrap items-center gap-4 mb-4">
                <StarRating rating={business.rating} size="lg" showValue />
                <span className="text-gray-600">{business.review_count} reviews</span>
                {priceLevel && (
                  <>
                    <span className="text-gray-300">|</span>
                    <span className="font-medium">{priceLevel}</span>
                  </>
                )}
                {business.is_verified && (
                  <span className="flex items-center gap-1 text-green-600">
                    <CheckCircle className="w-4 h-4" />
                    Verified
                  </span>
                )}
              </div>
              {business.categories && Array.isArray(business.categories) && (
                <div className="flex flex-wrap gap-2">
                  {business.categories.map((cat) => (
                    <Link
                      key={typeof cat === 'string' ? cat : cat.slug}
                      to="/search"
                      search={{ category: typeof cat === 'string' ? cat : cat.slug }}
                      className="text-sm text-yelp-blue hover:underline"
                    >
                      {typeof cat === 'string' ? cat : cat.name}
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Description */}
            {business.description && (
              <div className="mb-8">
                <h2 className="text-xl font-semibold mb-2">About</h2>
                <p className="text-gray-700">{business.description}</p>
              </div>
            )}

            {/* Write Review Button */}
            <div className="mb-8">
              {isAuthenticated ? (
                <button
                  onClick={() => setShowReviewForm(!showReviewForm)}
                  className="btn-primary flex items-center gap-2"
                >
                  <Star className="w-5 h-5" />
                  Write a Review
                </button>
              ) : (
                <Link to="/login" className="btn-primary inline-flex items-center gap-2">
                  <Star className="w-5 h-5" />
                  Log in to Review
                </Link>
              )}
            </div>

            {/* Review Form */}
            {showReviewForm && (
              <div className="bg-white rounded-lg shadow p-6 mb-8">
                <h3 className="text-lg font-semibold mb-4">Write a Review</h3>
                <form onSubmit={handleSubmitReview}>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-2">Your Rating</label>
                    <InteractiveStarRating value={reviewRating} onChange={setReviewRating} />
                  </div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium mb-2">Your Review</label>
                    <textarea
                      value={reviewText}
                      onChange={(e) => setReviewText(e.target.value)}
                      className="input-field h-32"
                      placeholder="Share your experience..."
                      required
                    />
                  </div>
                  {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={!reviewRating || isSubmitting}
                      className="btn-primary disabled:opacity-50"
                    >
                      {isSubmitting ? 'Submitting...' : 'Submit Review'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowReviewForm(false)}
                      className="btn-outline"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Reviews */}
            <div>
              <h2 className="text-xl font-semibold mb-4">
                Reviews ({business.review_count})
              </h2>
              {reviews.length > 0 ? (
                <>
                  <div className="bg-white rounded-lg shadow divide-y">
                    {reviews.map((review) => (
                      <div key={review.id} className="p-6">
                        <ReviewCard review={review} onVote={handleVote} />
                      </div>
                    ))}
                  </div>
                  {pagination && pagination.pages > 1 && (
                    <div className="flex justify-center mt-6 gap-2">
                      {[...Array(Math.min(pagination.pages, 10))].map((_, i) => (
                        <button
                          key={i}
                          onClick={() => loadMoreReviews(i + 1)}
                          className={`px-4 py-2 rounded ${
                            pagination.page === i + 1
                              ? 'bg-yelp-red text-white'
                              : 'bg-white border hover:bg-gray-50'
                          }`}
                        >
                          {i + 1}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="bg-white rounded-lg shadow p-8 text-center">
                  <p className="text-gray-600">No reviews yet. Be the first to review!</p>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <aside className="lg:w-80">
            <div className="bg-white rounded-lg shadow p-6 sticky top-4">
              {/* Contact Info */}
              <div className="space-y-4 mb-6">
                <div className="flex items-start gap-3">
                  <MapPin className="w-5 h-5 text-gray-500 mt-0.5" />
                  <div>
                    <p className="text-gray-900">{business.address}</p>
                    <p className="text-gray-600">
                      {business.city}, {business.state} {business.zip_code}
                    </p>
                    <a
                      href={`https://maps.google.com/?q=${encodeURIComponent(
                        `${business.address}, ${business.city}, ${business.state}`
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-yelp-blue hover:underline text-sm"
                    >
                      Get Directions
                    </a>
                  </div>
                </div>

                {business.phone && (
                  <div className="flex items-center gap-3">
                    <Phone className="w-5 h-5 text-gray-500" />
                    <a href={`tel:${business.phone}`} className="text-yelp-blue hover:underline">
                      {business.phone}
                    </a>
                  </div>
                )}

                {business.website && (
                  <div className="flex items-center gap-3">
                    <Globe className="w-5 h-5 text-gray-500" />
                    <a
                      href={business.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-yelp-blue hover:underline truncate"
                    >
                      {business.website.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                )}
              </div>

              {/* Hours */}
              {business.hours && business.hours.length > 0 && (
                <div className="border-t pt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Clock className="w-5 h-5 text-gray-500" />
                    <h3 className="font-semibold">Hours</h3>
                    {openStatus !== null && (
                      <span
                        className={`text-sm ${
                          openStatus ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {openStatus ? 'Open Now' : 'Closed'}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2 text-sm">
                    {business.hours.map((h) => (
                      <div key={h.day_of_week} className="flex justify-between">
                        <span className="text-gray-600">{DAYS[h.day_of_week]}</span>
                        <span className="text-gray-900">
                          {h.is_closed
                            ? 'Closed'
                            : `${formatTime(h.open_time)} - ${formatTime(h.close_time)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Claim Business */}
              {!business.is_claimed && (
                <div className="border-t pt-6 mt-6">
                  <p className="text-sm text-gray-600 mb-2">Is this your business?</p>
                  <Link
                    to="/login"
                    className="text-yelp-blue hover:underline text-sm font-medium"
                  >
                    Claim this business
                  </Link>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
