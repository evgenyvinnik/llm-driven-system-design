import { Link } from '@tanstack/react-router';
import type { Hotel } from '@/types';
import { formatCurrency, generateStars, getAmenityLabel } from '@/utils';

interface HotelCardProps {
  hotel: Hotel;
  checkIn?: string;
  checkOut?: string;
}

export function HotelCard({ hotel, checkIn, checkOut }: HotelCardProps) {
  const searchParams = new URLSearchParams();
  if (checkIn) searchParams.set('checkIn', checkIn);
  if (checkOut) searchParams.set('checkOut', checkOut);
  const queryString = searchParams.toString();

  return (
    <Link
      to={`/hotels/${hotel.id}${queryString ? `?${queryString}` : ''}`}
      className="card group hover:shadow-lg transition-shadow duration-300"
    >
      <div className="relative h-48 overflow-hidden">
        <img
          src={hotel.images?.[0] || 'https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800'}
          alt={hotel.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        <div className="absolute top-3 right-3 bg-white rounded-lg px-2 py-1 shadow-md">
          <span className="text-yellow-500 font-medium">{generateStars(hotel.starRating)}</span>
        </div>
      </div>
      <div className="p-4">
        <div className="flex justify-between items-start mb-2">
          <h3 className="text-lg font-semibold text-gray-900 group-hover:text-primary-600 transition-colors">
            {hotel.name}
          </h3>
          {hotel.avgRating > 0 && (
            <div className="flex items-center space-x-1 bg-primary-50 text-primary-700 px-2 py-1 rounded">
              <span className="font-bold">{hotel.avgRating.toFixed(1)}</span>
              <span className="text-xs text-primary-600">({hotel.reviewCount})</span>
            </div>
          )}
        </div>
        <p className="text-gray-500 text-sm mb-3">
          {hotel.city}, {hotel.country}
        </p>
        <div className="flex flex-wrap gap-1 mb-3">
          {hotel.amenities?.slice(0, 4).map((amenity) => (
            <span
              key={amenity}
              className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded"
            >
              {getAmenityLabel(amenity)}
            </span>
          ))}
          {hotel.amenities && hotel.amenities.length > 4 && (
            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
              +{hotel.amenities.length - 4} more
            </span>
          )}
        </div>
        <div className="flex justify-between items-end">
          <div>
            {hotel.startingPrice !== undefined ? (
              <>
                <span className="text-2xl font-bold text-gray-900">
                  {formatCurrency(hotel.startingPrice)}
                </span>
                <span className="text-gray-500 text-sm"> / night</span>
              </>
            ) : hotel.roomTypes?.[0] ? (
              <>
                <span className="text-sm text-gray-500">from </span>
                <span className="text-2xl font-bold text-gray-900">
                  {formatCurrency(hotel.roomTypes[0].basePrice)}
                </span>
                <span className="text-gray-500 text-sm"> / night</span>
              </>
            ) : null}
          </div>
          {hotel.availableRoomTypes && (
            <span className="text-sm text-green-600 font-medium">
              {hotel.availableRoomTypes.length} room types available
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
