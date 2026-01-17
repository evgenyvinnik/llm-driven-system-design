import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';
import { orderAPI } from '../services/api';

/**
 * Tax rate applied to orders (8.75% for San Francisco).
 */
const TAX_RATE = 0.0875;

/**
 * Cart page route configuration.
 * Provides checkout functionality.
 */
export const Route = createFileRoute('/cart')({
  component: CartPage,
});

/**
 * Cart page component for reviewing and placing orders.
 * Displays cart items, delivery address input, tip selection,
 * and order summary with totals.
 *
 * Features:
 * - List of cart items with quantity controls
 * - Delivery address input
 * - Delivery instructions textarea
 * - Tip amount selection
 * - Order summary with subtotal, fees, tax, and total
 * - Place order button with loading state
 * - Empty cart state with link to browse restaurants
 * - Login prompt for unauthenticated users
 *
 * @returns React component for the cart/checkout page
 */
function CartPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const {
    restaurant,
    items,
    deliveryAddress,
    tip,
    setDeliveryAddress,
    setTip,
    updateQuantity,
    removeItem,
    clearCart,
    subtotal,
  } = useCartStore();

  const [address, setAddress] = useState(deliveryAddress?.address || '');
  const [instructions, setInstructions] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotalValue = subtotal();
  const deliveryFee = restaurant?.delivery_fee || 0;
  const tax = subtotalValue * TAX_RATE;
  const total = subtotalValue + deliveryFee + tax + tip;

  const handlePlaceOrder = async () => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    if (!restaurant || items.length === 0) {
      setError('Your cart is empty');
      return;
    }

    if (!address) {
      setError('Please enter a delivery address');
      return;
    }

    // For demo, use fixed coordinates in SF
    const deliveryAddr = {
      address,
      lat: 37.7849 + (Math.random() - 0.5) * 0.02,
      lon: -122.4094 + (Math.random() - 0.5) * 0.02,
    };
    setDeliveryAddress(deliveryAddr);

    setIsSubmitting(true);
    setError(null);

    try {
      const { order } = await orderAPI.create({
        restaurantId: restaurant.id,
        items: items.map((item) => ({
          menuItemId: item.menuItem.id,
          quantity: item.quantity,
          specialInstructions: item.specialInstructions,
        })),
        deliveryAddress: deliveryAddr,
        deliveryInstructions: instructions,
        tip,
      });

      clearCart();
      navigate({ to: '/orders/$orderId', params: { orderId: order.id.toString() } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!restaurant || items.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Your cart is empty</h1>
        <p className="text-gray-500 mb-6">Add items from a restaurant to get started</p>
        <Link to="/" className="text-doordash-red hover:underline">
          Browse restaurants
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Your Cart</h1>

      <div className="grid md:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="md:col-span-2 space-y-6">
          {/* Restaurant Info */}
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="font-semibold text-gray-900">{restaurant.name}</h2>
            <p className="text-sm text-gray-500">{restaurant.address}</p>
          </div>

          {/* Items */}
          <div className="bg-white rounded-lg shadow-sm divide-y">
            {items.map((item) => (
              <div key={item.menuItem.id} className="p-4 flex items-center justify-between">
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900">{item.menuItem.name}</h3>
                  <p className="text-sm text-gray-500">
                    ${Number(item.menuItem.price).toFixed(2)} each
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateQuantity(item.menuItem.id, item.quantity - 1)}
                      className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
                    >
                      -
                    </button>
                    <span className="font-medium w-6 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateQuantity(item.menuItem.id, item.quantity + 1)}
                      className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-50"
                    >
                      +
                    </button>
                  </div>
                  <button
                    onClick={() => removeItem(item.menuItem.id)}
                    className="text-red-500 hover:text-red-600"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Delivery Address */}
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-3">Delivery Address</h2>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter your address"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Delivery instructions (optional)"
              rows={2}
              className="w-full mt-3 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
          </div>

          {/* Tip */}
          <div className="bg-white rounded-lg p-4 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-3">Add a tip</h2>
            <div className="flex gap-2">
              {[0, 2, 3, 5, 10].map((amount) => (
                <button
                  key={amount}
                  onClick={() => setTip(amount)}
                  className={`px-4 py-2 rounded-full font-medium transition ${
                    tip === amount
                      ? 'bg-doordash-red text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {amount === 0 ? 'No tip' : `$${amount}`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Order Summary */}
        <div className="md:col-span-1">
          <div className="bg-white rounded-lg p-4 shadow-sm sticky top-24">
            <h2 className="font-semibold text-gray-900 mb-4">Order Summary</h2>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Subtotal</span>
                <span>${subtotalValue.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Delivery Fee</span>
                <span>${deliveryFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Tax</span>
                <span>${tax.toFixed(2)}</span>
              </div>
              {tip > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Tip</span>
                  <span>${tip.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold text-base pt-2 border-t">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>

            {error && (
              <div className="mt-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              onClick={handlePlaceOrder}
              disabled={isSubmitting || !address}
              className="w-full mt-4 bg-doordash-red text-white py-3 rounded-lg font-medium hover:bg-doordash-darkRed transition disabled:opacity-50"
            >
              {isSubmitting ? 'Placing Order...' : 'Place Order'}
            </button>

            {!user && (
              <p className="text-sm text-gray-500 mt-2 text-center">
                <Link to="/login" className="text-doordash-red hover:underline">
                  Log in
                </Link>{' '}
                to place your order
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
