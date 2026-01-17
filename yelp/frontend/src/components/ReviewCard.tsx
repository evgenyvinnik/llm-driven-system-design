/**
 * Review Card Component
 *
 * Displays a single user review with author info, rating, text content,
 * photos, vote buttons, and optional business owner response.
 *
 * @module components/ReviewCard
 */
import { Link } from '@tanstack/react-router';
import { User, ThumbsUp, MessageCircle, Smile } from 'lucide-react';
import { StarRating } from './StarRating';
import type { Review } from '../types';

/**
 * Props for the ReviewCard component.
 */
interface ReviewCardProps {
  /** The review data to display */
  review: Review;
  /** Whether to show the business name and link */
  showBusiness?: boolean;
  /** Callback when a vote button is clicked */
  onVote?: (reviewId: string, voteType: 'helpful' | 'funny' | 'cool') => void;
}

/**
 * ReviewCard displays a complete review including user info, rating,
 * review text, photos, vote buttons, and any owner response.
 *
 * @param props - Component properties
 * @returns Review card component
 *
 * @example
 * ```tsx
 * <ReviewCard
 *   review={review}
 *   showBusiness={true}
 *   onVote={(id, type) => handleVote(id, type)}
 * />
 * ```
 */
export function ReviewCard({ review, showBusiness = false, onVote }: ReviewCardProps) {
  /**
   * Formats a date string for display.
   *
   * @param dateString - ISO date string
   * @returns Formatted date (e.g., "Jan 15, 2024")
   */
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="border-b py-6 last:border-b-0">
      {/* User info section */}
      <ReviewerInfo review={review} showBusiness={showBusiness} formatDate={formatDate} />

      {/* Review text */}
      <div className="mt-4 text-gray-700 whitespace-pre-wrap">{review.text}</div>

      {/* Review photos */}
      {review.photos && review.photos.length > 0 && (
        <ReviewPhotos photos={review.photos} />
      )}

      {/* Vote buttons */}
      <VoteButtons review={review} onVote={onVote} />

      {/* Business owner response */}
      {review.response_text && (
        <OwnerResponse
          responseText={review.response_text}
          responseDate={review.response_created_at}
          formatDate={formatDate}
        />
      )}
    </div>
  );
}

/**
 * Props for the ReviewerInfo component.
 */
interface ReviewerInfoProps {
  review: Review;
  showBusiness: boolean;
  formatDate: (date: string) => string;
}

/**
 * ReviewerInfo displays the reviewer's avatar, name, review count, and rating.
 */
function ReviewerInfo({ review, showBusiness, formatDate }: ReviewerInfoProps) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-shrink-0">
        {review.user_avatar ? (
          <img
            src={review.user_avatar}
            alt={review.user_name}
            className="w-12 h-12 rounded-full object-cover"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
            <User className="w-6 h-6 text-gray-500" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-900">{review.user_name}</span>
          {review.user_review_count !== undefined && (
            <span className="text-sm text-gray-500">
              {review.user_review_count} reviews
            </span>
          )}
        </div>

        {showBusiness && review.business_name && (
          <Link
            to="/business/$slug"
            params={{ slug: review.business_slug || '' }}
            className="text-sm text-yelp-blue hover:underline"
          >
            {review.business_name}
          </Link>
        )}

        <div className="flex items-center gap-2 mt-1">
          <StarRating rating={review.rating} size="sm" />
          <span className="text-sm text-gray-500">{formatDate(review.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the ReviewPhotos component.
 */
interface ReviewPhotosProps {
  /** Array of photo URLs */
  photos: string[];
}

/**
 * ReviewPhotos displays a horizontal scrollable gallery of review photos.
 */
function ReviewPhotos({ photos }: ReviewPhotosProps) {
  return (
    <div className="flex gap-2 mt-4 overflow-x-auto">
      {photos.map((photo, index) => (
        <img
          key={index}
          src={photo}
          alt={`Review photo ${index + 1}`}
          className="w-24 h-24 object-cover rounded-md flex-shrink-0"
        />
      ))}
    </div>
  );
}

/**
 * Props for the VoteButtons component.
 */
interface VoteButtonsProps {
  review: Review;
  onVote?: (reviewId: string, voteType: 'helpful' | 'funny' | 'cool') => void;
}

/**
 * VoteButtons displays the helpful, funny, and cool vote buttons.
 */
function VoteButtons({ review, onVote }: VoteButtonsProps) {
  return (
    <div className="flex items-center gap-4 mt-4">
      <button
        onClick={() => onVote?.(review.id, 'helpful')}
        className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ThumbsUp className="w-4 h-4" />
        <span>Helpful ({review.helpful_count})</span>
      </button>
      <button
        onClick={() => onVote?.(review.id, 'funny')}
        className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <Smile className="w-4 h-4" />
        <span>Funny ({review.funny_count})</span>
      </button>
      <button
        onClick={() => onVote?.(review.id, 'cool')}
        className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <MessageCircle className="w-4 h-4" />
        <span>Cool ({review.cool_count})</span>
      </button>
    </div>
  );
}

/**
 * Props for the OwnerResponse component.
 */
interface OwnerResponseProps {
  responseText: string;
  responseDate?: string;
  formatDate: (date: string) => string;
}

/**
 * OwnerResponse displays the business owner's response to a review.
 */
function OwnerResponse({ responseText, responseDate, formatDate }: OwnerResponseProps) {
  return (
    <div className="mt-4 bg-gray-50 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-semibold text-gray-900">Response from owner</span>
        {responseDate && (
          <span className="text-sm text-gray-500">{formatDate(responseDate)}</span>
        )}
      </div>
      <p className="text-gray-700">{responseText}</p>
    </div>
  );
}
