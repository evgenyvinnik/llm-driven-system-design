import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { restaurantAPI } from '../services/api';
import { MenuItemCard } from '../components/MenuItemCard';
import { useCartStore } from '../stores/cartStore';
import type { Restaurant, MenuByCategory } from '../types';

/**
 * Restaurant detail page route configuration.
 * Uses dynamic route parameter for restaurant ID.
 */
export const Route = createFileRoute('/restaurant/$restaurantId')({
  component: RestaurantPage,
});

/**
 * Restaurant detail page component displaying menu and restaurant info.
 * Shows the full restaurant menu organized by category with add-to-cart
 * functionality.
 *
 * Features:
 * - Restaurant header with image, name, rating, and details
 * - Menu items organized by category
 * - Add to cart controls on each item
 * - Floating cart summary bar when items are in cart
 * - Loading and error states
 * - "Closed" overlay when restaurant is not accepting orders
 *
 * @returns React component for the restaurant detail page
 */
function RestaurantPage() {
  const { restaurantId } = Route.useParams();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [menu, setMenu] = useState<MenuByCategory>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setCartRestaurant = useCartStore((s) => s.setRestaurant);
  const cartRestaurant = useCartStore((s) => s.restaurant);
  const itemCount = useCartStore((s) => s.itemCount());
  const subtotal = useCartStore((s) => s.subtotal());

  useEffect(() => {
    loadRestaurant();
  }, [restaurantId]);

  const loadRestaurant = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await restaurantAPI.getById(parseInt(restaurantId));
      setRestaurant(data.restaurant);
      setMenu(data.menu);
      setCartRestaurant(data.restaurant);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="w-8 h-8 border-4 border-doordash-red border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (error || !restaurant) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Restaurant not found</h1>
        <p className="text-gray-500 mb-6">{error}</p>
        <Link to="/" className="text-doordash-red hover:underline">
          Back to restaurants
        </Link>
      </div>
    );
  }

  const categories = Object.keys(menu);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Restaurant Header */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden mb-8">
        <div className="h-48 bg-gradient-to-br from-doordash-red to-orange-400 relative">
          {restaurant.image_url && (
            <img
              src={restaurant.image_url}
              alt={restaurant.name}
              className="w-full h-full object-cover"
            />
          )}
          {!restaurant.is_open && (
            <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
              <span className="text-white text-xl font-medium">Currently Closed</span>
            </div>
          )}
        </div>
        <div className="p-6">
          <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
          {restaurant.description && (
            <p className="text-gray-600 mt-2">{restaurant.description}</p>
          )}
          <div className="flex items-center gap-4 mt-4">
            <span className="flex items-center gap-1">
              <svg className="w-5 h-5 text-yellow-400 fill-current" viewBox="0 0 20 20">
                <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
              </svg>
              <span className="font-medium">{restaurant.rating.toFixed(1)}</span>
              <span className="text-gray-400">({restaurant.rating_count} reviews)</span>
            </span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-600">{restaurant.cuisine_type}</span>
            <span className="text-gray-300">|</span>
            <span className="text-gray-600">
              {restaurant.prep_time_minutes}-{restaurant.prep_time_minutes + 10} min
            </span>
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
            <span>${restaurant.delivery_fee.toFixed(2)} delivery fee</span>
            <span className="text-gray-300">|</span>
            <span>${restaurant.min_order.toFixed(2)} minimum</span>
          </div>
        </div>
      </div>

      {/* Menu */}
      <div className="space-y-8">
        {categories.map((category) => (
          <div key={category}>
            <h2 className="text-xl font-bold text-gray-900 mb-4">{category}</h2>
            <div className="space-y-3">
              {menu[category].map((item) => (
                <MenuItemCard key={item.id} item={item} restaurantId={restaurant.id} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Cart Summary */}
      {itemCount > 0 && cartRestaurant?.id === restaurant.id && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg p-4">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <div>
              <span className="font-medium text-gray-900">
                {itemCount} item{itemCount !== 1 ? 's' : ''}
              </span>
              <span className="text-gray-500 ml-2">
                ${subtotal.toFixed(2)}
              </span>
            </div>
            <Link
              to="/cart"
              className="bg-doordash-red text-white px-6 py-3 rounded-lg font-medium hover:bg-doordash-darkRed transition"
            >
              View Cart
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
