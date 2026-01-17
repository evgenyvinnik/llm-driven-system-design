/**
 * Orders page route (/orders).
 * Displays user's order history with status, fill information, and cancellation options.
 * Requires authentication.
 */

import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { usePortfolioStore } from '../stores/portfolioStore';

/** Route definition with auth guard */
export const Route = createFileRoute('/orders')({
  beforeLoad: () => {
    const { isAuthenticated } = useAuthStore.getState();
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: OrdersPage,
});

/**
 * Orders page component.
 * Lists all user orders with real-time status updates (auto-refreshes every 5 seconds).
 * Provides cancel functionality for pending orders.
 */
function OrdersPage() {
  const { orders, fetchOrders, cancelOrder, isLoading } = usePortfolioStore();

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, 5000);
    return () => clearInterval(interval);
  }, [fetchOrders]);

  const handleCancel = async (orderId: string) => {
    if (window.confirm('Are you sure you want to cancel this order?')) {
      try {
        await cancelOrder(orderId);
      } catch (error) {
        alert((error as Error).message);
      }
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-6">Orders</h1>

      {isLoading && orders.length === 0 ? (
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-robinhood-gray-700 rounded-lg" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-robinhood-gray-800 rounded-lg p-6">
          <p className="text-robinhood-gray-400">No orders yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <div
              key={order.id}
              className="bg-robinhood-gray-800 rounded-lg p-6"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center ${
                      order.side === 'buy'
                        ? 'bg-robinhood-green bg-opacity-20'
                        : 'bg-robinhood-red bg-opacity-20'
                    }`}
                  >
                    <span
                      className={`font-bold ${
                        order.side === 'buy'
                          ? 'text-robinhood-green'
                          : 'text-robinhood-red'
                      }`}
                    >
                      {order.side === 'buy' ? 'B' : 'S'}
                    </span>
                  </div>
                  <div>
                    <p className="text-white font-semibold text-lg">
                      {order.symbol}
                    </p>
                    <p className="text-robinhood-gray-400 text-sm">
                      {order.order_type.toUpperCase()} {order.side.toUpperCase()} -{' '}
                      {order.quantity} shares
                    </p>
                  </div>
                </div>

                <div className="flex flex-col md:flex-row md:items-center mt-4 md:mt-0 space-y-2 md:space-y-0 md:space-x-6">
                  <div className="text-left md:text-right">
                    <p className="text-robinhood-gray-400 text-sm">Price</p>
                    <p className="text-white">
                      {order.avg_fill_price
                        ? `$${order.avg_fill_price.toFixed(2)}`
                        : order.limit_price
                        ? `Limit: $${order.limit_price.toFixed(2)}`
                        : 'Market'}
                    </p>
                  </div>

                  <div className="text-left md:text-right">
                    <p className="text-robinhood-gray-400 text-sm">Filled</p>
                    <p className="text-white">
                      {order.filled_quantity} / {order.quantity}
                    </p>
                  </div>

                  <div className="text-left md:text-right">
                    <p className="text-robinhood-gray-400 text-sm">Status</p>
                    <p
                      className={`font-medium ${getStatusColor(order.status)}`}
                    >
                      {order.status.toUpperCase()}
                    </p>
                  </div>

                  <div className="text-left md:text-right">
                    <p className="text-robinhood-gray-400 text-sm">Date</p>
                    <p className="text-white">
                      {new Date(order.created_at).toLocaleString()}
                    </p>
                  </div>

                  {['pending', 'submitted', 'partial'].includes(order.status) && (
                    <button
                      onClick={() => handleCancel(order.id)}
                      className="bg-robinhood-red bg-opacity-20 text-robinhood-red px-4 py-2 rounded-lg hover:bg-opacity-30 transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Returns the appropriate color class for an order status.
 * @param status - Order status string
 * @returns Tailwind color class for the status text
 */
function getStatusColor(status: string): string {
  switch (status) {
    case 'filled':
      return 'text-robinhood-green';
    case 'cancelled':
    case 'rejected':
    case 'expired':
      return 'text-robinhood-red';
    case 'partial':
      return 'text-yellow-500';
    default:
      return 'text-robinhood-gray-400';
  }
}
