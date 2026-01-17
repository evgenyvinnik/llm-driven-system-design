import { Link } from '@tanstack/react-router';
import type { Restaurant } from '../types';

interface Props {
  restaurant: Restaurant;
}

export function RestaurantCard({ restaurant }: Props) {
  return (
    <Link
      to="/restaurant/$restaurantId"
      params={{ restaurantId: restaurant.id.toString() }}
      className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition group"
    >
      <div className="h-40 bg-gray-200 relative overflow-hidden">
        {restaurant.image_url ? (
          <img
            src={restaurant.image_url}
            alt={restaurant.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-doordash-red to-orange-400">
            <span className="text-4xl font-bold text-white">
              {restaurant.name.charAt(0)}
            </span>
          </div>
        )}
        {!restaurant.is_open && (
          <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
            <span className="text-white font-medium">Closed</span>
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-semibold text-lg text-gray-900 group-hover:text-doordash-red transition">
          {restaurant.name}
        </h3>
        <div className="flex items-center gap-2 mt-1">
          <span className="flex items-center gap-1 text-sm">
            <svg className="w-4 h-4 text-yellow-400 fill-current" viewBox="0 0 20 20">
              <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
            </svg>
            <span className="font-medium">{restaurant.rating.toFixed(1)}</span>
            <span className="text-gray-400">({restaurant.rating_count})</span>
          </span>
          {restaurant.cuisine_type && (
            <>
              <span className="text-gray-300">|</span>
              <span className="text-sm text-gray-500">{restaurant.cuisine_type}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2 text-sm text-gray-500">
          <span>{restaurant.prep_time_minutes}-{restaurant.prep_time_minutes + 10} min</span>
          <span className="text-gray-300">|</span>
          <span>${restaurant.delivery_fee.toFixed(2)} delivery</span>
        </div>
        {restaurant.distance !== undefined && (
          <p className="text-sm text-gray-400 mt-1">
            {restaurant.distance.toFixed(1)} km away
          </p>
        )}
      </div>
    </Link>
  );
}
