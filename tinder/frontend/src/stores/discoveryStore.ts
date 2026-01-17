import { create } from 'zustand';
import type { DiscoveryCard, SwipeResult } from '../types';
import { discoveryApi } from '../services/api';

interface DiscoveryState {
  deck: DiscoveryCard[];
  currentIndex: number;
  isLoading: boolean;
  error: string | null;
  lastMatch: SwipeResult['match'] | null;

  loadDeck: () => Promise<void>;
  swipe: (direction: 'like' | 'pass') => Promise<SwipeResult>;
  clearMatch: () => void;
}

export const useDiscoveryStore = create<DiscoveryState>((set, get) => ({
  deck: [],
  currentIndex: 0,
  isLoading: false,
  error: null,
  lastMatch: null,

  loadDeck: async () => {
    set({ isLoading: true, error: null });
    try {
      const deck = await discoveryApi.getDeck(20);
      set({ deck, currentIndex: 0, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load deck',
        isLoading: false,
      });
    }
  },

  swipe: async (direction) => {
    const { deck, currentIndex } = get();
    const currentCard = deck[currentIndex];

    if (!currentCard) {
      throw new Error('No card to swipe');
    }

    try {
      const result = await discoveryApi.swipe(currentCard.id, direction);

      // Move to next card
      const nextIndex = currentIndex + 1;
      set({ currentIndex: nextIndex });

      // If match, save it
      if (result.match) {
        set({ lastMatch: result.match });
      }

      // Reload deck if running low
      if (nextIndex >= deck.length - 3) {
        get().loadDeck();
      }

      return result;
    } catch (error) {
      throw error;
    }
  },

  clearMatch: () => set({ lastMatch: null }),
}));
