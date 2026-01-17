import type { Review } from '../types';
import { StarRating } from './AppCard';

interface ReviewCardProps {
  review: Review;
  onVote?: (helpful: boolean) => void;
}

export function ReviewCard({ review, onVote }: ReviewCardProps) {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="py-4 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-400 to-gray-600 flex items-center justify-center text-white font-medium">
          {(review.user?.displayName || review.user?.username || 'U').charAt(0).toUpperCase()}
        </div>

        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-gray-900">
              {review.user?.displayName || review.user?.username || 'Anonymous'}
            </span>
            <StarRating rating={review.rating} size="small" />
          </div>

          {review.title && (
            <h4 className="font-semibold text-gray-900 mb-1">{review.title}</h4>
          )}

          {review.body && (
            <p className="text-gray-700 mb-2">{review.body}</p>
          )}

          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">{formatDate(review.createdAt)}</span>
            {review.appVersion && (
              <span className="text-gray-400">v{review.appVersion}</span>
            )}

            {onVote && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onVote(true)}
                  className="flex items-center gap-1 text-gray-500 hover:text-primary-600"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                  {review.helpfulCount > 0 && review.helpfulCount}
                </button>
                <button
                  onClick={() => onVote(false)}
                  className="flex items-center gap-1 text-gray-500 hover:text-red-600"
                >
                  <svg className="w-4 h-4 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {review.developerResponse && (
            <div className="mt-3 p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-gray-900">Developer Response</span>
                {review.developerResponseAt && (
                  <span className="text-xs text-gray-400">
                    {formatDate(review.developerResponseAt)}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-700">{review.developerResponse}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface RatingBarProps {
  star: number;
  count: number;
  total: number;
}

export function RatingBar({ star, count, total }: RatingBarProps) {
  const percentage = total > 0 ? (count / total) * 100 : 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-500 w-8">{star}</span>
      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-yellow-400 rounded-full transition-all duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-sm text-gray-400 w-12 text-right">{count}</span>
    </div>
  );
}
