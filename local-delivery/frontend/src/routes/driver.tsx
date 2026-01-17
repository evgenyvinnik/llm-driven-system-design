import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useCallback } from 'react';
import { api } from '@/services/api';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/authStore';
import { useLocationStore } from '@/stores/locationStore';
import { StatusBadge } from '@/components/StatusBadge';
import { PageLoading } from '@/components/LoadingSpinner';
import type { Driver, DriverStats, OrderWithDetails, NewOfferPayload, DriverOffer } from '@/types';

export const Route = createFileRoute('/driver')({
  component: DriverDashboard,
});

function DriverDashboard() {
  const [driver, setDriver] = useState<(Driver & DriverStats) | null>(null);
  const [orders, setOrders] = useState<OrderWithDetails[]>([]);
  const [pendingOffer, setPendingOffer] = useState<{
    offer: DriverOffer;
    order: OrderWithDetails;
    expiresIn: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTogglingStatus, setIsTogglingStatus] = useState(false);

  const { user, token } = useAuthStore();
  const { location, getCurrentLocation, watchLocation, stopWatching } = useLocationStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user || user.role !== 'driver') {
      navigate({ to: '/login' });
      return;
    }

    loadDriverData();
  }, [user]);

  useEffect(() => {
    if (!token || !driver || driver.status === 'offline') {
      return;
    }

    // Connect to WebSocket for real-time offers
    wsService.connect(token, {
      onConnected: () => {
        wsService.subscribeToDriverOffers();
      },
      onNewOffer: (payload: NewOfferPayload) => {
        setPendingOffer({
          offer: { id: payload.offer_id } as DriverOffer,
          order: payload.order,
          expiresIn: payload.expires_in,
        });
      },
      onError: (message) => {
        console.error('WebSocket error:', message);
      },
    });

    return () => {
      wsService.disconnect();
    };
  }, [token, driver?.status]);

  // Countdown timer for pending offer
  useEffect(() => {
    if (!pendingOffer) return;

    const timer = setInterval(() => {
      setPendingOffer((prev) => {
        if (!prev) return null;
        if (prev.expiresIn <= 1) {
          return null;
        }
        return { ...prev, expiresIn: prev.expiresIn - 1 };
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [pendingOffer?.offer.id]);

  const loadDriverData = async () => {
    setIsLoading(true);
    try {
      const [profileData, ordersData] = await Promise.all([
        api.getDriverProfile(),
        api.getDriverOrders(),
      ]);
      setDriver(profileData as Driver & DriverStats);
      setOrders(ordersData as OrderWithDetails[]);
    } catch (error) {
      console.error('Failed to load driver data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoOnline = async () => {
    setIsTogglingStatus(true);
    try {
      let loc = location;
      if (!loc) {
        loc = await getCurrentLocation();
      }

      await api.goOnline(loc.lat, loc.lng);

      // Start watching location
      watchLocation(async (newLoc) => {
        await api.updateLocation(newLoc.lat, newLoc.lng);
        wsService.updateLocation(newLoc.lat, newLoc.lng);
      });

      setDriver((prev) => prev ? { ...prev, status: 'available' } : null);
    } catch (error) {
      console.error('Failed to go online:', error);
    } finally {
      setIsTogglingStatus(false);
    }
  };

  const handleGoOffline = async () => {
    if (orders.length > 0) {
      alert('Complete your active deliveries before going offline');
      return;
    }

    setIsTogglingStatus(true);
    try {
      await api.goOffline();
      stopWatching();
      setDriver((prev) => prev ? { ...prev, status: 'offline' } : null);
    } catch (error) {
      console.error('Failed to go offline:', error);
    } finally {
      setIsTogglingStatus(false);
    }
  };

  const handleAcceptOffer = async () => {
    if (!pendingOffer) return;

    try {
      const order = await api.acceptOffer(pendingOffer.offer.id);
      setOrders((prev) => [...prev, order as OrderWithDetails]);
      setPendingOffer(null);
    } catch (error) {
      console.error('Failed to accept offer:', error);
    }
  };

  const handleRejectOffer = async () => {
    if (!pendingOffer) return;

    try {
      await api.rejectOffer(pendingOffer.offer.id);
      setPendingOffer(null);
    } catch (error) {
      console.error('Failed to reject offer:', error);
    }
  };

  const handlePickedUp = async (orderId: string) => {
    try {
      await api.markPickedUp(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark picked up:', error);
    }
  };

  const handleInTransit = async (orderId: string) => {
    try {
      await api.markInTransit(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark in transit:', error);
    }
  };

  const handleDelivered = async (orderId: string) => {
    try {
      await api.markDelivered(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark delivered:', error);
    }
  };

  if (isLoading) {
    return <PageLoading />;
  }

  if (!driver) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Driver profile not found</p>
      </div>
    );
  }

  const isOnline = driver.status !== 'offline';

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Pending Offer Modal */}
      {pendingOffer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">New Delivery Request</h2>
              <div className="text-2xl font-bold text-accent-600">
                {pendingOffer.expiresIn}s
              </div>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <p className="text-sm text-gray-500">Restaurant</p>
                <p className="font-medium">{pendingOffer.order.merchant?.name}</p>
                <p className="text-sm text-gray-500">{pendingOffer.order.merchant?.address}</p>
              </div>

              <div>
                <p className="text-sm text-gray-500">Deliver to</p>
                <p className="font-medium">{pendingOffer.order.delivery_address}</p>
              </div>

              <div className="flex justify-between">
                <div>
                  <p className="text-sm text-gray-500">Items</p>
                  <p>{pendingOffer.order.items.length} items</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-gray-500">Payout</p>
                  <p className="font-semibold text-lg text-green-600">
                    ${(pendingOffer.order.delivery_fee + pendingOffer.order.tip).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={handleRejectOffer}
                className="btn-outline flex-1"
              >
                Decline
              </button>
              <button
                onClick={handleAcceptOffer}
                className="btn-primary flex-1"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Driver Status Header */}
      <div className="card p-6 mb-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">{driver.name}</h1>
            <div className="flex items-center gap-4 text-sm text-gray-500">
              <span className="capitalize">{driver.vehicle_type}</span>
              <span>⭐ {driver.rating.toFixed(2)}</span>
              <span>{driver.total_deliveries} deliveries</span>
            </div>
          </div>

          <div className="text-right">
            <div
              className={`inline-block px-4 py-2 rounded-full font-medium ${
                isOnline
                  ? driver.status === 'busy'
                    ? 'bg-yellow-100 text-yellow-800'
                    : 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-600'
              }`}
            >
              {isOnline ? (driver.status === 'busy' ? 'Busy' : 'Online') : 'Offline'}
            </div>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t">
          {isOnline ? (
            <button
              onClick={handleGoOffline}
              disabled={isTogglingStatus || orders.length > 0}
              className="btn-outline w-full"
            >
              {isTogglingStatus ? 'Going offline...' : 'Go Offline'}
            </button>
          ) : (
            <button
              onClick={handleGoOnline}
              disabled={isTogglingStatus}
              className="btn-primary w-full"
            >
              {isTogglingStatus ? 'Going online...' : 'Go Online'}
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{driver.stats?.current_orders || 0}</p>
          <p className="text-sm text-gray-500">Active Orders</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{(driver.stats?.acceptance_rate * 100 || 100).toFixed(0)}%</p>
          <p className="text-sm text-gray-500">Acceptance Rate</p>
        </div>
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold text-gray-900">{driver.total_deliveries}</p>
          <p className="text-sm text-gray-500">Total Deliveries</p>
        </div>
      </div>

      {/* Active Orders */}
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Active Deliveries</h2>

        {orders.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-gray-500">
              {isOnline
                ? 'Waiting for orders...'
                : 'Go online to receive delivery requests'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {orders.map((order) => (
              <div key={order.id} className="card p-4">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-semibold">{order.merchant?.name}</h3>
                    <p className="text-sm text-gray-500">{order.merchant?.address}</p>
                  </div>
                  <StatusBadge status={order.status} />
                </div>

                <div className="mb-4">
                  <p className="text-sm text-gray-500">Deliver to</p>
                  <p className="font-medium">{order.delivery_address}</p>
                  {order.delivery_instructions && (
                    <p className="text-sm text-gray-500 mt-1">
                      Note: {order.delivery_instructions}
                    </p>
                  )}
                </div>

                <div className="mb-4">
                  <p className="text-sm text-gray-500">Items ({order.items.length})</p>
                  <p className="text-sm">
                    {order.items.map((i) => `${i.quantity}x ${i.name}`).join(', ')}
                  </p>
                </div>

                <div className="flex gap-3">
                  {order.status === 'driver_assigned' && (
                    <button
                      onClick={() => handlePickedUp(order.id)}
                      className="btn-primary flex-1"
                    >
                      Mark Picked Up
                    </button>
                  )}
                  {order.status === 'picked_up' && (
                    <button
                      onClick={() => handleInTransit(order.id)}
                      className="btn-accent flex-1"
                    >
                      Start Delivery
                    </button>
                  )}
                  {order.status === 'in_transit' && (
                    <button
                      onClick={() => handleDelivered(order.id)}
                      className="btn-primary flex-1 bg-green-600 hover:bg-green-700"
                    >
                      Mark Delivered
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
