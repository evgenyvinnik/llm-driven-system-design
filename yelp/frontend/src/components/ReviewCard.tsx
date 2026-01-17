import { Link } from '@tanstack/react-router';
import { User, ThumbsUp, MessageCircle, Smile } from 'lucide-react';
import { StarRating } from './StarRating';
import type { Review } from '../types';

interface ReviewCardProps {
  review: Review;
  showBusiness?: boolean;
  onVote?: (reviewId: string, voteType: 'helpful' | 'funny' | 'cool') => void;
}

export function ReviewCard({ review, showBusiness = false, onVote }: ReviewCardProps) {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="border-b py-6 last:border-b-0">
      {/* User info */}
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

      {/* Review text */}
      <div className="mt-4 text-gray-700 whitespace-pre-wrap">{review.text}</div>

      {/* Review photos */}
      {review.photos && review.photos.length > 0 && (
        <div className="flex gap-2 mt-4 overflow-x-auto">
          {review.photos.map((photo, index) => (
            <img
              key={index}
              src={photo}
              alt={`Review photo ${index + 1}`}
              className="w-24 h-24 object-cover rounded-md flex-shrink-0"
            />
          ))}
        </div>
      )}

      {/* Vote buttons */}
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

      {/* Business response */}
      {review.response_text && (
        <div className="mt-4 bg-gray-50 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="font-semibold text-gray-900">Response from owner</span>
            {review.response_created_at && (
              <span className="text-sm text-gray-500">
                {formatDate(review.response_created_at)}
              </span>
            )}
          </div>
          <p className="text-gray-700">{review.response_text}</p>
        </div>
      )}
    </div>
  );
}
