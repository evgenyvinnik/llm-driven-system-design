import { Link } from '@tanstack/react-router';
import type { Hotel } from '@/types';

/** Default hotel image URL when no images are available. */
const DEFAULT_HOTEL_IMAGE = 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=200';

/**
 * Props for the DashboardHotelCard component.
 */
interface DashboardHotelCardProps {
  /** The hotel to display */
  hotel: Hotel;
}

/**
 * Card component displaying hotel information on the admin dashboard.
 * Shows a compact summary with image, name, location, ratings,
 * and a link to the hotel management page.
 *
 * @param props - Component props
 * @returns A card with hotel summary and management link
 *
 * @example
 * ```tsx
 * <DashboardHotelCard hotel={currentHotel} />
 * ```
 */
export function DashboardHotelCard({ hotel }: DashboardHotelCardProps) {
  const imageUrl = hotel.images?.[0] || DEFAULT_HOTEL_IMAGE;

  return (
    <div className="card p-6">
      <div className="flex justify-between items-start">
        <div className="flex gap-4">
          <HotelImage src={imageUrl} alt={hotel.name} />
          <HotelDetails hotel={hotel} />
        </div>
        <Link
          to={`/admin/hotels/${hotel.id}`}
          className="btn-secondary text-sm"
        >
          Manage Hotel
        </Link>
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
      className="w-24 h-24 object-cover rounded-lg"
    />
  );
}

/**
 * Displays hotel name, location, and ratings.
 */
function HotelDetails({ hotel }: { hotel: Hotel }) {
  return (
    <div>
      <h2 className="text-xl font-bold text-gray-900">{hotel.name}</h2>
      <p className="text-gray-500">
        {hotel.address}, {hotel.city}
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
