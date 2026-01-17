import { create } from 'zustand';
import { SearchResult, Suggestion } from '../types/search';
import { search, getProactiveSuggestions, recordActivity, recordAppLaunch } from '../services/api';

interface SpotlightState {
  // Modal state
  isOpen: boolean;
  openSpotlight: () => void;
  closeSpotlight: () => void;
  toggleSpotlight: () => void;

  // Search state
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  isLoading: boolean;
  error: string | null;

  // Selection
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  selectNext: () => void;
  selectPrevious: () => void;

  // Suggestions
  suggestions: Suggestion[];
  loadSuggestions: () => Promise<void>;

  // Actions
  performSearch: (query: string) => Promise<void>;
  executeResult: (result: SearchResult) => void;
  clear: () => void;
}

export const useSpotlightStore = create<SpotlightState>((set, get) => ({
  // Modal state
  isOpen: false,
  openSpotlight: () => {
    set({ isOpen: true });
    get().loadSuggestions();
  },
  closeSpotlight: () => {
    set({ isOpen: false });
    get().clear();
  },
  toggleSpotlight: () => {
    const isOpen = get().isOpen;
    if (isOpen) {
      get().closeSpotlight();
    } else {
      get().openSpotlight();
    }
  },

  // Search state
  query: '',
  setQuery: (query) => {
    set({ query });
    if (query.trim().length > 0) {
      get().performSearch(query);
    } else {
      set({ results: [], selectedIndex: 0 });
    }
  },
  results: [],
  isLoading: false,
  error: null,

  // Selection
  selectedIndex: 0,
  setSelectedIndex: (index) => set({ selectedIndex: index }),
  selectNext: () => {
    const { selectedIndex, results, suggestions, query } = get();
    const items = query.trim().length > 0 ? results : suggestions;
    const maxIndex = items.length - 1;
    set({ selectedIndex: Math.min(selectedIndex + 1, maxIndex) });
  },
  selectPrevious: () => {
    const { selectedIndex } = get();
    set({ selectedIndex: Math.max(selectedIndex - 1, 0) });
  },

  // Suggestions
  suggestions: [],
  loadSuggestions: async () => {
    try {
      const { suggestions } = await getProactiveSuggestions();
      set({ suggestions });
    } catch {
      console.error('Failed to load suggestions');
    }
  },

  // Actions
  performSearch: async (query) => {
    if (query.trim().length === 0) {
      set({ results: [], isLoading: false });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      const response = await search(query);
      set({ results: response.results, isLoading: false, selectedIndex: 0 });
    } catch (err) {
      set({ error: 'Search failed', isLoading: false });
      console.error('Search error:', err);
    }
  },

  executeResult: (result) => {
    // Record activity
    if (result.type === 'apps' && result.bundle_id) {
      recordAppLaunch(result.bundle_id);
    } else {
      recordActivity(result.type, result.id, result.name);
    }

    // Handle different result types
    switch (result.type) {
      case 'web':
        if (result.url) {
          window.open(result.url, '_blank');
        }
        break;
      case 'files':
        // In a real app, this would open the file
        console.log('Opening file:', result.path);
        break;
      case 'apps':
        // In a real app, this would launch the app
        console.log('Launching app:', result.bundle_id);
        break;
      case 'contacts':
        // Could open mail client or show contact info
        console.log('Opening contact:', result.name, result.email);
        break;
      case 'calculation':
      case 'conversion':
        // Copy result to clipboard
        if (result.value) {
          navigator.clipboard.writeText(String(result.value));
        }
        break;
    }

    get().closeSpotlight();
  },

  clear: () => {
    set({
      query: '',
      results: [],
      selectedIndex: 0,
      error: null,
    });
  },
}));
