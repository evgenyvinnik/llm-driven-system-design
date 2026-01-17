import { create } from 'zustand';
import { Location, Ride, RideOffer, EarningsData } from '../types';
import api from '../services/api';
import wsService from '../services/websocket';

interface DriverState {
  // Status
  isOnline: boolean;
  isAvailable: boolean;
  currentLocation: Location | null;

  // Current ride
  currentRide: Ride | null;
  rideOffer: RideOffer | null;
  offerExpiresAt: number | null;

  // Earnings
  earnings: EarningsData | null;

  // UI state
  isLoading: boolean;
  error: string | null;

  // Actions
  setCurrentLocation: (location: Location) => void;
  goOnline: () => Promise<void>;
  goOffline: () => Promise<void>;
  updateLocation: (lat: number, lng: number) => Promise<void>;
  fetchStatus: () => Promise<void>;

  acceptRide: () => Promise<void>;
  declineRide: () => void;
  arrivedAtPickup: () => Promise<void>;
  startRide: () => Promise<void>;
  completeRide: () => Promise<void>;

  fetchEarnings: (period?: string) => Promise<void>;

  clearError: () => void;
}

export const useDriverStore = create<DriverState>((set, get) => {
  // Set up WebSocket handlers
  wsService.on('ride_offer', (msg) => {
    const offer = msg as RideOffer;
    set({
      rideOffer: offer,
      offerExpiresAt: Date.now() + offer.expiresIn * 1000,
    });
  });

  wsService.on('ride_cancelled', () => {
    set({
      currentRide: null,
      isAvailable: true,
    });
  });

  return {
    isOnline: false,
    isAvailable: false,
    currentLocation: null,
    currentRide: null,
    rideOffer: null,
    offerExpiresAt: null,
    earnings: null,
    isLoading: false,
    error: null,

    setCurrentLocation: (location) => set({ currentLocation: location }),

    goOnline: async () => {
      const { currentLocation } = get();
      if (!currentLocation) {
        set({ error: 'Location required to go online' });
        return;
      }

      set({ isLoading: true, error: null });
      try {
        await api.driver.goOnline(currentLocation.lat, currentLocation.lng);
        set({ isOnline: true, isAvailable: true, isLoading: false });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    goOffline: async () => {
      set({ isLoading: true, error: null });
      try {
        await api.driver.goOffline();
        set({ isOnline: false, isAvailable: false, isLoading: false });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    updateLocation: async (lat, lng) => {
      const location = { lat, lng };
      set({ currentLocation: location });

      // Send via WebSocket for real-time updates
      wsService.sendLocationUpdate(lat, lng);

      // Also send via API for persistence
      try {
        await api.driver.updateLocation(lat, lng);
      } catch {
        // Silently fail location updates
      }
    },

    fetchStatus: async () => {
      try {
        const status = (await api.driver.status()) as {
          status: string;
          location: Location | null;
          activeRide: Ride | null;
        };

        set({
          isOnline: status.status !== 'offline',
          isAvailable: status.status === 'available',
          currentLocation: status.location,
          currentRide: status.activeRide,
        });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    acceptRide: async () => {
      const { rideOffer } = get();
      if (!rideOffer) return;

      set({ isLoading: true, error: null });
      try {
        const result = (await api.driver.acceptRide(rideOffer.rideId)) as { ride: Ride };
        set({
          currentRide: result.ride,
          rideOffer: null,
          offerExpiresAt: null,
          isAvailable: false,
          isLoading: false,
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    declineRide: () => {
      const { rideOffer } = get();
      if (rideOffer) {
        api.driver.declineRide(rideOffer.rideId).catch(console.error);
      }
      set({ rideOffer: null, offerExpiresAt: null });
    },

    arrivedAtPickup: async () => {
      const { currentRide } = get();
      if (!currentRide) return;

      set({ isLoading: true, error: null });
      try {
        await api.driver.arrivedAtPickup(currentRide.id);
        set((state) => ({
          currentRide: state.currentRide ? { ...state.currentRide, status: 'driver_arrived' } : null,
          isLoading: false,
        }));
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    startRide: async () => {
      const { currentRide } = get();
      if (!currentRide) return;

      set({ isLoading: true, error: null });
      try {
        await api.driver.startRide(currentRide.id);
        set((state) => ({
          currentRide: state.currentRide ? { ...state.currentRide, status: 'picked_up' } : null,
          isLoading: false,
        }));
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    completeRide: async () => {
      const { currentRide } = get();
      if (!currentRide) return;

      set({ isLoading: true, error: null });
      try {
        await api.driver.completeRide(currentRide.id);
        set({
          currentRide: null,
          isAvailable: true,
          isLoading: false,
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    fetchEarnings: async (period = 'today') => {
      set({ isLoading: true, error: null });
      try {
        const earnings = (await api.driver.earnings(period)) as EarningsData;
        set({ earnings, isLoading: false });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    clearError: () => set({ error: null }),
  };
});
