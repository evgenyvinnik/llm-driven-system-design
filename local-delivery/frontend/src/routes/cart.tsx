import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCartStore } from '@/stores/cartStore';
import { useLocationStore } from '@/stores/locationStore';
import { useAuthStore } from '@/stores/authStore';
import { api, ApiError } from '@/services/api';
import { formatPrice, toNumber } from '@/utils/format';
import { newIdempotencyKey } from '@/utils/idempotency';
import type { OrderQuote } from '@/types';

export const Route = createFileRoute('/cart')({
  component: CartPage,
});

function CartPage() {
  const {
    items,
    merchant,
    updateQuantity,
    removeItem,
    clearCart,
    getSubtotal,
  } = useCartStore();
  const { location, getCurrentLocation } = useLocationStore();
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [tip, setTip] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');

  // One idempotency key per checkout attempt. A retry after a timeout or a
  // double click reuses it, so the server returns the first order instead of
  // creating a second one. Any change to the order starts a new attempt.
  const attemptKey = useRef<string | null>(null);
  useEffect(() => {
    attemptKey.current = null;
  }, [items, tip, deliveryAddress, deliveryInstructions, merchant?.id]);

  const quoteItems = useMemo(
    () => items.map((item) => ({ menu_item_id: item.menuItem.id, quantity: item.quantity })),
    [items]
  );

  // The server prices the cart (delivery fee depends on distance), so the
  // total on the button is the total that will be charged. Debounced, and a
  // newer cart aborts the older request so a slow response cannot win.
  useEffect(() => {
    if (!merchant || quoteItems.length === 0 || !location) {
      setQuote(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .quoteOrder(
          {
            merchant_id: merchant.id,
            delivery_lat: location.lat,
            delivery_lng: location.lng,
            items: quoteItems,
            tip: tip > 0 ? tip : undefined,
          },
          controller.signal
        )
        .then((result) => {
          setQuote(result);
          setQuoteError('');
        })
        .catch((err: unknown) => {
          if ((err as Error).name === 'AbortError') return;
          setQuote(null);
          setQuoteError((err as Error).message || 'Could not price this order');
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [merchant, quoteItems, location, tip]);

  useEffect(() => {
    if (!location) {
      void getCurrentLocation();
    }
  }, [location, getCurrentLocation]);

  const subtotal = quote ? toNumber(quote.subtotal) : getSubtotal();
  const deliveryFee = quote ? toNumber(quote.delivery_fee) : null;
  const total = quote ? toNumber(quote.total) : null;

  const handleQuantityChange = (itemId: string, delta: number) => {
    const item = items.find((i) => i.menuItem.id === itemId);
    if (item) {
      updateQuantity(itemId, item.quantity + delta);
    }
  };

  const handlePlaceOrder = async () => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    if (!deliveryAddress.trim()) {
      setError('Please enter a delivery address');
      return;
    }

    if (!merchant) {
      setError('No merchant selected');
      return;
    }

    setIsSubmitting(true);
    setError('');
    attemptKey.current ??= newIdempotencyKey();

    try {
      // Get current location or use default
      let loc = location;
      if (!loc) {
        loc = await getCurrentLocation();
      }

      const orderData = {
        merchant_id: merchant.id,
        delivery_address: deliveryAddress,
        delivery_lat: loc.lat,
        delivery_lng: loc.lng,
        delivery_instructions: deliveryInstructions || undefined,
        items: items.map((item) => ({
          menu_item_id: item.menuItem.id,
          quantity: item.quantity,
          special_instructions: item.specialInstructions,
        })),
        tip: tip > 0 ? tip : undefined,
      };

      const order = await api.createOrder(orderData, attemptKey.current);
      attemptKey.current = null;
      clearCart();
      navigate({ to: '/orders/$orderId', params: { orderId: (order as { id: string }).id } });
    } catch (err) {
      if (err instanceof ApiError) {
        // The server answered: this attempt is settled; editing the cart starts a new one.
        setError(err.message);
      } else {
        // No answer (network): the order may exist. Retrying reuses the same key, so it is safe.
        setError('Network problem: we could not confirm your order. Retry is safe and will not order twice.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (items.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-12 text-center">
        <div className="text-6xl mb-4">🛒</div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Your cart is empty</h1>
        <p className="text-gray-500 mb-6">Add some delicious items to get started</p>
        <button
          onClick={() => navigate({ to: '/' })}
          className="btn-primary"
        >
          Browse Restaurants
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Your Cart</h1>

      {merchant && (
        <div className="card p-4 mb-6">
          <h2 className="font-semibold text-gray-900">{merchant.name}</h2>
          <p className="text-sm text-gray-500">{merchant.address}</p>
        </div>
      )}

      {/* Cart Items */}
      <div className="card divide-y divide-gray-100 mb-6">
        {items.map((item) => (
          <div key={item.menuItem.id} className="p-4">
            <div className="flex justify-between items-start">
              <div className="flex-1">
                <h3 className="font-medium text-gray-900">{item.menuItem.name}</h3>
                <p className="text-sm text-gray-500">
                  ${formatPrice(item.menuItem.price)} each
                </p>
              </div>

              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleQuantityChange(item.menuItem.id, -1)}
                    className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 flex items-center justify-center"
                  >
                    -
                  </button>
                  <span className="w-8 text-center font-medium">{item.quantity}</span>
                  <button
                    onClick={() => handleQuantityChange(item.menuItem.id, 1)}
                    className="w-8 h-8 rounded-full bg-primary-600 hover:bg-primary-700 text-white flex items-center justify-center"
                  >
                    +
                  </button>
                </div>

                <span className="font-semibold text-gray-900 w-20 text-right">
                  ${formatPrice(toNumber(item.menuItem.price) * item.quantity)}
                </span>

                <button
                  onClick={() => removeItem(item.menuItem.id)}
                  className="text-red-600 hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Delivery Details */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Delivery Details</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Delivery Address *
            </label>
            <input
              type="text"
              value={deliveryAddress}
              onChange={(e) => setDeliveryAddress(e.target.value)}
              placeholder="Enter your address"
              className="input"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Delivery Instructions (optional)
            </label>
            <textarea
              value={deliveryInstructions}
              onChange={(e) => setDeliveryInstructions(e.target.value)}
              placeholder="E.g., Leave at door, ring bell, etc."
              rows={2}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* Tip */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Add a Tip</h2>
        <div className="flex gap-3">
          {[0, 2, 3, 5, 10].map((amount) => (
            <button
              key={amount}
              onClick={() => setTip(amount)}
              className={`px-4 py-2 rounded-lg ${
                tip === amount
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {amount === 0 ? 'None' : `$${amount}`}
            </button>
          ))}
        </div>
      </div>

      {/* Order Summary */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Order Summary</h2>

        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Subtotal</span>
            <span>${formatPrice(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Delivery Fee</span>
            <span>{deliveryFee === null ? 'Calculating...' : `$${formatPrice(deliveryFee)}`}</span>
          </div>
          {tip > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-600">Tip</span>
              <span>${formatPrice(tip)}</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-semibold pt-2 border-t">
            <span>Total</span>
            <span>{total === null ? '...' : `$${formatPrice(total)}`}</span>
          </div>
        </div>
        {quoteError && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {quoteError}
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg" role="alert">
          {error}
        </div>
      )}

      <button
        onClick={handlePlaceOrder}
        disabled={isSubmitting}
        className="btn-primary w-full btn-lg"
      >
        {isSubmitting
          ? 'Placing Order...'
          : total === null
            ? 'Place Order'
            : `Place Order - $${formatPrice(total)}`}
      </button>
    </div>
  );
}
