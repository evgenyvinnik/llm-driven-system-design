import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { orderAPI } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { OrderCard } from '../components/OrderCard';
import type { Order, WSMessage } from '../types';

/**
 * Order detail page route configuration.
 * Uses dynamic route parameter for order ID.
 */
export const Route = createFileRoute('/orders/$orderId')({
  component: OrderDetailPage,
});

/**
 * Order detail page component showing full order information.
 * Displays order details, progress tracker, and driver location.
 *
 * Features:
 * - Full order details with items and pricing
 * - Visual order progress tracker
 * - Real-time status updates via WebSocket
 * - Real-time driver location updates
 * - Cancel order button (for PLACED orders)
 * - Driver information display
 * - ETA breakdown display
 *
 * @returns React component for the order detail page
 */
function OrderDetailPage() {
  const { orderId } = Route.useParams();
  const user = useAuthStore((s) => s.user);
  const [order, setOrder] = useState<Order | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { order } = await orderAPI.getById(parseInt(orderId));
      setOrder(order);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // Subscribe to real-time updates
  const handleMessage = useCallback((message: WSMessage) => {
    if (message.type === 'order_status_update' && (message.order as Order).id === parseInt(orderId)) {
      setOrder(message.order as Order);
    }
    if (message.type === 'driver_location' && order?.driver?.id === (message as unknown as { driverId: number }).driverId) {
      // Update driver location in order
      const msg = message as unknown as { lat: number; lon: number };
      setOrder((prev) =>
        prev
          ? {
              ...prev,
              driver: prev.driver
                ? {
                    ...prev.driver,
                    current_lat: msg.lat,
                    current_lon: msg.lon,
                  }
                : prev.driver,
            }
          : prev
      );
    }
  }, [orderId, order?.driver?.id]);

  useWebSocket([`order:${orderId}`], handleMessage);

  const handleCancelOrder = async () => {
    if (!order || order.status !== 'PLACED') return;

    if (!confirm('Are you sure you want to cancel this order?')) return;

    try {
      const { order: updatedOrder } = await orderAPI.updateStatus(order.id, 'CANCELLED', 'Customer cancelled');
      setOrder(updatedOrder);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="w-8 h-8 border-4 border-doordash-red border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Order not found</h1>
        <p className="text-gray-500 mb-6">{error}</p>
        <Link to="/orders" className="text-doordash-red hover:underline">
          Back to orders
        </Link>
      </div>
    );
  }

  const isActive = !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(order.status);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <Link to="/orders" className="text-doordash-red hover:underline mb-4 inline-block">
        Back to Orders
      </Link>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Order Details */}
        <div>
          <OrderCard order={order} showDetails userRole="customer" />

          {order.status === 'PLACED' && user?.id === order.customer_id && (
            <button
              onClick={handleCancelOrder}
              className="mt-4 w-full border border-red-500 text-red-500 py-2 rounded-lg font-medium hover:bg-red-50 transition"
            >
              Cancel Order
            </button>
          )}
        </div>

        {/* Order Progress */}
        <div>
          <div className="bg-white rounded-lg p-6 shadow-sm">
            <h2 className="font-semibold text-gray-900 mb-4">Order Progress</h2>

            <div className="space-y-4">
              {[
                { status: 'PLACED', label: 'Order Placed', time: order.placed_at },
                { status: 'CONFIRMED', label: 'Restaurant Confirmed', time: order.confirmed_at },
                { status: 'PREPARING', label: 'Preparing Your Food', time: order.preparing_at },
                { status: 'READY_FOR_PICKUP', label: 'Ready for Pickup', time: order.ready_at },
                { status: 'PICKED_UP', label: 'Driver Picked Up', time: order.picked_up_at },
                { status: 'DELIVERED', label: 'Delivered', time: order.delivered_at },
              ].map((step, index, arr) => {
                const statusOrder = ['PLACED', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'];
                const currentIndex = statusOrder.indexOf(order.status);
                const stepIndex = statusOrder.indexOf(step.status);
                const isComplete = stepIndex <= currentIndex && order.status !== 'CANCELLED';
                const isCurrent = stepIndex === currentIndex;

                return (
                  <div key={step.status} className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          isComplete
                            ? 'bg-green-500 text-white'
                            : 'bg-gray-200 text-gray-500'
                        } ${isCurrent ? 'ring-2 ring-green-300' : ''}`}
                      >
                        {isComplete ? (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <span className="text-sm">{index + 1}</span>
                        )}
                      </div>
                      {index < arr.length - 1 && (
                        <div
                          className={`w-0.5 h-8 ${
                            isComplete && stepIndex < currentIndex ? 'bg-green-500' : 'bg-gray-200'
                          }`}
                        />
                      )}
                    </div>
                    <div className="flex-1 pb-4">
                      <p className={`font-medium ${isComplete ? 'text-gray-900' : 'text-gray-400'}`}>
                        {step.label}
                      </p>
                      {step.time && (
                        <p className="text-sm text-gray-500">
                          {new Date(step.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}

              {order.status === 'CANCELLED' && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-red-500 text-white flex items-center justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-medium text-red-600">Order Cancelled</p>
                    {order.cancel_reason && (
                      <p className="text-sm text-gray-500">{order.cancel_reason}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Driver Location (placeholder - would need map integration) */}
          {isActive && order.driver && (
            <div className="bg-white rounded-lg p-6 shadow-sm mt-6">
              <h2 className="font-semibold text-gray-900 mb-4">Driver Location</h2>
              <div className="bg-gray-100 rounded-lg h-48 flex items-center justify-center">
                <div className="text-center text-gray-500">
                  <p className="font-medium">{order.driver.name}</p>
                  {order.driver.current_lat && order.driver.current_lon && (
                    <p className="text-sm mt-1">
                      Location: {order.driver.current_lat.toFixed(4)}, {order.driver.current_lon.toFixed(4)}
                    </p>
                  )}
                  <p className="text-xs mt-2">(Map would display here)</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
