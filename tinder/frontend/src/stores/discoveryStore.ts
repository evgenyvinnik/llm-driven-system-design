import { create } from 'zustand';
import type { DiscoveryCard, SwipeResult } from '../types';
import { discoveryApi } from '../services/api';

/**
 * Discovery store state and actions interface.
 * Manages the swipe deck, current card position, and match detection.
 */
interface DiscoveryState {
  /** Array of discovery cards in the current deck */
  deck: DiscoveryCard[];
  /** Index of the current card being shown */
  currentIndex: number;
  /** Whether deck is loading */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;
  /** Most recent match (shown in match modal) */
  lastMatch: SwipeResult['match'] | null;

  /** Fetches a new deck of potential matches */
  loadDeck: () => Promise<void>;
  /** Processes a swipe action and advances to next card */
  swipe: (direction: 'like' | 'pass') => Promise<SwipeResult>;
  /** Clears the last match (after modal dismissed) */
  clearMatch: () => void;
}

/**
 * Zustand store for discovery/swiping functionality.
 * Manages the deck of potential matches, handles swipe actions,
 * and detects matches for modal display.
 */
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
