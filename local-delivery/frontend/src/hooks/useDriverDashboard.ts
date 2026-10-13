import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '@/services/api';
import { wsService } from '@/services/websocket';
import { useAuthStore } from '@/stores/authStore';
import { useLocationStore } from '@/stores/locationStore';
import type { Driver, DriverStats, OrderWithDetails, NewOfferPayload, DriverOffer, Location } from '@/types';
import type { PendingOffer } from '@/components/driver/DeliveryOfferModal';

/**
 * The server treats a courier as reachable only if they pinged in the last
 * 30 s. Browsers fire watchPosition only on movement, so a parked courier
 * re-sends the last position on this interval.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;

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
  /** Last outcome worth telling the driver about (e.g. an offer that was taken) */
  notice: string | null;
  /** Clears the notice */
  dismissNotice: () => void;
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
 * Sends a location ping over the socket when it is open, otherwise over HTTP.
 * Never both: each ping is one write and one location event for trackers.
 */
async function sendLocation(location: Location): Promise<void> {
  if (!wsService.updateLocation(location.lat, location.lng)) {
    await api.updateLocation(location.lat, location.lng);
  }
}

/**
 * Custom hook that encapsulates all state management and business logic
 * for the driver dashboard. Handles:
 * - Loading and refreshing driver profile and orders
 * - WebSocket connection for real-time delivery offers, with the pending
 *   offer re-fetched on every (re)connect so a missed push is recovered
 * - Online/offline status toggling with location tracking and a heartbeat
 * - Offer acceptance/rejection with countdown timer
 * - Order status transitions (picked up, in transit, delivered)
 */
export function useDriverDashboard(): UseDriverDashboardReturn {
  const [driver, setDriver] = useState<(Driver & DriverStats) | null>(null);
  const [orders, setOrders] = useState<OrderWithDetails[]>([]);
  const [pendingOffer, setPendingOffer] = useState<PendingOffer | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTogglingStatus, setIsTogglingStatus] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { user, token } = useAuthStore();
  const { location, getCurrentLocation, watchLocation, stopWatching } = useLocationStore();
  const navigate = useNavigate();

  // Latest known position, readable by the heartbeat without re-creating it.
  const lastLocation = useRef<Location | null>(location);
  useEffect(() => {
    lastLocation.current = location;
  }, [location]);

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

  /**
   * Fetches the offer the server says is pending (if any), so an offer pushed
   * while the socket was down still shows up, with the server's countdown.
   */
  const recoverPendingOffer = useCallback(async () => {
    try {
      const pending = await api.getPendingOffer();
      if (pending) {
        setPendingOffer({
          offer: pending.offer,
          order: pending.order,
          expiresIn: pending.offer.expires_in_seconds,
        });
      }
    } catch (error) {
      console.error('Failed to fetch pending offer:', error);
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

  const isOnline = driver !== null && driver.status !== 'offline';

  // Connect to WebSocket for real-time offers while online
  useEffect(() => {
    if (!token || !isOnline) {
      return;
    }

    wsService.connect(token, {
      onConnected: () => {
        wsService.subscribeToDriverOffers();
        void recoverPendingOffer();
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
  }, [token, isOnline, recoverPendingOffer]);

  // While online: follow the device position and send a heartbeat ping, so the
  // courier stays "fresh" in the geo index even when parked. This also resumes
  // tracking after a reload for a courier who was already online.
  useEffect(() => {
    if (!isOnline) {
      return;
    }

    watchLocation((newLoc) => {
      sendLocation(newLoc).catch((error) => console.error('Location update failed:', error));
    });
    if (!lastLocation.current) {
      // No fix yet (e.g. reload while online): use the browser's position or the demo default.
      void getCurrentLocation().then((loc) => {
        lastLocation.current = loc;
        return sendLocation(loc);
      });
    }
    const heartbeat = setInterval(() => {
      if (lastLocation.current) {
        sendLocation(lastLocation.current).catch((error) => console.error('Heartbeat failed:', error));
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      clearInterval(heartbeat);
      stopWatching();
    };
  }, [isOnline, watchLocation, stopWatching, getCurrentLocation]);

  // Countdown timer for pending offer expiration
  const offerId = pendingOffer?.offer.id;
  useEffect(() => {
    if (!offerId) return;

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
  }, [offerId]);

  /**
   * Transitions the driver to online status. Location watching and the
   * heartbeat start from the effect above once the status flips.
   */
  const handleGoOnline = useCallback(async () => {
    setIsTogglingStatus(true);
    try {
      let loc = location;
      if (!loc) {
        loc = await getCurrentLocation();
      }
      lastLocation.current = loc;

      await api.goOnline(loc.lat, loc.lng);
      setDriver((prev) => (prev ? { ...prev, status: 'available' } : null));
    } catch (error) {
      console.error('Failed to go online:', error);
    } finally {
      setIsTogglingStatus(false);
    }
  }, [location, getCurrentLocation]);

  /**
   * Transitions the driver to offline status. The server refuses (409) while
   * a delivery is active, so the client check is only a fast path.
   */
  const handleGoOffline = useCallback(async () => {
    if (orders.length > 0) {
      setNotice('Complete your active deliveries before going offline');
      return;
    }

    setIsTogglingStatus(true);
    try {
      await api.goOffline();
      setPendingOffer(null);
      setDriver((prev) => (prev ? { ...prev, status: 'offline' } : null));
    } catch (error) {
      setNotice((error as Error).message || 'Failed to go offline');
    } finally {
      setIsTogglingStatus(false);
    }
  }, [orders.length]);

  /**
   * Accepts the current pending delivery offer. A 409 means someone or
   * something got there first (offer expired, order cancelled): say so and
   * close the offer instead of failing silently.
   */
  const handleAcceptOffer = useCallback(async () => {
    if (!pendingOffer) return;

    try {
      const order = await api.acceptOffer(pendingOffer.offer.id);
      setOrders((prev) => [...prev, order as OrderWithDetails]);
      setDriver((prev) => (prev ? { ...prev, status: 'busy' } : null));
      setPendingOffer(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNotice(error.message);
        setPendingOffer(null);
        return;
      }
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
    } catch (error) {
      console.error('Failed to reject offer:', error);
    } finally {
      setPendingOffer(null);
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
      setNotice((error as Error).message || 'Failed to mark picked up');
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
      setNotice((error as Error).message || 'Failed to mark in transit');
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
      setNotice((error as Error).message || 'Failed to mark delivered');
    }
  }, [loadDriverData]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    driver,
    orders,
    pendingOffer,
    isLoading,
    isTogglingStatus,
    isOnline,
    notice,
    dismissNotice,
    handleGoOnline,
    handleGoOffline,
    handleAcceptOffer,
    handleRejectOffer,
    handlePickedUp,
    handleInTransit,
    handleDelivered,
  };
}
