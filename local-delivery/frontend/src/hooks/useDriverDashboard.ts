import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '@/services/api';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/authStore';
import { useLocationStore } from '@/stores/locationStore';
import type { Driver, DriverStats, OrderWithDetails, NewOfferPayload, DriverOffer } from '@/types';
import type { PendingOffer } from '@/components/driver/DeliveryOfferModal';

/**
 * Return type for the useDriverDashboard hook.
 */
interface UseDriverDashboardReturn {
  /** Combined driver profile and statistics, or null if not loaded */
  driver: (Driver & DriverStats) | null;
  /** List of active delivery orders assigned to the driver */
  orders: OrderWithDetails[];
  /** Current pending delivery offer with countdown timer, or null */
  pendingOffer: PendingOffer | null;
  /** Whether initial data is loading */
  isLoading: boolean;
  /** Whether a status toggle (online/offline) is in progress */
  isTogglingStatus: boolean;
  /** Whether the driver is currently online (available or busy) */
  isOnline: boolean;
  /** Handler to go online and start accepting orders */
  handleGoOnline: () => Promise<void>;
  /** Handler to go offline and stop accepting orders */
  handleGoOffline: () => Promise<void>;
  /** Handler to accept the current pending offer */
  handleAcceptOffer: () => Promise<void>;
  /** Handler to reject the current pending offer */
  handleRejectOffer: () => Promise<void>;
  /** Handler to mark an order as picked up from the merchant */
  handlePickedUp: (orderId: string) => Promise<void>;
  /** Handler to mark an order as in transit (started delivery) */
  handleInTransit: (orderId: string) => Promise<void>;
  /** Handler to mark an order as delivered */
  handleDelivered: (orderId: string) => Promise<void>;
}

/**
 * Custom hook that encapsulates all state management and business logic
 * for the driver dashboard. Handles:
 * - Loading and refreshing driver profile and orders
 * - WebSocket connection for real-time delivery offers
 * - Online/offline status toggling with location tracking
 * - Offer acceptance/rejection with countdown timer
 * - Order status transitions (picked up, in transit, delivered)
 *
 * @example
 * ```tsx
 * function DriverDashboard() {
 *   const {
 *     driver,
 *     orders,
 *     pendingOffer,
 *     isLoading,
 *     handleGoOnline,
 *     handleAcceptOffer,
 *     // ... other values
 *   } = useDriverDashboard();
 *
 *   if (isLoading) return <Loading />;
 *   // ... render dashboard
 * }
 * ```
 */
export function useDriverDashboard(): UseDriverDashboardReturn {
  const [driver, setDriver] = useState<(Driver & DriverStats) | null>(null);
  const [orders, setOrders] = useState<OrderWithDetails[]>([]);
  const [pendingOffer, setPendingOffer] = useState<PendingOffer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTogglingStatus, setIsTogglingStatus] = useState(false);

  const { user, token } = useAuthStore();
  const { location, getCurrentLocation, watchLocation, stopWatching } = useLocationStore();
  const navigate = useNavigate();

  /**
   * Loads the driver profile and active orders from the API.
   */
  const loadDriverData = useCallback(async () => {
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
  }, []);

  // Redirect non-driver users and load initial data
  useEffect(() => {
    if (!user || user.role !== 'driver') {
      navigate({ to: '/login' });
      return;
    }

    loadDriverData();
  }, [user, navigate, loadDriverData]);

  // Connect to WebSocket for real-time offers when online
  useEffect(() => {
    if (!token || !driver || driver.status === 'offline') {
      return;
    }

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

  // Countdown timer for pending offer expiration
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

  /**
   * Transitions the driver to online status and starts location tracking.
   * Gets the current location if not available and begins watching for updates.
   */
  const handleGoOnline = useCallback(async () => {
    setIsTogglingStatus(true);
    try {
      let loc = location;
      if (!loc) {
        loc = await getCurrentLocation();
      }

      await api.goOnline(loc.lat, loc.lng);

      // Start watching location and sending updates
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
  }, [location, getCurrentLocation, watchLocation]);

  /**
   * Transitions the driver to offline status and stops location tracking.
   * Prevents going offline if there are active orders.
   */
  const handleGoOffline = useCallback(async () => {
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
  }, [orders.length, stopWatching]);

  /**
   * Accepts the current pending delivery offer and adds the order to active orders.
   */
  const handleAcceptOffer = useCallback(async () => {
    if (!pendingOffer) return;

    try {
      const order = await api.acceptOffer(pendingOffer.offer.id);
      setOrders((prev) => [...prev, order as OrderWithDetails]);
      setPendingOffer(null);
    } catch (error) {
      console.error('Failed to accept offer:', error);
    }
  }, [pendingOffer]);

  /**
   * Rejects the current pending delivery offer.
   */
  const handleRejectOffer = useCallback(async () => {
    if (!pendingOffer) return;

    try {
      await api.rejectOffer(pendingOffer.offer.id);
      setPendingOffer(null);
    } catch (error) {
      console.error('Failed to reject offer:', error);
    }
  }, [pendingOffer]);

  /**
   * Marks an order as picked up from the merchant.
   */
  const handlePickedUp = useCallback(async (orderId: string) => {
    try {
      await api.markPickedUp(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark picked up:', error);
    }
  }, [loadDriverData]);

  /**
   * Marks an order as in transit (delivery started).
   */
  const handleInTransit = useCallback(async (orderId: string) => {
    try {
      await api.markInTransit(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark in transit:', error);
    }
  }, [loadDriverData]);

  /**
   * Marks an order as delivered (delivery completed).
   */
  const handleDelivered = useCallback(async (orderId: string) => {
    try {
      await api.markDelivered(orderId);
      loadDriverData();
    } catch (error) {
      console.error('Failed to mark delivered:', error);
    }
  }, [loadDriverData]);

  const isOnline = driver?.status !== 'offline';

  return {
    driver,
    orders,
    pendingOffer,
    isLoading,
    isTogglingStatus,
    isOnline,
    handleGoOnline,
    handleGoOffline,
    handleAcceptOffer,
    handleRejectOffer,
    handlePickedUp,
    handleInTransit,
    handleDelivered,
  };
}
