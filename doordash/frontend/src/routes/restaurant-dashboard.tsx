import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import { restaurantAPI, orderAPI } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useWebSocket } from '../hooks/useWebSocket';
import { OrderCard } from '../components/OrderCard';
import type { Restaurant, Order, WSMessage } from '../types';

/**
 * Restaurant dashboard route configuration.
 * Restricted to restaurant owners and admins.
 */
export const Route = createFileRoute('/restaurant-dashboard')({
  component: RestaurantDashboard,
});

/**
 * Restaurant dashboard component for managing restaurant operations.
 * Provides restaurant owner functionality for order management
 * and restaurant settings.
 *
 * Features:
 * - Restaurant selector (for owners with multiple restaurants)
 * - Open/closed toggle for accepting orders
 * - Active orders list with status update controls
 * - Real-time new order notifications via WebSocket
 * - Order status progression (Confirm, Prepare, Ready)
 * - Menu management tab (placeholder for future implementation)
 *
 * Access Control:
 * - Redirects non-owners to home page
 * - Requires restaurant_owner or admin role
 *
 * @returns React component for the restaurant owner dashboard
 */
function RestaurantDashboard() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'orders' | 'menu'>('orders');

  useEffect(() => {
    if (!user || (user.role !== 'restaurant_owner' && user.role !== 'admin')) {
      navigate({ to: '/' });
      return;
    }
    loadRestaurants();
  }, [user, navigate]);

  const loadRestaurants = async () => {
    try {
      const { restaurants } = await restaurantAPI.getMyRestaurants();
      setRestaurants(restaurants);
      if (restaurants.length > 0) {
        setSelectedRestaurant(restaurants[0]);
      }
    } catch (err) {
      console.error('Failed to load restaurants:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const loadOrders = useCallback(async () => {
    if (!selectedRestaurant) return;
    try {
      const { orders } = await orderAPI.getRestaurantOrders(selectedRestaurant.id, 'active');
      setOrders(orders);
    } catch (err) {
      console.error('Failed to load orders:', err);
    }
  }, [selectedRestaurant]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // Subscribe to real-time updates
  const handleMessage = useCallback((message: WSMessage) => {
    if (message.type === 'new_order') {
      setOrders((prev) => [message.order as Order, ...prev]);
    }
    if (message.type === 'order_status_update') {
      const updatedOrder = message.order as Order;
      setOrders((prev) =>
        prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o))
      );
    }
  }, []);

  useWebSocket(
    selectedRestaurant ? [`restaurant:${selectedRestaurant.id}:orders`] : [],
    handleMessage
  );

  const handleStatusUpdate = async (orderId: number, newStatus: string) => {
    try {
      await orderAPI.updateStatus(orderId, newStatus);
      // Update will come through WebSocket
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const toggleRestaurantOpen = async () => {
    if (!selectedRestaurant) return;
    try {
      const { restaurant } = await restaurantAPI.update(selectedRestaurant.id, {
        is_open: !selectedRestaurant.is_open,
      });
      setSelectedRestaurant(restaurant);
      setRestaurants((prev) =>
        prev.map((r) => (r.id === restaurant.id ? restaurant : r))
      );
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

  if (!user || (user.role !== 'restaurant_owner' && user.role !== 'admin')) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Access Denied</h1>
        <Link to="/" className="text-doordash-red hover:underline">
          Go home
        </Link>
      </div>
    );
  }

  if (restaurants.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">No restaurants yet</h1>
        <p className="text-gray-500 mb-6">You haven't created any restaurants yet.</p>
      </div>
    );
  }

  const activeOrders = orders.filter((o) => !['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(o.status));

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Restaurant Dashboard</h1>
          <p className="text-gray-500">Manage your restaurant and orders</p>
        </div>

        {/* Restaurant Selector */}
        {restaurants.length > 1 && (
          <select
            value={selectedRestaurant?.id || ''}
            onChange={(e) => {
              const restaurant = restaurants.find((r) => r.id === parseInt(e.target.value));
              setSelectedRestaurant(restaurant || null);
            }}
            className="px-4 py-2 border border-gray-300 rounded-lg"
          >
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {selectedRestaurant && (
        <>
          {/* Restaurant Status */}
          <div className="bg-white rounded-lg p-4 shadow-sm mb-6 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-gray-900">{selectedRestaurant.name}</h2>
              <p className="text-sm text-gray-500">{selectedRestaurant.address}</p>
            </div>
            <button
              onClick={toggleRestaurantOpen}
              className={`px-4 py-2 rounded-full font-medium transition ${
                selectedRestaurant.is_open
                  ? 'bg-green-100 text-green-800 hover:bg-green-200'
                  : 'bg-red-100 text-red-800 hover:bg-red-200'
              }`}
            >
              {selectedRestaurant.is_open ? 'Open' : 'Closed'}
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-4 mb-6 border-b">
            <button
              onClick={() => setActiveTab('orders')}
              className={`px-4 py-2 font-medium transition border-b-2 ${
                activeTab === 'orders'
                  ? 'border-doordash-red text-doordash-red'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Active Orders ({activeOrders.length})
            </button>
            <button
              onClick={() => setActiveTab('menu')}
              className={`px-4 py-2 font-medium transition border-b-2 ${
                activeTab === 'menu'
                  ? 'border-doordash-red text-doordash-red'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Menu Management
            </button>
          </div>

          {/* Orders Tab */}
          {activeTab === 'orders' && (
            <div className="space-y-4">
              {activeOrders.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-lg shadow-sm">
                  <p className="text-gray-500">No active orders</p>
                </div>
              ) : (
                activeOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    showDetails
                    userRole="restaurant"
                    onStatusUpdate={(status) => handleStatusUpdate(order.id, status)}
                  />
                ))
              )}
            </div>
          )}

          {/* Menu Tab */}
          {activeTab === 'menu' && (
            <div className="bg-white rounded-lg shadow-sm p-6">
              <p className="text-gray-500 text-center py-8">
                Menu management would be implemented here.
                <br />
                You can add, edit, and remove menu items.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
