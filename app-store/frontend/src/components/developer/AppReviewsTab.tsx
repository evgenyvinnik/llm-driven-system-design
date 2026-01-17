/**
 * @fileoverview App reviews tab component for developer dashboard.
 * Displays reviews with rating summary and response capabilities.
 */

import type { Review, RatingSummary } from '../../types';
import { StarRating } from '../AppCard';
import { ReviewCard } from '../ReviewCard';
import { ResponseForm } from './ResponseForm';

/**
 * Props for the AppReviewsTab component.
 */
interface AppReviewsTabProps {
  /** Array of reviews for the app */
  reviews: Review[];
  /** Rating summary statistics */
  ratings: RatingSummary | null;
  /** Callback when developer responds to a review */
  onRespondToReview: (reviewId: string, response: string) => void;
}

/**
 * Displays the reviews tab content with rating summary and review list.
 * Provides inline response forms for reviews without developer responses.
 *
 * @param props - Component props
 * @returns Reviews tab with summary header and review list
 */
export function AppReviewsTab({
  reviews,
  ratings,
  onRespondToReview,
}: AppReviewsTabProps) {
  return (
    <div className="card p-6">
      <ReviewSummaryHeader ratings={ratings} />

      {reviews.length === 0 ? (
        <EmptyReviewsMessage />
      ) : (
        <ReviewList reviews={reviews} onRespondToReview={onRespondToReview} />
      )}
    </div>
  );
}

/**
 * Props for the ReviewSummaryHeader component.
 */
interface ReviewSummaryHeaderProps {
  /** Rating summary statistics */
  ratings: RatingSummary | null;
}

/**
 * Displays the review summary header with total count and average rating.
 *
 * @param props - Component props
 * @returns Summary header with rating statistics
 */
function ReviewSummaryHeader({ ratings }: ReviewSummaryHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h3 className="text-xl font-bold text-gray-900">Reviews</h3>
        <p className="text-gray-500">{ratings?.totalRatings || 0} total reviews</p>
      </div>
      <div className="text-center">
        <div className="text-4xl font-bold text-gray-900">
          {ratings?.averageRating.toFixed(1) || '0.0'}
        </div>
        <StarRating rating={ratings?.averageRating || 0} />
      </div>
    </div>
  );
}

/**
 * Displays a message when there are no reviews.
 *
 * @returns Empty state message
 */
function EmptyReviewsMessage() {
  return <p className="text-center text-gray-500 py-8">No reviews yet</p>;
}

/**
 * Props for the ReviewList component.
 */
interface ReviewListProps {
  /** Array of reviews to display */
  reviews: Review[];
  /** Callback when developer responds to a review */
  onRespondToReview: (reviewId: string, response: string) => void;
}

/**
 * Renders a list of reviews with response forms.
 * Shows response form only for reviews without developer responses.
 *
 * @param props - Component props
 * @returns List of review cards with response capabilities
 */
function ReviewList({ reviews, onRespondToReview }: ReviewListProps) {
  return (
    <div className="divide-y divide-gray-100">
      {reviews.map((review) => (
        <div key={review.id} className="py-4">
          <ReviewCard review={review} />
          {!review.developerResponse && (
            <ResponseForm
              onSubmit={(response) => onRespondToReview(review.id, response)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
