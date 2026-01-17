import { ReviewCard } from '../ReviewCard';
import type { Review, Pagination } from '../../types';

/**
 * Props for the ReviewsList component.
 */
interface ReviewsListProps {
  /** Array of reviews to display */
  reviews: Review[];
  /** Total number of reviews for the business */
  totalReviews: number;
  /** Pagination info (optional) */
  pagination?: Pagination | null;
  /** Callback when user navigates to a different page */
  onPageChange?: (page: number) => void;
  /** Callback when user votes on a review */
  onVote?: (reviewId: string, voteType: 'helpful' | 'funny' | 'cool') => void;
}

/**
 * ReviewsList displays a list of reviews with pagination controls.
 *
 * Features:
 * - Shows review count in header
 * - Displays empty state when no reviews exist
 * - Provides pagination for navigating through reviews
 *
 * @param props - Component properties
 * @returns Reviews list component
 */
export function ReviewsList({
  reviews,
  totalReviews,
  pagination,
  onPageChange,
  onVote,
}: ReviewsListProps) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Reviews ({totalReviews})</h2>

      {reviews.length > 0 ? (
        <>
          {/* Reviews container */}
          <div className="bg-white rounded-lg shadow divide-y">
            {reviews.map((review) => (
              <div key={review.id} className="p-6">
                <ReviewCard review={review} onVote={onVote} />
              </div>
            ))}
          </div>

          {/* Pagination */}
          {pagination && pagination.pages > 1 && (
            <ReviewPagination
              currentPage={pagination.page}
              totalPages={pagination.pages}
              onPageChange={onPageChange}
            />
          )}
        </>
      ) : (
        <EmptyReviewsState />
      )}
    </div>
  );
}

/**
 * Props for ReviewPagination component.
 */
interface ReviewPaginationProps {
  /** Current active page number */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Callback when page is changed */
  onPageChange?: (page: number) => void;
}

/**
 * ReviewPagination displays numbered pagination buttons.
 *
 * @param props - Component properties
 * @returns Pagination controls
 */
function ReviewPagination({ currentPage, totalPages, onPageChange }: ReviewPaginationProps) {
  // Show at most 10 page buttons
  const maxVisiblePages = Math.min(totalPages, 10);

  return (
    <div className="flex justify-center mt-6 gap-2">
      {[...Array(maxVisiblePages)].map((_, i) => {
        const pageNumber = i + 1;
        const isActive = currentPage === pageNumber;

        return (
          <button
            key={pageNumber}
            onClick={() => onPageChange?.(pageNumber)}
            className={`px-4 py-2 rounded ${
              isActive ? 'bg-yelp-red text-white' : 'bg-white border hover:bg-gray-50'
            }`}
            aria-label={`Go to page ${pageNumber}`}
            aria-current={isActive ? 'page' : undefined}
          >
            {pageNumber}
          </button>
        );
      })}
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
    <div className="bg-white rounded-lg shadow p-8 text-center">
      <p className="text-gray-600">No reviews yet. Be the first to review!</p>
    </div>
  );
}
