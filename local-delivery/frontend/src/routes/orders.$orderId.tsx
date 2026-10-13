import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/services/api';
import { formatPrice, formatNumber, toNumber } from '@/utils/format';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/authStore';
import { StatusBadge } from '@/components/StatusBadge';
import { PageLoading } from '@/components/LoadingSpinner';
import type { ConnectionState, OrderStatus, OrderWithDetails } from '@/types';

export const Route = createFileRoute('/orders/$orderId')({
  component: OrderDetailPage,
});

const TERMINAL_STATUSES: OrderStatus[] = ['delivered', 'cancelled'];

/** Human wording for screen-reader announcements of status changes. */
const STATUS_ANNOUNCEMENTS: Partial<Record<OrderStatus, string>> = {
  driver_assigned: 'A driver accepted your order',
  picked_up: 'Your order was picked up',
  in_transit: 'Your order is on the way',
  delivered: 'Your order was delivered',
  cancelled: 'Your order was cancelled',
};

/**
 * Keeps whichever copy of the order is newer. Events and snapshots can arrive
 * in any order around a reconnect; the server's version decides.
 */
function newerOrder(current: OrderWithDetails | null, incoming: OrderWithDetails): OrderWithDetails {
  if (!current || (incoming.version ?? 0) >= (current.version ?? 0)) return incoming;
  return current;
}

function OrderDetailPage() {
  const { orderId } = Route.useParams();
  const [order, setOrder] = useState<OrderWithDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const [announcement, setAnnouncement] = useState('');
  const [actionError, setActionError] = useState('');
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [driverRating, setDriverRating] = useState(5);
  const [merchantRating, setMerchantRating] = useState(5);

  const { token } = useAuthStore();

  // Latest version shown, readable from socket callbacks without re-subscribing.
  const versionRef = useRef(0);
  useEffect(() => {
    versionRef.current = order?.version ?? 0;
  }, [order?.version]);

  /** REST snapshot; applied only if it is at least as new as what is shown. */
  const refreshOrder = useCallback(async () => {
    try {
      const data = (await api.getOrder(orderId)) as OrderWithDetails;
      setOrder((prev) => newerOrder(prev, data));
    } catch (error) {
      console.error('Failed to load order:', error);
    }
  }, [orderId]);

  useEffect(() => {
    setIsLoading(true);
    setOrder(null);
    refreshOrder().finally(() => setIsLoading(false));
  }, [refreshOrder]);

  const isTerminal = order ? TERMINAL_STATUSES.includes(order.status) : false;
  const hasOrder = order !== null;

  // One socket per tracked order. Every (re)connect resubscribes and the server
  // answers with a fresh snapshot, so nothing missed while offline is lost.
  useEffect(() => {
    if (!token || !hasOrder || isTerminal) {
      return;
    }

    wsService.connect(token, {
      onConnected: () => wsService.subscribeToOrder(orderId),
      onConnectionChange: setConnection,
      onOrderSnapshot: ({ order: snapshot }) => setOrder((prev) => newerOrder(prev, snapshot)),
      onLocationUpdate: (payload) => {
        setDriverLocation({ lat: payload.lat, lng: payload.lng });
        setEta(payload.eta_seconds);
      },
      onStatusUpdate: (payload) => {
        if (payload.order_id !== orderId || payload.version < versionRef.current) return;
        setOrder((prev) =>
          !prev || payload.version < (prev.version ?? 0)
            ? prev
            : { ...prev, status: payload.status, driver_id: payload.driver_id, version: payload.version }
        );
        setAnnouncement(STATUS_ANNOUNCEMENTS[payload.status] ?? `Order status: ${payload.status}`);
        // The event says what changed; the REST snapshot fills in details
        // (courier name, timestamps) and is version-checked too.
        void refreshOrder();
      },
      onError: (message) => console.error('WebSocket error:', message),
    });

    return () => {
      wsService.unsubscribeFromOrder();
      wsService.disconnect();
    };
  }, [token, orderId, hasOrder, isTerminal, refreshOrder]);

  const handleCancelOrder = async () => {
    if (!confirm('Are you sure you want to cancel this order?')) return;

    setActionError('');
    try {
      const cancelled = (await api.cancelOrder(orderId, 'Customer cancelled')) as OrderWithDetails;
      setOrder((prev) => (prev ? newerOrder(prev, { ...prev, ...cancelled }) : prev));
    } catch (error) {
      // 409: a driver accepted a moment earlier. Show the truth, not a stale button.
      setActionError((error as Error).message || 'Failed to cancel order');
      void refreshOrder();
    }
  };

  const handleSubmitRatings = async () => {
    try {
      await Promise.all([
        api.rateDriver(orderId, driverRating),
        api.rateMerchant(orderId, merchantRating),
      ]);
      setRatingSubmitted(true);
    } catch (error) {
      console.error('Failed to submit ratings:', error);
    }
  };

  if (isLoading) {
    return <PageLoading />;
  }

  if (!order) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 text-lg">Order not found</p>
      </div>
    );
  }

  const canCancel = ['pending', 'confirmed'].includes(order.status);
  const isActive = !['delivered', 'cancelled'].includes(order.status);

  const formatEta = (seconds: number) => {
    const mins = Math.round(seconds / 60);
    return mins < 60 ? `${mins} min` : `${Math.round(mins / 60)} hr ${mins % 60} min`;
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Order Details</h1>
          <p className="text-gray-500">Order #{order.id.slice(0, 8)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>

      {!isActive || connection === 'open' || connection === 'closed' ? null : (
        <div className="mb-4 p-3 rounded-lg bg-yellow-50 text-yellow-800 text-sm" role="status">
          {connection === 'reconnecting'
            ? 'Live updates paused. Reconnecting...'
            : 'Connecting to live updates...'}
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm" role="alert">
          {actionError}
        </div>
      )}

      {/* Live Tracking */}
      {isActive && order.driver && (
        <div className="card p-6 mb-6 bg-accent-50 border-accent-200">
          <h2 className="font-semibold text-gray-900 mb-3">Live Tracking</h2>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <p className="text-gray-700">
                Driver: <span className="font-medium">{order.driver.name}</span>
              </p>
              <p className="text-sm text-gray-500">
                {order.driver.vehicle_type} - Rating: {formatNumber(order.driver.rating, 1)}
              </p>
            </div>
            {eta && (
              <div className="text-right">
                <p className="text-2xl font-bold text-accent-600">{formatEta(eta)}</p>
                <p className="text-sm text-gray-500">Estimated arrival</p>
              </div>
            )}
          </div>
          {driverLocation && (
            <div className="mt-4 p-4 bg-white rounded-lg">
              <p className="text-sm text-gray-500">Driver Location</p>
              <p className="font-mono text-sm">
                {formatNumber(driverLocation.lat, 6)}, {formatNumber(driverLocation.lng, 6)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Order Status Timeline */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Order Progress</h2>
        <div className="space-y-4">
          {getStatusSteps(order).map((step, index) => (
            <div key={step.status} className="flex items-center gap-3">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  step.completed
                    ? 'bg-green-500 text-white'
                    : step.current
                    ? 'bg-accent-500 text-white'
                    : 'bg-gray-200 text-gray-400'
                }`}
              >
                {step.completed ? '✓' : index + 1}
              </div>
              <div className="flex-1">
                <p className={step.completed || step.current ? 'font-medium' : 'text-gray-400'}>
                  {step.label}
                </p>
                {step.time && (
                  <p className="text-sm text-gray-500">
                    {new Date(step.time).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Merchant Info */}
      {order.merchant && (
        <div className="card p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-3">Restaurant</h2>
          <p className="font-medium">{order.merchant.name}</p>
          <p className="text-sm text-gray-500">{order.merchant.address}</p>
        </div>
      )}

      {/* Delivery Address */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-3">Delivery Address</h2>
        <p>{order.delivery_address}</p>
        {order.delivery_instructions && (
          <p className="text-sm text-gray-500 mt-2">
            Instructions: {order.delivery_instructions}
          </p>
        )}
      </div>

      {/* Order Items */}
      <div className="card p-6 mb-6">
        <h2 className="font-semibold text-gray-900 mb-4">Items</h2>
        <div className="divide-y divide-gray-100">
          {order.items.map((item) => (
            <div key={item.id} className="py-3 flex justify-between">
              <div>
                <span className="text-gray-600">{item.quantity}x </span>
                <span>{item.name}</span>
                {item.special_instructions && (
                  <p className="text-sm text-gray-500">{item.special_instructions}</p>
                )}
              </div>
              <span className="font-medium">
                ${formatPrice(toNumber(item.unit_price) * item.quantity)}
              </span>
            </div>
          ))}
        </div>

        <div className="border-t border-gray-200 pt-4 mt-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Subtotal</span>
            <span>${formatPrice(order.subtotal)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Delivery Fee</span>
            <span>${formatPrice(order.delivery_fee)}</span>
          </div>
          {order.tip > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Tip</span>
              <span>${formatPrice(order.tip)}</span>
            </div>
          )}
          <div className="flex justify-between font-semibold text-lg pt-2 border-t">
            <span>Total</span>
            <span>${formatPrice(order.total)}</span>
          </div>
        </div>
      </div>

      {/* Rating Section */}
      {order.status === 'delivered' && !ratingSubmitted && (
        <div className="card p-6 mb-6">
          <h2 className="font-semibold text-gray-900 mb-4">Rate Your Experience</h2>

          {order.driver && (
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">Rate Driver</p>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => setDriverRating(star)}
                    className={`text-2xl ${star <= driverRating ? 'text-yellow-400' : 'text-gray-300'}`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mb-4">
            <p className="text-sm text-gray-600 mb-2">Rate Restaurant</p>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => setMerchantRating(star)}
                  className={`text-2xl ${star <= merchantRating ? 'text-yellow-400' : 'text-gray-300'}`}
                >
                  ★
                </button>
              ))}
            </div>
          </div>

          <button onClick={handleSubmitRatings} className="btn-primary">
            Submit Ratings
          </button>
        </div>
      )}

      {ratingSubmitted && (
        <div className="card p-6 mb-6 bg-green-50">
          <p className="text-green-700">Thank you for your feedback!</p>
        </div>
      )}

      {/* Cancel Button */}
      {canCancel && (
        <button
          onClick={handleCancelOrder}
          className="btn-outline w-full text-red-600 border-red-300 hover:bg-red-50"
        >
          Cancel Order
        </button>
      )}
    </div>
  );
}

function getStatusSteps(order: OrderWithDetails) {
  const steps = [
    { status: 'pending', label: 'Order Placed', time: order.created_at },
    { status: 'confirmed', label: 'Confirmed', time: order.confirmed_at },
    { status: 'preparing', label: 'Preparing' },
    { status: 'driver_assigned', label: 'Driver Assigned' },
    { status: 'picked_up', label: 'Picked Up', time: order.picked_up_at },
    { status: 'in_transit', label: 'On the Way' },
    { status: 'delivered', label: 'Delivered', time: order.delivered_at },
  ];

  const statusOrder = [
    'pending',
    'confirmed',
    'preparing',
    'ready_for_pickup',
    'driver_assigned',
    'picked_up',
    'in_transit',
    'delivered',
  ];

  const currentIndex = statusOrder.indexOf(order.status);

  return steps.map((step) => ({
    ...step,
    completed: statusOrder.indexOf(step.status) < currentIndex,
    current: step.status === order.status,
  }));
}
