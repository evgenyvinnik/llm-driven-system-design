import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { orderAPI } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { OrderCard } from '../components/OrderCard';
import type { Order, WSMessage } from '../types';

/**
 * Orders list page route configuration.
 * Shows customer's order history.
 */
export const Route = createFileRoute('/orders')({
  component: OrdersPage,
});

/**
 * Orders list page component showing customer's order history.
 * Displays all orders with real-time status updates via WebSocket.
 *
 * Features:
 * - List of order cards with summary information
 * - Real-time status updates via WebSocket
 * - Loading state with spinner
 * - Empty state with link to browse restaurants
 * - Login prompt for unauthenticated users
 * - Clickable order cards linking to order detail
 *
 * @returns React component for the orders list page
 */
function OrdersPage() {
  const user = useAuthStore((s) => s.user);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadOrders = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const { orders } = await orderAPI.getMyOrders();
      setOrders(orders);
    } catch (err) {
      console.error('Failed to load orders:', err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // Subscribe to real-time updates
  const handleMessage = useCallback((message: WSMessage) => {
    if (message.type === 'order_status_update') {
      const updatedOrder = message.order as Order;
      setOrders((prev) =>
        prev.map((o) => (o.id === updatedOrder.id ? { ...o, ...updatedOrder } : o))
      );
    }
  }, []);

  useWebSocket(user ? [`customer:${user.id}:orders`] : [], handleMessage);

  if (!user) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Please log in</h1>
        <Link to="/login" className="text-doordash-red hover:underline">
          Log in to view your orders
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Your Orders</h1>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-doordash-red border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : orders.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-4">No orders yet</p>
          <Link
            to="/"
            className="text-doordash-red hover:underline"
          >
            Browse restaurants
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <Link
              key={order.id}
              to="/orders/$orderId"
              params={{ orderId: order.id.toString() }}
              className="block"
            >
              <OrderCard order={order} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
