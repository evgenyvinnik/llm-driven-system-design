import { Link } from '@tanstack/react-router';
import { CheckCircle } from 'lucide-react';
import { StarRating } from '../StarRating';
import type { Business, Category } from '../../types';

/**
 * Props for the BusinessHeader component.
 */
interface BusinessHeaderProps {
  /** The business to display information for */
  business: Business;
}

/**
 * BusinessHeader displays the main business information including name,
 * rating, review count, price level, verification status, and categories.
 *
 * @param props - Component properties
 * @returns The business header component
 */
export function BusinessHeader({ business }: BusinessHeaderProps) {
  const priceLevel = business.price_level ? '$'.repeat(business.price_level) : null;

  return (
    <div className="mb-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">{business.name}</h1>

      {/* Rating and metadata row */}
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <StarRating rating={business.rating} size="lg" showValue />
        <span className="text-gray-600">{business.review_count} reviews</span>

        {priceLevel && (
          <>
            <span className="text-gray-300">|</span>
            <span className="font-medium">{priceLevel}</span>
          </>
        )}

        {business.is_verified && (
          <span className="flex items-center gap-1 text-green-600">
            <CheckCircle className="w-4 h-4" />
            Verified
          </span>
        )}
      </div>

      {/* Categories */}
      {business.categories && Array.isArray(business.categories) && (
        <CategoryLinks categories={business.categories} />
      )}
    </div>
  );
}

/**
 * Props for the CategoryLinks component.
 */
interface CategoryLinksProps {
  /** Array of categories (can be strings or Category objects) */
  categories: (Category | string)[];
}

/**
 * CategoryLinks renders a list of clickable category links.
 *
 * @param props - Component properties
 * @returns Category links component
 */
function CategoryLinks({ categories }: CategoryLinksProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((cat) => {
        const slug = typeof cat === 'string' ? cat : cat.slug;
        const name = typeof cat === 'string' ? cat : cat.name;

        return (
          <Link
            key={slug}
            to="/search"
            search={{ category: slug }}
            className="text-sm text-yelp-blue hover:underline"
          >
            {name}
          </Link>
        );
      })}
    </div>
  );
}
