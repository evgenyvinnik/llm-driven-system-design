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
  setLocation: (location: string, lat?: number, lng?: number) => void;
  setDates: (checkIn?: string, checkOut?: string) => void;
  setGuests: (guests: number) => void;
  setFilters: (filters: Partial<SearchParams>) => void;
  clearFilters: () => void;
  getSearchParams: () => SearchParams;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  location: '',
  latitude: undefined,
  longitude: undefined,
  checkIn: undefined,
  checkOut: undefined,
  guests: 1,
  filters: {},

  setLocation: (location, lat, lng) =>
    set({ location, latitude: lat, longitude: lng }),

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
