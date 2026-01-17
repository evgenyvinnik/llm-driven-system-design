import { Link } from '@tanstack/react-router';
import { MapPin, DollarSign } from 'lucide-react';
import { StarRating } from './StarRating';
import type { Business } from '../types';

interface BusinessCardProps {
  business: Business;
  rank?: number;
}

export function BusinessCard({ business, rank }: BusinessCardProps) {
  const priceLevel = business.price_level
    ? Array(business.price_level).fill('$').join('')
    : null;

  const categories = business.category_names || business.categories || [];
  const categoryDisplay = Array.isArray(categories)
    ? categories.slice(0, 3).join(', ')
    : '';

  return (
    <Link
      to="/business/$slug"
      params={{ slug: business.slug }}
      className="card flex gap-4 p-4 hover:shadow-lg transition-shadow"
    >
      {/* Image */}
      <div className="flex-shrink-0">
        {rank && (
          <div className="text-lg font-bold text-gray-500 mb-2">{rank}.</div>
        )}
        <img
          src={business.photo_url || 'https://via.placeholder.com/120x120?text=No+Image'}
          alt={business.name}
          className="w-32 h-32 object-cover rounded-md"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <h3 className="text-lg font-semibold text-yelp-blue hover:underline">
          {business.name}
        </h3>

        <div className="flex items-center gap-2 mt-1">
          <StarRating rating={business.rating} />
          <span className="text-sm text-gray-600">
            {business.review_count} reviews
          </span>
        </div>

        <div className="flex items-center gap-2 mt-2 text-sm text-gray-600">
          {priceLevel && (
            <>
              <span className="font-medium">{priceLevel}</span>
              <span>-</span>
            </>
          )}
          {categoryDisplay && <span>{categoryDisplay}</span>}
        </div>

        <div className="flex items-center gap-1 mt-2 text-sm text-gray-600">
          <MapPin className="w-4 h-4" />
          <span>
            {business.city}, {business.state}
          </span>
          {business.distance_km !== undefined && (
            <span className="ml-2">
              ({business.distance_km.toFixed(1)} km away)
            </span>
          )}
          {business.distance !== undefined && business.distance_km === undefined && (
            <span className="ml-2">
              ({business.distance.toFixed(1)} km away)
            </span>
          )}
        </div>

        {business.description && (
          <p className="mt-2 text-sm text-gray-600 line-clamp-2">
            {business.description}
          </p>
        )}

        <div className="flex items-center gap-2 mt-2">
          {business.is_verified && (
            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">
              Verified
            </span>
          )}
          {business.is_claimed && (
            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
              Claimed
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

interface BusinessGridCardProps {
  business: Business;
}

export function BusinessGridCard({ business }: BusinessGridCardProps) {
  const priceLevel = business.price_level
    ? Array(business.price_level).fill('$').join('')
    : null;

  return (
    <Link
      to="/business/$slug"
      params={{ slug: business.slug }}
      className="card hover:shadow-lg transition-shadow"
    >
      <img
        src={business.photo_url || 'https://via.placeholder.com/300x200?text=No+Image'}
        alt={business.name}
        className="w-full h-40 object-cover"
      />
      <div className="p-4">
        <h3 className="font-semibold text-gray-900 truncate">{business.name}</h3>
        <div className="flex items-center gap-2 mt-1">
          <StarRating rating={business.rating} size="sm" />
          <span className="text-xs text-gray-600">{business.review_count}</span>
        </div>
        <div className="flex items-center gap-1 mt-2 text-xs text-gray-600">
          {priceLevel && <span>{priceLevel}</span>}
          {priceLevel && <span>-</span>}
          <span>
            {business.city}, {business.state}
          </span>
        </div>
      </div>
    </Link>
  );
}
