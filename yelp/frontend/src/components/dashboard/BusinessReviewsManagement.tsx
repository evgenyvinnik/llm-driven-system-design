import { useState } from 'react';
import { ReviewCard } from '../ReviewCard';
import type { Review } from '../../types';

/**
 * Props for the BusinessReviewsManagement component.
 */
interface BusinessReviewsManagementProps {
  /** Array of reviews to display */
  reviews: Review[];
  /** Callback when owner responds to a review */
  onRespond: (reviewId: string, responseText: string) => Promise<void>;
}

/**
 * BusinessReviewsManagement displays a list of reviews with the ability
 * for business owners to respond to reviews that don't have responses yet.
 *
 * @param props - Component properties
 * @returns Reviews management component
 */
export function BusinessReviewsManagement({ reviews, onRespond }: BusinessReviewsManagementProps) {
  if (reviews.length === 0) {
    return <EmptyReviewsState />;
  }

  return (
    <div className="space-y-6">
      {reviews.map((review) => (
        <div key={review.id} className="bg-white rounded-lg shadow p-6">
          <ReviewCard review={review} />
          {!review.response_text && (
            <div className="mt-4 pt-4 border-t">
              <ResponseForm onSubmit={(text) => onRespond(review.id, text)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * EmptyReviewsState displays a message when there are no reviews.
 *
 * @returns Empty state component
 */
function EmptyReviewsState() {
  return (
    <div className="text-center py-12 bg-white rounded-lg shadow">
      <p className="text-gray-600">No reviews yet</p>
    </div>
  );
}

/**
 * Props for the ResponseForm component.
 */
interface ResponseFormProps {
  /** Callback when response is submitted */
  onSubmit: (text: string) => Promise<void>;
}

/**
 * ResponseForm allows business owners to respond to customer reviews.
 *
 * @param props - Component properties
 * @returns Response form component
 */
function ResponseForm({ onSubmit }: ResponseFormProps) {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Handles form submission.
   * Validates that text is not empty before submitting.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    setIsSubmitting(true);
    try {
      await onSubmit(text);
      setText('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Respond to this review
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="input-field h-20 mb-2"
        placeholder="Write your response..."
      />
      <button
        type="submit"
        disabled={!text.trim() || isSubmitting}
        className="btn-primary text-sm disabled:opacity-50"
      >
        {isSubmitting ? 'Posting...' : 'Post Response'}
      </button>
    </form>
  );
}
