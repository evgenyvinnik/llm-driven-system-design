import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Suggestion } from '../types';
import { api } from '../services/api';

interface SearchState {
  // User
  userId: string;
  sessionId: string;

  // Search state
  query: string;
  suggestions: Suggestion[];
  isLoading: boolean;
  error: string | null;
  responseTime: number | null;

  // History
  recentSearches: string[];

  // Settings
  fuzzyEnabled: boolean;
  maxSuggestions: number;

  // Actions
  setQuery: (query: string) => void;
  search: (prefix: string) => Promise<void>;
  selectSuggestion: (phrase: string) => Promise<void>;
  clearSuggestions: () => void;
  toggleFuzzy: () => void;
  setMaxSuggestions: (max: number) => void;
}

// Generate or retrieve user/session IDs
const getUserId = (): string => {
  const stored = localStorage.getItem('typeahead_user_id');
  if (stored) return stored;
  const newId = uuidv4();
  localStorage.setItem('typeahead_user_id', newId);
  return newId;
};

const getSessionId = (): string => {
  const stored = sessionStorage.getItem('typeahead_session_id');
  if (stored) return stored;
  const newId = uuidv4();
  sessionStorage.setItem('typeahead_session_id', newId);
  return newId;
};

const getRecentSearches = (): string[] => {
  const stored = localStorage.getItem('typeahead_recent');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return [];
    }
  }
  return [];
};

const saveRecentSearch = (query: string, existing: string[]): string[] => {
  const filtered = existing.filter(q => q !== query);
  const updated = [query, ...filtered].slice(0, 10);
  localStorage.setItem('typeahead_recent', JSON.stringify(updated));
  return updated;
};

export const useSearchStore = create<SearchState>((set, get) => ({
  userId: getUserId(),
  sessionId: getSessionId(),
  query: '',
  suggestions: [],
  isLoading: false,
  error: null,
  responseTime: null,
  recentSearches: getRecentSearches(),
  fuzzyEnabled: false,
  maxSuggestions: 5,

  setQuery: (query: string) => {
    set({ query });
  },

  search: async (prefix: string) => {
    if (!prefix.trim()) {
      set({ suggestions: [], isLoading: false, error: null, responseTime: null });
      return;
    }

    set({ isLoading: true, error: null });

    try {
      const { userId, fuzzyEnabled, maxSuggestions } = get();
      const response = await api.getSuggestions(prefix, {
        userId,
        fuzzy: fuzzyEnabled,
        limit: maxSuggestions,
      });

      set({
        suggestions: response.suggestions,
        isLoading: false,
        responseTime: response.meta.responseTimeMs,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch suggestions',
        isLoading: false,
        suggestions: [],
      });
    }
  },

  selectSuggestion: async (phrase: string) => {
    const { userId, sessionId, recentSearches } = get();

    // Update local state
    const updated = saveRecentSearch(phrase, recentSearches);
    set({
      query: phrase,
      suggestions: [],
      recentSearches: updated,
    });

    // Log to backend
    try {
      await api.logSearch(phrase, userId, sessionId);
    } catch (error) {
      console.error('Failed to log search:', error);
    }
  },

  clearSuggestions: () => {
    set({ suggestions: [], error: null, responseTime: null });
  },

  toggleFuzzy: () => {
    set(state => ({ fuzzyEnabled: !state.fuzzyEnabled }));
  },

  setMaxSuggestions: (max: number) => {
    set({ maxSuggestions: max });
  },
}));
