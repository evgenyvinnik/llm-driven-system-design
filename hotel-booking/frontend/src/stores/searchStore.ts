import { create } from 'zustand';
import type { SearchParams } from '@/types';

interface SearchState {
  params: SearchParams;
  setParams: (params: Partial<SearchParams>) => void;
  resetParams: () => void;
}

const defaultParams: SearchParams = {
  city: '',
  checkIn: '',
  checkOut: '',
  guests: 2,
  rooms: 1,
  sortBy: 'relevance',
  page: 1,
  limit: 20,
};

export const useSearchStore = create<SearchState>()((set) => ({
  params: defaultParams,

  setParams: (newParams) => {
    set((state) => ({
      params: { ...state.params, ...newParams },
    }));
  },

  resetParams: () => {
    set({ params: defaultParams });
  },
}));
