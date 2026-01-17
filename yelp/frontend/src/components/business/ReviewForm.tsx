import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import { InteractiveStarRating } from '../StarRating';

/**
 * Props for the WriteReviewButton component.
 */
interface WriteReviewButtonProps {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** Callback to show/hide the review form */
  onToggleForm: () => void;
  /** Whether the review form is currently shown */
  showForm: boolean;
}

/**
 * WriteReviewButton displays either a button to open the review form
 * or a link to login if the user is not authenticated.
 *
 * @param props - Component properties
 * @returns Write review button or login link
 */
export function WriteReviewButton({
  isAuthenticated,
  onToggleForm,
  showForm,
}: WriteReviewButtonProps) {
  if (isAuthenticated) {
    return (
      <button onClick={onToggleForm} className="btn-primary flex items-center gap-2">
        <Star className="w-5 h-5" />
        {showForm ? 'Cancel Review' : 'Write a Review'}
      </button>
    );
  }

  return (
    <Link to="/login" className="btn-primary inline-flex items-center gap-2">
      <Star className="w-5 h-5" />
      Log in to Review
    </Link>
  );
}

/**
 * Props for the ReviewFormCard component.
 */
interface ReviewFormCardProps {
  /** Callback when form is submitted with rating and text */
  onSubmit: (rating: number, text: string) => Promise<void>;
  /** Callback to close/cancel the form */
  onCancel: () => void;
  /** Error message to display (if any) */
  error?: string | null;
}

/**
 * ReviewFormCard displays a form for writing a new review with
 * interactive star rating and text input.
 *
 * @param props - Component properties
 * @returns Review form component
 */
export function ReviewFormCard({ onSubmit, onCancel, error }: ReviewFormCardProps) {
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  /**
   * Handles form submission.
   * Validates rating is set before submitting.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rating) return;

    setIsSubmitting(true);
    try {
      await onSubmit(rating, text);
      // Reset form on success
      setRating(0);
      setText('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-8">
      <h3 className="text-lg font-semibold mb-4">Write a Review</h3>
      <form onSubmit={handleSubmit}>
        {/* Rating selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Your Rating</label>
          <InteractiveStarRating value={rating} onChange={setRating} />
        </div>

        {/* Review text */}
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Your Review</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="input-field h-32"
            placeholder="Share your experience..."
            required
          />
        </div>

        {/* Error message */}
        {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={!rating || isSubmitting}
            className="btn-primary disabled:opacity-50"
          >
            {isSubmitting ? 'Submitting...' : 'Submit Review'}
          </button>
          <button type="button" onClick={onCancel} className="btn-outline">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
