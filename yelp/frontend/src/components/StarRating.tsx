/**
 * Star Rating Components
 *
 * This module provides components for displaying and selecting star ratings.
 * Used throughout the application for business ratings and review submissions.
 *
 * @module components/StarRating
 */
import { Star, StarHalf } from 'lucide-react';

/**
 * Props for the StarRating component.
 */
interface StarRatingProps {
  /** The rating value to display (0-5, supports decimals) */
  rating: number;
  /** Size variant for the stars */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show the numeric rating value */
  showValue?: boolean;
}

/**
 * StarRating displays a read-only star rating with support for half stars.
 * Renders filled, half-filled, and empty stars based on the rating value.
 *
 * @param props - Component properties
 * @returns Star rating display component
 *
 * @example
 * ```tsx
 * <StarRating rating={4.5} size="lg" showValue />
 * ```
 */
export function StarRating({ rating, size = 'md', showValue = false }: StarRatingProps) {
  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  const textClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };

  const stars = [];
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 >= 0.5;

  for (let i = 0; i < 5; i++) {
    if (i < fullStars) {
      stars.push(
        <Star
          key={i}
          className={`${sizeClasses[size]} fill-yelp-red text-yelp-red`}
        />
      );
    } else if (i === fullStars && hasHalfStar) {
      stars.push(
        <StarHalf
          key={i}
          className={`${sizeClasses[size]} fill-yelp-red text-yelp-red`}
        />
      );
    } else {
      stars.push(
        <Star
          key={i}
          className={`${sizeClasses[size]} text-gray-300`}
        />
      );
    }
  }

  return (
    <div className="flex items-center gap-1">
      <div className="flex">{stars}</div>
      {showValue && (
        <span className={`${textClasses[size]} text-gray-600 ml-1`}>
          {rating.toFixed(1)}
        </span>
      )}
    </div>
  );
}

/**
 * Props for the InteractiveStarRating component.
 */
interface InteractiveStarRatingProps {
  /** Current selected rating value (1-5) */
  value: number;
  /** Callback when a star is clicked */
  onChange: (value: number) => void;
  /** Size variant for the stars */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * InteractiveStarRating provides a clickable star rating input.
 * Users can click on any star to set the rating value.
 *
 * @param props - Component properties
 * @returns Interactive star rating input component
 *
 * @example
 * ```tsx
 * const [rating, setRating] = useState(0);
 * <InteractiveStarRating value={rating} onChange={setRating} />
 * ```
 */
export function InteractiveStarRating({ value, onChange, size = 'lg' }: InteractiveStarRatingProps) {
  const sizeClasses = {
    sm: 'w-6 h-6',
    md: 'w-8 h-8',
    lg: 'w-10 h-10',
  };

  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Rating selection">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onChange(star)}
          className="focus:outline-none"
          aria-label={`${star} star${star > 1 ? 's' : ''}`}
          aria-pressed={value >= star}
        >
          <Star
            className={`${sizeClasses[size]} cursor-pointer transition-colors ${
              star <= value
                ? 'fill-yelp-red text-yelp-red'
                : 'text-gray-300 hover:text-yelp-red'
            }`}
          />
        </button>
      ))}
    </div>
  );
}
