import { create } from 'zustand';
import type { Location } from '@/types';

interface LocationState {
  location: Location | null;
  isLoading: boolean;
  error: string | null;
  watchId: number | null;

  getCurrentLocation: () => Promise<Location>;
  watchLocation: (onUpdate: (location: Location) => void) => void;
  stopWatching: () => void;
  setLocation: (location: Location) => void;
}

// Default location (San Francisco downtown) for demo
const DEFAULT_LOCATION: Location = {
  lat: 37.7749,
  lng: -122.4194,
};

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
