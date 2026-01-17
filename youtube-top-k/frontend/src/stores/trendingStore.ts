import { create } from 'zustand';
import type { Video, TrendingAllResponse, StatsResponse } from '../types';

interface TrendingStore {
  trending: TrendingAllResponse;
  stats: StatsResponse | null;
  selectedCategory: string;
  isConnected: boolean;
  lastUpdate: Date | null;
  setTrending: (trending: TrendingAllResponse) => void;
  setStats: (stats: StatsResponse) => void;
  setSelectedCategory: (category: string) => void;
  setConnected: (connected: boolean) => void;
  setLastUpdate: (date: Date) => void;
  getSelectedVideos: () => Video[];
}

export const useTrendingStore = create<TrendingStore>((set, get) => ({
  trending: {},
  stats: null,
  selectedCategory: 'all',
  isConnected: false,
  lastUpdate: null,

  setTrending: (trending) => set({ trending, lastUpdate: new Date() }),
  setStats: (stats) => set({ stats }),
  setSelectedCategory: (category) => set({ selectedCategory: category }),
  setConnected: (connected) => set({ isConnected: connected }),
  setLastUpdate: (date) => set({ lastUpdate: date }),

  getSelectedVideos: () => {
    const state = get();
    const categoryData = state.trending[state.selectedCategory];
    return categoryData?.videos || [];
  },
}));
