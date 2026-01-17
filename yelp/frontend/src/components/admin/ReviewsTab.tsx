import { Link } from '@tanstack/react-router';
import type { Review } from '../../types';

/**
 * Props for the ReviewsTab component.
 */
interface ReviewsTabProps {
  /** Array of reviews to display */
  reviews: Review[];
  /** Callback when a review is deleted */
  onDeleteReview: (reviewId: string) => void;
}

/**
 * ReviewsTab displays a list of reviews for moderation with delete functionality.
 *
 * @param props - Component properties
 * @returns Reviews tab content
 */
export function ReviewsTab({ reviews, onDeleteReview }: ReviewsTabProps) {
  return (
    <div className="space-y-4">
      {reviews.map((review) => (
        <ReviewModerationCard
          key={review.id}
          review={review}
          onDelete={() => onDeleteReview(review.id)}
        />
      ))}
      {reviews.length === 0 && (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <p className="text-gray-600">No reviews to display</p>
        </div>
      )}
    </div>
  );
}

/**
 * Props for the ReviewModerationCard component.
 */
interface ReviewModerationCardProps {
  /** Review data */
  review: Review;
  /** Callback when delete is clicked */
  onDelete: () => void;
}

/**
 * ReviewModerationCard displays a single review with moderation controls.
 *
 * @param props - Component properties
 * @returns Review moderation card
 */
function ReviewModerationCard({ review, onDelete }: ReviewModerationCardProps) {
  /**
   * Handles the delete confirmation and action.
   */
  const handleDelete = () => {
    if (confirm('Are you sure you want to delete this review?')) {
      onDelete();
    }
  };

  /**
   * Formats a date string for display.
   */
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  /**
   * Renders star characters for the rating.
   */
  const renderStars = (rating: number) => {
    return '*'.repeat(rating);
  };

  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex justify-between items-start">
        <div>
          {/* Review header */}
          <div className="flex items-center gap-2 mb-2">
            <span className="font-semibold">{review.user_name}</span>
            <span className="text-gray-400">reviewed</span>
            <Link
              to="/business/$slug"
              params={{ slug: review.business_slug || '' }}
              className="text-yelp-blue hover:underline"
            >
              {review.business_name}
            </Link>
          </div>

          {/* Rating and date */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-yellow-500">{renderStars(review.rating)}</span>
            <span className="text-gray-500 text-sm">{formatDate(review.created_at)}</span>
          </div>

          {/* Review text */}
          <p className="text-gray-700">{review.text}</p>
        </div>

        {/* Delete button */}
        <button onClick={handleDelete} className="text-red-600 hover:text-red-800">
          Delete
        </button>
      </div>
    </div>
  );
}
