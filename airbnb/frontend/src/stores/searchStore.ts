import { create } from 'zustand';
import { SearchParams } from '../types';

interface SearchState {
  location: string;
  latitude?: number;
  longitude?: number;
  checkIn?: string;
  checkOut?: string;
  guests: number;
  filters: Partial<SearchParams>;
  /** True when a destination was typed but could not be geocoded. */
  locationUnresolved: boolean;
  setLocation: (location: string, lat?: number, lng?: number) => void;
  setDates: (checkIn?: string, checkOut?: string) => void;
  setGuests: (guests: number) => void;
  setFilters: (filters: Partial<SearchParams>) => void;
  clearFilters: () => void;
  getSearchParams: () => SearchParams;
}

/** Global search state managing location, dates, guest count, and filter parameters for listing search. */
export const useSearchStore = create<SearchState>((set, get) => ({
  location: '',
  latitude: undefined,
  longitude: undefined,
  locationUnresolved: false,
  checkIn: undefined,
  checkOut: undefined,
  guests: 1,
  filters: {},

  setLocation: (location, lat, lng) =>
    set({
      location,
      latitude: lat,
      longitude: lng,
      locationUnresolved: Boolean(location) && lat === undefined,
    }),

  setDates: (checkIn, checkOut) => set({ checkIn, checkOut }),

  setGuests: (guests) => set({ guests }),

  setFilters: (filters) =>
    set((state) => ({ filters: { ...state.filters, ...filters } })),

  clearFilters: () => set({ filters: {} }),

  getSearchParams: () => {
    const state = get();
    return {
      latitude: state.latitude,
      longitude: state.longitude,
      check_in: state.checkIn,
      check_out: state.checkOut,
      guests: state.guests,
      ...state.filters,
    };
  },
}));
