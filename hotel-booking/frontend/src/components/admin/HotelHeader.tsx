import { Link } from '@tanstack/react-router';
import type { Hotel } from '@/types';
import { getAmenityLabel } from '@/utils';

/** Default hotel image URL when no images are available. */
const DEFAULT_HOTEL_IMAGE = 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=300';

/**
 * Props for the HotelHeader component.
 */
interface HotelHeaderProps {
  /** The hotel to display in the header */
  hotel: Hotel;
}

/**
 * Displays the hotel header section on the manage hotel page.
 * Shows hotel image, name, location, star rating, reviews, description, and amenities.
 *
 * @param props - Component props
 * @returns A card containing hotel summary information
 *
 * @example
 * ```tsx
 * <HotelHeader hotel={hotel} />
 * ```
 */
export function HotelHeader({ hotel }: HotelHeaderProps) {
  const imageUrl = hotel.images?.[0] || DEFAULT_HOTEL_IMAGE;

  return (
    <div className="card p-6 mt-4 mb-8">
      <div className="flex flex-col md:flex-row gap-6">
        <HotelImage src={imageUrl} alt={hotel.name} />
        <div className="flex-1">
          <div className="flex justify-between items-start">
            <HotelInfo hotel={hotel} />
            <Link to={`/hotels/${hotel.id}`} className="btn-secondary text-sm">
              View Public Page
            </Link>
          </div>
          <p className="text-gray-600 mt-4">{hotel.description}</p>
          <AmenitiesList amenities={hotel.amenities} />
        </div>
      </div>
    </div>
  );
}

/**
 * Displays the hotel thumbnail image.
 */
function HotelImage({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      className="w-full md:w-48 h-48 object-cover rounded-lg"
    />
  );
}

/**
 * Displays hotel name, location, and ratings.
 */
function HotelInfo({ hotel }: { hotel: Hotel }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{hotel.name}</h1>
      <p className="text-gray-500">
        {hotel.address}, {hotel.city}, {hotel.country}
      </p>
      <div className="flex items-center gap-4 mt-2">
        <StarRating rating={hotel.starRating} />
        {hotel.avgRating > 0 && (
          <ReviewSummary avgRating={hotel.avgRating} reviewCount={hotel.reviewCount} />
        )}
      </div>
    </div>
  );
}

/**
 * Displays star rating as repeated star characters.
 */
function StarRating({ rating }: { rating: number }) {
  return <span className="text-yellow-500">{'*'.repeat(rating)}</span>;
}

/**
 * Displays average rating and review count.
 */
function ReviewSummary({ avgRating, reviewCount }: { avgRating: number; reviewCount: number }) {
  return (
    <span className="text-sm text-gray-500">
      {avgRating.toFixed(1)} ({reviewCount} reviews)
    </span>
  );
}

/**
 * Displays a list of amenity badges.
 */
function AmenitiesList({ amenities }: { amenities?: string[] }) {
  if (!amenities || amenities.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-4">
      {amenities.map((amenity) => (
        <span key={amenity} className="bg-gray-100 text-gray-600 px-2 py-1 rounded text-sm">
          {getAmenityLabel(amenity)}
        </span>
      ))}
    </div>
  );
}
