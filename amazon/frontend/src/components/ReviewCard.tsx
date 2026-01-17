import type { Review } from '../types';
import { api } from '../services/api';
import { useState } from 'react';

interface ReviewCardProps {
  review: Review;
}

export function ReviewCard({ review }: ReviewCardProps) {
  const [helpfulCount, setHelpfulCount] = useState(review.helpful_count);
  const [marked, setMarked] = useState(false);

  const handleHelpful = async () => {
    if (marked) return;
    try {
      await api.markReviewHelpful(review.id);
      setHelpfulCount((c) => c + 1);
      setMarked(true);
    } catch {
      // Ignore
    }
  };

  const date = new Date(review.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="border-b py-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
          <span className="text-gray-600 font-medium">
            {review.user_name?.[0]?.toUpperCase() || '?'}
          </span>
        </div>

        <div className="flex-1">
          <div className="font-medium">{review.user_name || 'Anonymous'}</div>

          <div className="flex items-center gap-2 mt-1">
            <div className="flex text-amber-400">
              {[1, 2, 3, 4, 5].map((star) => (
                <svg
                  key={star}
                  className={`w-4 h-4 ${
                    star <= review.rating ? 'fill-current' : 'fill-gray-300'
                  }`}
                  viewBox="0 0 20 20"
                >
                  <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
                </svg>
              ))}
            </div>
            {review.title && (
              <span className="font-bold text-gray-900">{review.title}</span>
            )}
          </div>

          <div className="text-sm text-gray-500 mt-1">
            Reviewed on {date}
            {review.verified_purchase && (
              <span className="ml-2 text-orange-600">Verified Purchase</span>
            )}
          </div>

          {review.content && (
            <p className="mt-2 text-gray-700">{review.content}</p>
          )}

          <div className="mt-3 flex items-center gap-4 text-sm">
            <button
              onClick={handleHelpful}
              disabled={marked}
              className={`text-gray-600 hover:text-gray-900 ${marked ? 'opacity-50' : ''}`}
            >
              Helpful ({helpfulCount})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
