/**
 * Geolocation state management for the delivery platform.
 * Handles browser geolocation API, continuous tracking, and fallback defaults.
 * Used by both customers (for nearby merchants) and drivers (for location sharing).
 *
 * @module stores/locationStore
 */
import { create } from 'zustand';
import type { Location } from '@/types';

/**
 * Location store state and actions.
 */
interface LocationState {
  /** Current user location, null until first detection */
  location: Location | null;
  /** True while geolocation request is pending */
  isLoading: boolean;
  /** Error message if geolocation failed */
  error: string | null;
  /** ID of active location watcher, null if not watching */
  watchId: number | null;

  /**
   * Gets the user's current location using the browser API.
   * Falls back to default location (San Francisco) if unavailable.
   *
   * @returns Promise resolving to the detected location
   */
  getCurrentLocation: () => Promise<Location>;

  /**
   * Starts continuous location watching for real-time updates.
   * Calls the provided callback whenever location changes.
   *
   * @param onUpdate - Callback invoked with new location on each update
   */
  watchLocation: (onUpdate: (location: Location) => void) => void;

  /**
   * Stops continuous location watching.
   * Call when leaving driver mode or tracking features.
   */
  stopWatching: () => void;

  /**
   * Manually sets the current location.
   * Used when user enters address or for testing.
   *
   * @param location - Location to set
   */
  setLocation: (location: Location) => void;
}

/**
 * Default location (San Francisco downtown) used when geolocation is unavailable.
 * Provides a reasonable fallback for demo and development purposes.
 */
const DEFAULT_LOCATION: Location = {
  lat: 37.7749,
  lng: -122.4194,
};

/**
 * Zustand store for location state.
 * Location is not persisted (re-detected on each session).
 */
export const useLocationStore = create<LocationState>((set, get) => ({
  location: null,
  isLoading: false,
  error: null,
  watchId: null,

  getCurrentLocation: async () => {
    set({ isLoading: true, error: null });

    return new Promise<Location>((resolve, reject) => {
      if (!navigator.geolocation) {
        set({
          location: DEFAULT_LOCATION,
          isLoading: false,
          error: 'Geolocation not supported',
        });
        resolve(DEFAULT_LOCATION);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location: Location = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          set({ location, isLoading: false });
          resolve(location);
        },
        (error) => {
          console.warn('Geolocation error:', error.message);
          set({
            location: DEFAULT_LOCATION,
            isLoading: false,
            error: error.message,
          });
          resolve(DEFAULT_LOCATION);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 60000,
        }
      );
    });
  },

  watchLocation: (onUpdate) => {
    if (!navigator.geolocation) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const location: Location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        set({ location });
        onUpdate(location);
      },
      (error) => {
        console.warn('Watch location error:', error.message);
        set({ error: error.message });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
      }
    );

    set({ watchId });
  },

  stopWatching: () => {
    const { watchId } = get();
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      set({ watchId: null });
    }
  },

  setLocation: (location) => set({ location }),
}));
