/**
 * useTypeahead - Core hook for typeahead functionality.
 * Integrates memory cache, IndexedDB, and network with ARIA state management.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../services/api.js';
import {
  getCachedSuggestions,
  cacheSuggestions,
  suggestionCacheKey,
  addToHistory,
  updatePopularity,
} from '../db/database.js';
import type { Suggestion, SuggestionsResponse } from '../types';

// IndexedDB is a best-effort layer: it can be unavailable (blocked storage, private modes,
// quota), and a failure there must never keep a request from reaching the network.
async function readIdbCache(key: string): Promise<Suggestion[] | null> {
  try {
    return await getCachedSuggestions(key);
  } catch {
    return null;
  }
}

async function writeIdbCache(key: string, suggestions: Suggestion[]): Promise<void> {
  try {
    await cacheSuggestions(key, suggestions);
  } catch {
    // Offline copy not stored; the online result is unaffected
  }
}

const ignoreIdbError = () => {};

export interface UseTypeaheadOptions {
  /** Debounce delay in milliseconds */
  debounceMs?: number;
  /** Max suggestions to fetch */
  limit?: number;
  /** User ID for personalization */
  userId?: string;
  /** Enable fuzzy matching */
  fuzzy?: boolean;
  /** Minimum characters before fetching */
  minChars?: number;
  /** Callback when suggestion is selected */
  onSelect?: (phrase: string) => void;
  /** Callback on search submit */
  onSubmit?: (query: string) => void;
}

export interface UseTypeaheadReturn {
  /** Current input value */
  query: string;
  /** Set input value */
  setQuery: (value: string) => void;
  /** Current suggestions */
  suggestions: Suggestion[];
  /** Whether suggestions are loading */
  isLoading: boolean;
  /** Whether dropdown is open */
  isOpen: boolean;
  /**
   * Set dropdown open state. Closing it (e.g. on blur) also keeps late fetch results from
   * reopening it until the query is edited.
   */
  setIsOpen: (open: boolean) => void;
  /** Currently highlighted index */
  highlightedIndex: number;
  /** Set highlighted index */
  setHighlightedIndex: (index: number) => void;
  /** Select a suggestion */
  selectSuggestion: (index: number) => void;
  /** Submit current query */
  submitQuery: () => void;
  /** Error if any */
  error: Error | null;
  /** Whether result came from cache */
  isCached: boolean;
  /** ARIA props for input element */
  inputProps: {
    role: 'combobox';
    'aria-expanded': boolean;
    'aria-controls': string;
    'aria-activedescendant': string | undefined;
    'aria-autocomplete': 'list';
    'aria-haspopup': 'listbox';
  };
  /** ARIA props for listbox */
  listboxProps: {
    role: 'listbox';
    id: string;
    'aria-label': string;
  };
  /** Get ARIA props for an option */
  getOptionProps: (index: number) => {
    role: 'option';
    id: string;
    'aria-selected': boolean;
  };
  /** Keyboard handlers */
  handleKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * Generate a unique ID for ARIA relationships.
 */
function useUniqueId(prefix: string): string {
  const idRef = useRef<string | undefined>(undefined);
  if (!idRef.current) {
    idRef.current = `${prefix}-${Math.random().toString(36).substr(2, 9)}`;
  }
  return idRef.current;
}

export function useTypeahead(options: UseTypeaheadOptions = {}): UseTypeaheadReturn {
  const {
    debounceMs = 150,
    limit = 5,
    userId,
    fuzzy = false,
    minChars = 1,
    onSelect,
    onSubmit,
  } = options;

  const [query, setQueryState] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpenState] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [error, setError] = useState<Error | null>(null);
  const [isCached, setIsCached] = useState(false);

  const debounceTimer = useRef<number | undefined>(undefined);
  // Sequence number of the latest fetch; every settle of an older fetch is ignored, so a late
  // response cannot overwrite newer results or reopen a list that was closed since
  const requestSeq = useRef(0);
  // Whether the latest fetch is waiting on the network (so cancelling has something to abort)
  const inFlight = useRef(false);
  // Query set by selectSuggestion: the effect does not fetch it, so the list stays closed
  const suppressedQuery = useRef<string | null>(null);
  // The list was closed explicitly (blur, Escape, Tab, selection, submit) since the user last
  // edited the query: a fetch that completes now refreshes the suggestions but does not reopen it
  const dismissed = useRef(false);
  const listboxId = useUniqueId('typeahead-listbox');

  // Editing the query un-dismisses the list; an explicit close dismisses it
  const setQuery = useCallback((value: string) => {
    dismissed.current = false;
    setQueryState(value);
  }, []);

  const setIsOpen = useCallback((open: boolean) => {
    dismissed.current = !open;
    setIsOpenState(open);
  }, []);

  // Open state driven by fetch results, which must not override an explicit close
  const showResults = useCallback((hasResults: boolean) => {
    if (!dismissed.current) setIsOpenState(hasResults);
  }, []);

  // Drop the pending debounce and the in-flight fetch (input cleared, selection, Escape/Tab)
  const cancelPending = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = undefined;
    }
    requestSeq.current++;
    if (inFlight.current) {
      inFlight.current = false;
      api.cancelSuggestions(listboxId); // optimization only; the sequence check is the guarantee
    }
    setIsLoading(false);
  }, [listboxId]);

  // Fetch suggestions with multi-layer caching
  const fetchSuggestions = useCallback(
    async (prefix: string) => {
      const seq = ++requestSeq.current;
      const isCurrent = () => seq === requestSeq.current;

      if (prefix.length < minChars) {
        // Also drops an older fetch still in flight, whose finally no longer clears isLoading
        cancelPending();
        setSuggestions([]);
        setIsOpenState(false);
        return;
      }

      const cacheKey = suggestionCacheKey(prefix, { limit, fuzzy, userId });
      setIsLoading(true);
      setError(null);

      try {
        // Layer 1: Memory cache (fastest, already in api.ts)
        // The api.getSuggestions already checks memoryCache

        // Layer 2: IndexedDB (for offline support)
        const cachedFromDb = await readIdbCache(cacheKey);
        if (!isCurrent()) return;
        if (cachedFromDb) {
          setSuggestions(cachedFromDb);
          setIsCached(true);
          showResults(cachedFromDb.length > 0);
          // Continue to fetch fresh data in background
        }

        // Layer 3: Network
        inFlight.current = true;
        const response: SuggestionsResponse = await api.getSuggestions(prefix, {
          limit,
          userId,
          fuzzy,
          group: listboxId,
        });
        if (!isCurrent()) return;

        setSuggestions(response.suggestions);
        setIsCached(response.meta.cached);
        showResults(response.suggestions.length > 0);

        // Update IndexedDB cache (not awaited: it must not delay or fail the online path)
        void writeIdbCache(cacheKey, response.suggestions);
      } catch (err) {
        // Superseded or cancelled requests are not errors
        if (!isCurrent() || (err as Error).name === 'AbortError') {
          return;
        }
        setError(err as Error);

        // Try to use IndexedDB cache as fallback
        const fallback = await readIdbCache(cacheKey);
        if (fallback && isCurrent()) {
          setSuggestions(fallback);
          setIsCached(true);
          showResults(fallback.length > 0);
        }
      } finally {
        if (isCurrent()) {
          inFlight.current = false;
          setIsLoading(false);
        }
      }
    },
    [limit, userId, fuzzy, minChars, listboxId, showResults, cancelPending]
  );

  // Debounced query effect
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // The query was just set by selecting a suggestion: fetching it would reopen the list
    const suppressed = suppressedQuery.current;
    suppressedQuery.current = null;
    if (suppressed !== null && query === suppressed) {
      return;
    }

    if (!query.trim()) {
      cancelPending();
      setSuggestions([]);
      setIsOpenState(false);
      return;
    }

    debounceTimer.current = window.setTimeout(() => {
      // trimStart, not trim: a trailing space marks a word boundary ("java " -> "java spring")
      fetchSuggestions(query.trimStart());
    }, debounceMs);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [query, debounceMs, fetchSuggestions, cancelPending]);

  // Reset highlighted index when suggestions change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [suggestions]);

  // Select a suggestion
  const selectSuggestion = useCallback(
    (index: number) => {
      if (index >= 0 && index < suggestions.length) {
        const selected = suggestions[index];
        cancelPending();
        suppressedQuery.current = selected.phrase;
        setQueryState(selected.phrase);
        setIsOpen(false);
        setHighlightedIndex(-1);

        // Track in history and popularity (best-effort, IndexedDB may be unavailable)
        addToHistory(selected.phrase).catch(ignoreIdbError);
        updatePopularity(selected.phrase).catch(ignoreIdbError);

        // Log to backend
        api.logSearch(selected.phrase, userId).catch(() => {});

        onSelect?.(selected.phrase);
      }
    },
    [suggestions, userId, onSelect, cancelPending, setIsOpen]
  );

  // Submit current query
  const submitQuery = useCallback(() => {
    if (!query.trim()) return;

    // A pending or in-flight fetch would reopen the list after the submit closed it
    cancelPending();
    setIsOpen(false);
    setHighlightedIndex(-1);

    // Track submission (IndexedDB is best-effort)
    addToHistory(query).catch(ignoreIdbError);
    updatePopularity(query).catch(ignoreIdbError);
    api.logSearch(query, userId).catch(() => {});

    onSubmit?.(query);
  }, [query, userId, onSubmit, cancelPending, setIsOpen]);

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Dismissing also drops the pending/in-flight fetch, or its result reopens the list
      if (event.key === 'Escape' || event.key === 'Tab') {
        cancelPending();
      }

      if (!isOpen) {
        if (event.key === 'ArrowDown' && suggestions.length > 0) {
          setIsOpen(true);
          setHighlightedIndex(0);
          event.preventDefault();
        } else if (event.key === 'Enter' && query.trim()) {
          // No list to pick from (no results, dismissed, or after a selection): Enter still
          // submits. Default is left alone so a surrounding form submits natively too.
          submitQuery();
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setHighlightedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
          break;

        case 'ArrowUp':
          event.preventDefault();
          setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
          break;

        case 'Enter':
          event.preventDefault();
          if (highlightedIndex >= 0) {
            selectSuggestion(highlightedIndex);
          } else {
            submitQuery();
          }
          break;

        case 'Escape':
          event.preventDefault();
          setIsOpen(false);
          setHighlightedIndex(-1);
          break;

        case 'Tab':
          setIsOpen(false);
          break;
      }
    },
    [
      isOpen,
      suggestions.length,
      query,
      highlightedIndex,
      selectSuggestion,
      submitQuery,
      cancelPending,
      setIsOpen,
    ]
  );

  // ARIA input props
  const inputProps = useMemo(
    () => ({
      role: 'combobox' as const,
      'aria-expanded': isOpen,
      'aria-controls': listboxId,
      'aria-activedescendant':
        highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined,
      'aria-autocomplete': 'list' as const,
      'aria-haspopup': 'listbox' as const,
    }),
    [isOpen, listboxId, highlightedIndex]
  );

  // ARIA listbox props
  const listboxProps = useMemo(
    () => ({
      role: 'listbox' as const,
      id: listboxId,
      'aria-label': 'Suggestions',
    }),
    [listboxId]
  );

  // ARIA option props generator
  const getOptionProps = useCallback(
    (index: number) => ({
      role: 'option' as const,
      id: `${listboxId}-option-${index}`,
      'aria-selected': index === highlightedIndex,
    }),
    [listboxId, highlightedIndex]
  );

  return {
    query,
    setQuery,
    suggestions,
    isLoading,
    isOpen,
    setIsOpen,
    highlightedIndex,
    setHighlightedIndex,
    selectSuggestion,
    submitQuery,
    error,
    isCached,
    inputProps,
    listboxProps,
    getOptionProps,
    handleKeyDown,
  };
}
