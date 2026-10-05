import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Suggestion } from '../types';
import { api } from '../services/api';
import {
  recordError,
  recordInputCleared,
  recordKeyPress,
  recordLookup,
  recordRequestSent,
  recordSelection,
  recordSuggestionsDisplayed,
} from '../services/performance';

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

// Storage can be unavailable (site data blocked, some private modes), and then merely reading
// window.localStorage throws. This runs at module load, so an unguarded access blanks every
// route; fall back to in-memory values instead.
const readStorage = (getStorage: () => Storage, key: string): string | null => {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (getStorage: () => Storage, key: string, value: string): void => {
  try {
    getStorage().setItem(key, value);
  } catch {
    // Not persisted; the value still lives in the store for this page load
  }
};

// Generate or retrieve user/session IDs
const getUserId = (): string => {
  const stored = readStorage(() => localStorage, 'typeahead_user_id');
  if (stored) return stored;
  const newId = uuidv4();
  writeStorage(() => localStorage, 'typeahead_user_id', newId);
  return newId;
};

const getSessionId = (): string => {
  const stored = readStorage(() => sessionStorage, 'typeahead_session_id');
  if (stored) return stored;
  const newId = uuidv4();
  writeStorage(() => sessionStorage, 'typeahead_session_id', newId);
  return newId;
};

const getRecentSearches = (): string[] => {
  const stored = readStorage(() => localStorage, 'typeahead_recent');
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
};

const saveRecentSearch = (query: string, existing: string[]): string[] => {
  const filtered = existing.filter(q => q !== query);
  const updated = [query, ...filtered].slice(0, 10);
  writeStorage(() => localStorage, 'typeahead_recent', JSON.stringify(updated));
  return updated;
};

// Sequence number of the latest search. Every settle (success or error) of an older search is
// dropped, so a slow response can never overwrite newer results, a cleared input, or a selection.
let searchSeq = 0;

// Phrase just selected or submitted, until the query is edited again. A debounced search for
// that same text (typed in full, then Enter inside the debounce window) must not reopen the list.
let selectedQuery: string | null = null;

// performance.now() of the keystroke that set the current query (null once cleared), so a
// search's paint is measured from the keystroke that produced it, not a later one
let lastKeyAt: number | null = null;

// A frame later than this means the tab was hidden or blocked while the list was painted
const MAX_PAINT_DELAY_MS = 100;

/**
 * Record keystroke-to-suggestions once the list for keyAt is painted (the next frame), unless
 * the tab is hidden (frames are paused) or the query changed in between.
 */
const measurePaint = (keyAt: number, prefix: string, getQuery: () => string): void => {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const scheduledAt = performance.now();
  requestAnimationFrame(() => {
    if (performance.now() - scheduledAt > MAX_PAINT_DELAY_MS) return;
    if (getQuery().trim() !== prefix.trim()) return;
    recordSuggestionsDisplayed(keyAt);
  });
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

/** Typeahead search state with query suggestions, history tracking, fuzzy matching, and trending phrases. */
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
    selectedQuery = null;
    if (query.trim()) {
      lastKeyAt = recordKeyPress();
    } else {
      lastKeyAt = null;
      recordInputCleared();
    }
    set({ query });
  },

  search: async (prefix: string) => {
    // Callers set the query before searching it. A debounced call that fires after the input
    // was cleared or a suggestion was selected describes a query the user has moved past.
    if (prefix.trim() !== get().query.trim()) return;
    if (selectedQuery !== null && prefix.trim() === selectedQuery.trim()) return;

    const seq = ++searchSeq;

    if (!prefix.trim()) {
      api.cancelSuggestions();
      set({ suggestions: [], isLoading: false, error: null, responseTime: null });
      return;
    }

    set({ isLoading: true, error: null });

    // The keystroke this search answers (a settings change re-runs the query without one)
    const keyAt = lastKeyAt;

    try {
      const { userId, fuzzyEnabled, maxSuggestions } = get();
      const response = await api.getSuggestions(prefix, {
        userId,
        fuzzy: fuzzyEnabled,
        limit: maxSuggestions,
        onRequestSent: recordRequestSent,
      });

      if (seq !== searchSeq) return; // superseded

      recordLookup(response.meta.clientLatencyMs ?? 0, response.meta.clientCache === true);
      set({
        suggestions: response.suggestions,
        isLoading: false,
        error: null,
        responseTime: response.meta.responseTimeMs,
      });
      if (keyAt !== null && get().query.trim() === prefix.trim()) {
        measurePaint(keyAt, prefix, () => get().query);
      }
    } catch (error) {
      if (seq !== searchSeq) return; // superseded: its abort is not an error

      if (isAbortError(error)) {
        // Cancelled from elsewhere without a newer search: stop the spinner, keep the list
        set({ isLoading: false });
        return;
      }

      recordError();
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch suggestions',
        isLoading: false,
        suggestions: [],
      });
    }
  },

  selectSuggestion: async (phrase: string) => {
    const { userId, sessionId, recentSearches, query, suggestions } = get();

    // Drop any in-flight or still-debounced search so it cannot refill the list after the selection
    searchSeq++;
    selectedQuery = phrase;
    api.cancelSuggestions();
    // Only a pick from the list for what was typed ends a typed interaction (not a trending or
    // recent-search pick)
    recordSelection(query.trim() !== '' && suggestions.some((s) => s.phrase === phrase));
    lastKeyAt = null;

    // Update local state
    const updated = saveRecentSearch(phrase, recentSearches);
    set({
      query: phrase,
      suggestions: [],
      isLoading: false,
      error: null,
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
    // Drop any in-flight search so a late response cannot refill a cleared input
    searchSeq++;
    api.cancelSuggestions();
    set({ suggestions: [], isLoading: false, error: null, responseTime: null });
  },

  toggleFuzzy: () => {
    set(state => ({ fuzzyEnabled: !state.fuzzyEnabled }));
  },

  setMaxSuggestions: (max: number) => {
    set({ maxSuggestions: max });
  },
}));
