import { create } from 'zustand';
import { Location, FareEstimate, Ride, Driver, RideStatus } from '../types';
import api from '../services/api';
import wsService from '../services/websocket';

interface RideState {
  // Location
  currentLocation: Location | null;
  pickup: Location | null;
  dropoff: Location | null;

  // Estimates
  estimates: FareEstimate[];
  selectedVehicleType: string;

  // Current ride
  currentRide: Ride | null;
  rideStatus: RideStatus | null;

  // Nearby drivers for map
  nearbyDrivers: Array<{ id: string; lat: number; lng: number; vehicleType: string }>;

  // UI state
  isLoading: boolean;
  error: string | null;

  // Actions
  setCurrentLocation: (location: Location) => void;
  setPickup: (location: Location | null) => void;
  setDropoff: (location: Location | null) => void;
  setSelectedVehicleType: (type: string) => void;

  fetchEstimates: () => Promise<void>;
  requestRide: () => Promise<void>;
  cancelRide: (reason?: string) => Promise<void>;
  rateRide: (rating: number) => Promise<void>;
  fetchRideStatus: (rideId: string) => Promise<void>;
  fetchNearbyDrivers: () => Promise<void>;

  // WebSocket handlers
  handleRideMatched: (driver: Driver) => void;
  handleDriverArrived: () => void;
  handleRideStarted: () => void;
  handleRideCompleted: (fare: unknown) => void;
  handleRideCancelled: (reason?: string) => void;

  clearRide: () => void;
  clearError: () => void;
}

export const useRideStore = create<RideState>((set, get) => {
  // Set up WebSocket handlers
  wsService.on('ride_matched', (msg) => {
    get().handleRideMatched(msg.driver as Driver);
  });

  wsService.on('driver_arrived', () => {
    get().handleDriverArrived();
  });

  wsService.on('ride_started', () => {
    get().handleRideStarted();
  });

  wsService.on('ride_completed', (msg) => {
    get().handleRideCompleted(msg.fare);
  });

  wsService.on('ride_cancelled', (msg) => {
    get().handleRideCancelled(msg.reason as string);
  });

  wsService.on('no_drivers_available', () => {
    set({
      error: 'No drivers available in your area. Please try again later.',
      currentRide: null,
      rideStatus: null,
    });
  });

  return {
    currentLocation: null,
    pickup: null,
    dropoff: null,
    estimates: [],
    selectedVehicleType: 'economy',
    currentRide: null,
    rideStatus: null,
    nearbyDrivers: [],
    isLoading: false,
    error: null,

    setCurrentLocation: (location) => set({ currentLocation: location }),

    setPickup: (location) => {
      set({ pickup: location, estimates: [] });
    },

    setDropoff: (location) => {
      set({ dropoff: location, estimates: [] });
    },

    setSelectedVehicleType: (type) => set({ selectedVehicleType: type }),

    fetchEstimates: async () => {
      const { pickup, dropoff } = get();
      if (!pickup || !dropoff) return;

      set({ isLoading: true, error: null });
      try {
        const result = await api.rides.estimate(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
        set({ estimates: result.estimates as FareEstimate[], isLoading: false });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    requestRide: async () => {
      const { pickup, dropoff, selectedVehicleType } = get();
      if (!pickup || !dropoff) return;

      set({ isLoading: true, error: null });
      try {
        const result = await api.rides.request({
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          dropoffLat: dropoff.lat,
          dropoffLng: dropoff.lng,
          vehicleType: selectedVehicleType,
          pickupAddress: pickup.address,
          dropoffAddress: dropoff.address,
        });

        const ride = result as Ride;
        set({
          currentRide: ride,
          rideStatus: 'requested',
          isLoading: false,
        });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    cancelRide: async (reason) => {
      const { currentRide } = get();
      if (!currentRide) return;

      set({ isLoading: true, error: null });
      try {
        await api.rides.cancel(currentRide.id, reason);
        set({ currentRide: null, rideStatus: null, isLoading: false });
      } catch (error) {
        set({ error: (error as Error).message, isLoading: false });
      }
    },

    rateRide: async (rating) => {
      const { currentRide } = get();
      if (!currentRide) return;

      try {
        await api.rides.rate(currentRide.id, rating);
        set({ currentRide: null, rideStatus: null, pickup: null, dropoff: null });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    fetchRideStatus: async (rideId) => {
      try {
        const ride = (await api.rides.get(rideId)) as Ride;
        set({ currentRide: ride, rideStatus: ride.status });
      } catch (error) {
        set({ error: (error as Error).message });
      }
    },

    fetchNearbyDrivers: async () => {
      const { currentLocation } = get();
      if (!currentLocation) return;

      try {
        const result = await api.rides.nearbyDrivers(currentLocation.lat, currentLocation.lng);
        set({ nearbyDrivers: result.drivers as Array<{ id: string; lat: number; lng: number; vehicleType: string }> });
      } catch {
        // Silently fail for nearby drivers
      }
    },

    handleRideMatched: (driver) => {
      set((state) => ({
        currentRide: state.currentRide ? { ...state.currentRide, driver } : null,
        rideStatus: 'matched',
      }));
    },

    handleDriverArrived: () => {
      set({ rideStatus: 'driver_arrived' });
    },

    handleRideStarted: () => {
      set({ rideStatus: 'picked_up' });
    },

    handleRideCompleted: (fare) => {
      set((state) => ({
        currentRide: state.currentRide ? { ...state.currentRide, fare: fare as Ride['fare'] } : null,
        rideStatus: 'completed',
      }));
    },

    handleRideCancelled: (reason) => {
      set({
        error: reason ? `Ride cancelled: ${reason}` : 'Ride was cancelled',
        currentRide: null,
        rideStatus: null,
      });
    },

    clearRide: () => {
      set({
        currentRide: null,
        rideStatus: null,
        pickup: null,
        dropoff: null,
        estimates: [],
      });
    },

    clearError: () => set({ error: null }),
  };
});
