import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/cart')({
  component: CartPage,
});

function CartPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { items, subtotal, itemCount, isLoading, fetchCart, updateQuantity, removeItem, clearCart } = useCartStore();

  useEffect(() => {
    if (user) {
      fetchCart();
    }
  }, [user, fetchCart]);

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Your Shopping Cart</h1>
        <p className="text-gray-500 mb-6">Please sign in to view your cart</p>
        <Link
          to="/login"
          className="inline-block px-8 py-3 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full"
        >
          Sign In
        </Link>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Your Shopping Cart is Empty</h1>
        <p className="text-gray-500 mb-6">Add items to get started</p>
        <Link
          to="/"
          className="inline-block px-8 py-3 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full"
        >
          Continue Shopping
        </Link>
      </div>
    );
  }

  const handleQuantityChange = async (productId: number, newQuantity: number) => {
    try {
      await updateQuantity(productId, newQuantity);
    } catch {
      // Error is handled in store
    }
  };

  const handleRemove = async (productId: number) => {
    try {
      await removeItem(productId);
    } catch {
      // Error is handled in store
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Shopping Cart</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b flex justify-between items-center">
              <span className="text-gray-500">{itemCount} items in cart</span>
              <button
                onClick={() => clearCart()}
                className="text-sm text-red-600 hover:underline"
              >
                Clear cart
              </button>
            </div>

            {items.map((item) => (
              <div key={item.id} className="p-4 border-b flex gap-4">
                <Link
                  to="/product/$id"
                  params={{ id: item.product_id.toString() }}
                  className="w-24 h-24 bg-gray-100 rounded flex-shrink-0 overflow-hidden"
                >
                  {item.images[0] ? (
                    <img src={item.images[0]} alt={item.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      No Image
                    </div>
                  )}
                </Link>

                <div className="flex-1">
                  <Link
                    to="/product/$id"
                    params={{ id: item.product_id.toString() }}
                    className="font-medium text-gray-900 hover:text-blue-600"
                  >
                    {item.title}
                  </Link>

                  <div className="mt-1">
                    {item.stock_quantity > 0 ? (
                      <span className="text-sm text-green-600">In Stock</span>
                    ) : (
                      <span className="text-sm text-red-600">Out of Stock</span>
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-4">
                    <select
                      value={item.quantity}
                      onChange={(e) => handleQuantityChange(item.product_id, Number(e.target.value))}
                      disabled={isLoading}
                      className="border rounded px-2 py-1 text-sm"
                    >
                      {Array.from({ length: Math.min(10, item.stock_quantity || 10) }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>Qty: {n}</option>
                      ))}
                    </select>

                    <button
                      onClick={() => handleRemove(item.product_id)}
                      disabled={isLoading}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <div className="text-right">
                  <div className="font-bold text-lg">${item.price}</div>
                  {item.quantity > 1 && (
                    <div className="text-sm text-gray-500">
                      ${(parseFloat(item.price) * item.quantity).toFixed(2)} total
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Order Summary */}
        <div>
          <div className="bg-white rounded-lg shadow p-6 sticky top-4">
            <h2 className="text-lg font-bold mb-4">Order Summary</h2>

            <div className="space-y-2 text-sm mb-4">
              <div className="flex justify-between">
                <span>Subtotal ({itemCount} items)</span>
                <span>${subtotal}</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated Shipping</span>
                <span>{parseFloat(subtotal) >= 50 ? 'FREE' : '$5.99'}</span>
              </div>
              <div className="flex justify-between">
                <span>Estimated Tax</span>
                <span>${(parseFloat(subtotal) * 0.08).toFixed(2)}</span>
              </div>
            </div>

            <div className="border-t pt-4 mb-4">
              <div className="flex justify-between font-bold text-lg">
                <span>Order Total</span>
                <span>
                  ${(
                    parseFloat(subtotal) +
                    (parseFloat(subtotal) >= 50 ? 0 : 5.99) +
                    parseFloat(subtotal) * 0.08
                  ).toFixed(2)}
                </span>
              </div>
            </div>

            <button
              onClick={() => navigate({ to: '/checkout' })}
              className="w-full py-3 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full"
            >
              Proceed to Checkout
            </button>

            <p className="text-xs text-gray-500 text-center mt-4">
              Free shipping on orders over $50
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
