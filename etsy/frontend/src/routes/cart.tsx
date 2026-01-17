import { createFileRoute, Link } from '@tanstack/react-router';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/cart')({
  component: CartPage,
});

function CartPage() {
  const { cart, isLoading, updateQuantity, removeItem } = useCartStore();
  const { isAuthenticated } = useAuthStore();

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Please sign in to view your cart</h1>
        <Link to="/login" className="btn btn-primary">
          Sign In
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!cart || cart.shops.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Your cart is empty</h1>
        <p className="text-gray-600 mb-6">Start shopping to add items to your cart</p>
        <Link to="/" className="btn btn-primary">
          Start Shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-display font-bold text-gray-900 mb-8">
        Shopping Cart ({cart.summary.itemCount} {cart.summary.itemCount === 1 ? 'item' : 'items'})
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="lg:col-span-2 space-y-6">
          {cart.shops.map((shop) => (
            <div key={shop.shopId} className="card p-6">
              <Link
                to={`/shop/${shop.shopSlug}`}
                className="font-semibold text-gray-900 hover:text-primary-600 mb-4 block"
              >
                {shop.shopName}
              </Link>

              <div className="space-y-4">
                {shop.items.map((item) => (
                  <div key={item.id} className="flex gap-4 py-4 border-b border-gray-100 last:border-0">
                    <Link to={`/product/${item.productId}`}>
                      <img
                        src={item.images?.[0] || 'https://via.placeholder.com/100x100?text=No+Image'}
                        alt={item.title}
                        className="w-24 h-24 object-cover rounded-md"
                      />
                    </Link>

                    <div className="flex-1">
                      <Link
                        to={`/product/${item.productId}`}
                        className="font-medium text-gray-900 hover:text-primary-600"
                      >
                        {item.title}
                      </Link>

                      <div className="mt-2 flex items-center gap-4">
                        <select
                          value={item.quantity}
                          onChange={(e) => updateQuantity(item.id, parseInt(e.target.value))}
                          className="input w-20"
                        >
                          {Array.from({ length: Math.min(item.available, 10) }, (_, i) => (
                            <option key={i + 1} value={i + 1}>
                              {i + 1}
                            </option>
                          ))}
                        </select>

                        <button
                          onClick={() => removeItem(item.id)}
                          className="text-sm text-red-600 hover:text-red-700"
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="text-right">
                      <p className="font-semibold text-gray-900">
                        ${item.itemTotal.toFixed(2)}
                      </p>
                      <p className="text-sm text-gray-500">
                        ${item.price.toFixed(2)} each
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100 flex justify-between text-sm">
                <span className="text-gray-600">Subtotal</span>
                <span className="font-medium">${shop.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Shipping</span>
                <span className="font-medium">
                  {shop.shippingTotal === 0 ? 'Free' : `$${shop.shippingTotal.toFixed(2)}`}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-1">
          <div className="card p-6 sticky top-4">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Order Summary</h2>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Items ({cart.summary.itemCount})</span>
                <span>${cart.summary.itemTotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Shipping</span>
                <span>
                  {cart.summary.shippingTotal === 0
                    ? 'Free'
                    : `$${cart.summary.shippingTotal.toFixed(2)}`}
                </span>
              </div>
            </div>

            <div className="border-t border-gray-200 mt-4 pt-4">
              <div className="flex justify-between text-lg font-semibold">
                <span>Total</span>
                <span>${cart.summary.grandTotal.toFixed(2)}</span>
              </div>
            </div>

            <Link to="/checkout" className="btn btn-primary w-full mt-6 py-3">
              Proceed to Checkout
            </Link>

            <p className="text-xs text-gray-500 text-center mt-4">
              Items from {cart.shops.length} {cart.shops.length === 1 ? 'shop' : 'shops'} will be
              shipped separately
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
