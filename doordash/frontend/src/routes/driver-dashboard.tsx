import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { driverAPI } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useDriverLocation } from '../hooks/useDriverLocation';
import { useWebSocket } from '../hooks/useWebSocket';
import { OrderCard } from '../components/OrderCard';
import type { Order, WSMessage, Driver } from '../types';

export const Route = createFileRoute('/driver-dashboard')({
  component: DriverDashboard,
});

function DriverDashboard() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [driver, setDriver] = useState<Driver | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<{ deliveries: number; tips: number; fees: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(false);

  const { lat, lon, error: locationError, startTracking, stopTracking } = useDriverLocation(isOnline);

  useEffect(() => {
    if (!user || user.role !== 'driver') {
      navigate({ to: '/' });
      return;
    }
    loadDriverData();
  }, [user, navigate]);

  const loadDriverData = async () => {
    try {
      const data = await driverAPI.getStats();
      setDriver(data.driver);
      setStats(data.today);
      setIsOnline(data.driver.is_active);
    } catch (err) {
      console.error('Failed to load driver data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadOrders = useCallback(async () => {
    try {
      const { orders } = await driverAPI.getOrders('active');
      setOrders(orders);
    } catch (err) {
      console.error('Failed to load orders:', err);
    }
  }, []);

  useEffect(() => {
    if (driver) {
      loadOrders();
    }
  }, [driver, loadOrders]);

  // Subscribe to real-time updates
  const handleMessage = useCallback((message: WSMessage) => {
    if (message.type === 'order_assigned') {
      setOrders((prev) => [message.order as Order, ...prev]);
    }
    if (message.type === 'order_status_update') {
      const updatedOrder = message.order as Order;
      setOrders((prev) =>
        prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o))
      );
    }
  }, []);

  useWebSocket(user ? [`driver:${user.id}:orders`] : [], handleMessage);

  const toggleOnline = async () => {
    try {
      const newStatus = !isOnline;
      await driverAPI.setStatus(newStatus);
      setIsOnline(newStatus);
      if (newStatus) {
        startTracking();
      } else {
        stopTracking();
      }
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handlePickup = async (orderId: number) => {
    try {
      const { order } = await driverAPI.pickupOrder(orderId);
      setOrders((prev) => prev.map((o) => (o.id === orderId ? order : o)));
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleDeliver = async (orderId: number) => {
    try {
      await driverAPI.deliverOrder(orderId);
      setOrders((prev) => prev.filter((o) => o.id !== orderId));
      // Refresh stats
      loadDriverData();
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

  if (!user || user.role !== 'driver') {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Access Denied</h1>
        <Link to="/" className="text-doordash-red hover:underline">
          Go home
        </Link>
      </div>
    );
  }

  const activeOrders = orders.filter((o) => !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(o.status));

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Driver Dashboard</h1>
          <p className="text-gray-500">
            {driver?.name} | {driver?.vehicle_type}
          </p>
        </div>

        <button
          onClick={toggleOnline}
          className={`px-6 py-3 rounded-full font-medium transition ${
            isOnline
              ? 'bg-green-500 text-white hover:bg-green-600'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {isOnline ? 'Online' : 'Go Online'}
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-lg p-4 shadow-sm text-center">
            <p className="text-2xl font-bold text-gray-900">{stats.deliveries}</p>
            <p className="text-sm text-gray-500">Deliveries Today</p>
          </div>
          <div className="bg-white rounded-lg p-4 shadow-sm text-center">
            <p className="text-2xl font-bold text-green-600">${stats.fees.toFixed(2)}</p>
            <p className="text-sm text-gray-500">Delivery Fees</p>
          </div>
          <div className="bg-white rounded-lg p-4 shadow-sm text-center">
            <p className="text-2xl font-bold text-green-600">${stats.tips.toFixed(2)}</p>
            <p className="text-sm text-gray-500">Tips</p>
          </div>
        </div>
      )}

      {/* Location Status */}
      {isOnline && (
        <div className="bg-white rounded-lg p-4 shadow-sm mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-gray-900">Location Tracking</h2>
              {lat && lon ? (
                <p className="text-sm text-gray-500">
                  Current: {lat.toFixed(4)}, {lon.toFixed(4)}
                </p>
              ) : locationError ? (
                <p className="text-sm text-red-500">{locationError}</p>
              ) : (
                <p className="text-sm text-gray-500">Getting location...</p>
              )}
            </div>
            <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
          </div>
        </div>
      )}

      {/* Active Orders */}
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Active Deliveries ({activeOrders.length})
      </h2>

      {activeOrders.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow-sm">
          <p className="text-gray-500 mb-2">
            {isOnline ? 'Waiting for orders...' : 'Go online to receive orders'}
          </p>
          {isOnline && (
            <p className="text-sm text-gray-400">New orders will appear here automatically</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {activeOrders.map((order) => (
            <div key={order.id} className="bg-white rounded-lg shadow-sm">
              <OrderCard order={order} showDetails userRole="driver" />

              <div className="p-4 border-t">
                {/* Navigation Info */}
                <div className="mb-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-doordash-red rounded-full flex items-center justify-center text-white font-medium">
                      1
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">Pickup: {order.restaurant_name}</p>
                      <p className="text-sm text-gray-500">{order.restaurant_address}</p>
                    </div>
                  </div>
                  <div className="w-0.5 h-6 bg-gray-300 ml-4"></div>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 bg-gray-400 rounded-full flex items-center justify-center text-white font-medium">
                      2
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">Deliver to Customer</p>
                      <p className="text-sm text-gray-500">{order.delivery_address?.address}</p>
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                {order.status === 'READY_FOR_PICKUP' && (
                  <button
                    onClick={() => handlePickup(order.id)}
                    className="w-full bg-doordash-red text-white py-3 rounded-lg font-medium hover:bg-doordash-darkRed transition"
                  >
                    Confirm Pickup
                  </button>
                )}
                {order.status === 'PICKED_UP' && (
                  <button
                    onClick={() => handleDeliver(order.id)}
                    className="w-full bg-green-500 text-white py-3 rounded-lg font-medium hover:bg-green-600 transition"
                  >
                    Complete Delivery
                  </button>
                )}
                {(order.status === 'CONFIRMED' || order.status === 'PREPARING') && (
                  <div className="text-center text-gray-500 py-2">
                    Waiting for restaurant to prepare food...
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Driver Rating */}
      {driver && (
        <div className="mt-6 bg-white rounded-lg p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-gray-900">Your Rating</h2>
              <p className="text-sm text-gray-500">{driver.total_deliveries} total deliveries</p>
            </div>
            <div className="flex items-center gap-1">
              <svg className="w-6 h-6 text-yellow-400 fill-current" viewBox="0 0 20 20">
                <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
              </svg>
              <span className="text-xl font-bold">{driver.rating.toFixed(1)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
