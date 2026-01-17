/**
 * Business Detail Page Route
 *
 * Displays comprehensive information about a single business including
 * photos, contact details, hours, and reviews. Authenticated users can
 * write reviews and vote on existing ones.
 *
 * @module routes/business.$slug
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import api from '../services/api';
import type { Business, Review, Pagination } from '../types';
import {
  PhotoGallery,
  BusinessHeader,
  BusinessSidebar,
  WriteReviewButton,
  ReviewFormCard,
  ReviewsList,
} from '../components/business';

export const Route = createFileRoute('/business/$slug')({
  component: BusinessDetailPage,
});

/**
 * BusinessDetailPage is the main route component for displaying
 * a single business's complete profile including photos, details,
 * and reviews.
 *
 * @returns The business detail page component
 */
function BusinessDetailPage() {
  const { slug } = Route.useParams();
  const { user, isAuthenticated } = useAuthStore();
  const [business, setBusiness] = useState<Business | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    loadBusiness();
  }, [slug]);

  /**
   * Loads business data and reviews from the API.
   */
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

  /**
   * Loads a specific page of reviews.
   *
   * @param page - Page number to load
   */
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

  /**
   * Submits a new review for the business.
   *
   * @param rating - Star rating (1-5)
   * @param text - Review text content
   */
  const handleSubmitReview = async (rating: number, text: string) => {
    if (!business) return;
    setReviewError(null);

    try {
      const response = await api.post<{ review: Review }>('/reviews', {
        business_id: business.id,
        rating,
        text,
      });
      setReviews([response.review, ...reviews]);
      setShowReviewForm(false);
      loadBusiness(); // Refresh to get updated rating
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Failed to submit review');
      throw err; // Re-throw so the form knows submission failed
    }
  };

  /**
   * Records a vote on a review.
   *
   * @param reviewId - ID of the review to vote on
   * @param voteType - Type of vote (helpful, funny, or cool)
   */
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
          r.id === reviewId ? { ...r, [`${voteType}_count`]: r[`${voteType}_count`] + 1 } : r
        )
      );
    } catch (err) {
      console.error('Failed to vote:', err);
    }
  };

  // Loading state
  if (isLoading) {
    return <LoadingSkeleton />;
  }

  // Not found state
  if (!business) {
    return <BusinessNotFound />;
  }

  const photos = business.photos || [];

  return (
    <div>
      {/* Photo Gallery */}
      <PhotoGallery photos={photos} businessName={business.name} />

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Main Content */}
          <div className="flex-1">
            <BusinessHeader business={business} />

            {/* Description */}
            {business.description && (
              <div className="mb-8">
                <h2 className="text-xl font-semibold mb-2">About</h2>
                <p className="text-gray-700">{business.description}</p>
              </div>
            )}

            {/* Write Review Section */}
            <div className="mb-8">
              <WriteReviewButton
                isAuthenticated={isAuthenticated}
                onToggleForm={() => setShowReviewForm(!showReviewForm)}
                showForm={showReviewForm}
              />
            </div>

            {/* Review Form */}
            {showReviewForm && (
              <ReviewFormCard
                onSubmit={handleSubmitReview}
                onCancel={() => setShowReviewForm(false)}
                error={reviewError}
              />
            )}

            {/* Reviews List */}
            <ReviewsList
              reviews={reviews}
              totalReviews={business.review_count}
              pagination={pagination}
              onPageChange={loadMoreReviews}
              onVote={handleVote}
            />
          </div>

          {/* Sidebar */}
          <BusinessSidebar business={business} />
        </div>
      </div>
    </div>
  );
}

/**
 * LoadingSkeleton displays a placeholder while business data loads.
 *
 * @returns Loading skeleton component
 */
function LoadingSkeleton() {
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

/**
 * BusinessNotFound displays when a business cannot be found.
 *
 * @returns Not found message with link back to search
 */
function BusinessNotFound() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-8 text-center">
      <h1 className="text-2xl font-bold text-gray-900">Business not found</h1>
      <Link to="/search" className="text-yelp-red hover:underline mt-4 inline-block">
        Back to search
      </Link>
    </div>
  );
}
