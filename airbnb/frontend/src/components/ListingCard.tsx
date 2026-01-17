import { Link } from '@tanstack/react-router';
import { Listing } from '../types';
import { formatCurrency, formatRating } from '../utils/helpers';

interface ListingCardProps {
  listing: Listing;
}

export function ListingCard({ listing }: ListingCardProps) {
  const imageUrl =
    listing.primary_photo ||
    (listing.photos && listing.photos.length > 0 ? listing.photos[0].url : null) ||
    `https://picsum.photos/seed/${listing.id}/400/300`;

  return (
    <Link to={`/listing/${listing.id}`} className="block group">
      <div className="relative aspect-[4/3] rounded-xl overflow-hidden mb-3">
        <img
          src={imageUrl}
          alt={listing.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        {listing.instant_book && (
          <div className="absolute top-3 left-3 bg-white px-2 py-1 rounded text-xs font-medium">
            Instant Book
          </div>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between items-start">
          <h3 className="font-medium text-gray-900 truncate pr-2">
            {listing.city}, {listing.state || listing.country}
          </h3>
          {listing.rating && (
            <div className="flex items-center gap-1 shrink-0">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
              <span className="text-sm">{formatRating(listing.rating)}</span>
              <span className="text-sm text-gray-500">
                ({listing.review_count})
              </span>
            </div>
          )}
        </div>

        <p className="text-gray-500 text-sm truncate">{listing.title}</p>

        <p className="text-gray-500 text-sm">
          {listing.bedrooms} {listing.bedrooms === 1 ? 'bedroom' : 'bedrooms'} ·{' '}
          {listing.beds} {listing.beds === 1 ? 'bed' : 'beds'}
        </p>

        <p className="text-gray-900">
          <span className="font-semibold">
            {formatCurrency(listing.price_per_night)}
          </span>{' '}
          <span className="text-gray-500">night</span>
        </p>
      </div>
    </Link>
  );
}
