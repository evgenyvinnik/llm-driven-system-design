/**
 * useTypeahead - Core hook for typeahead functionality.
 * Integrates memory cache, IndexedDB, and network with ARIA state management.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../services/api.js';
import {
  getCachedSuggestions,
  cacheSuggestions,
  addToHistory,
  updatePopularity,
} from '../db/database.js';
import type { Suggestion, SuggestionsResponse } from '../types';

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
  /** Set dropdown open state */
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

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [error, setError] = useState<Error | null>(null);
  const [isCached, setIsCached] = useState(false);

  const debounceTimer = useRef<number | undefined>(undefined);
  const listboxId = useUniqueId('typeahead-listbox');

  // Fetch suggestions with multi-layer caching
  const fetchSuggestions = useCallback(
    async (prefix: string) => {
      if (prefix.length < minChars) {
        setSuggestions([]);
        setIsOpen(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        // Layer 1: Memory cache (fastest, already in api.ts)
        // The api.getSuggestions already checks memoryCache

        // Layer 2: IndexedDB (for offline support)
        const cachedFromDb = await getCachedSuggestions(prefix);
        if (cachedFromDb) {
          setSuggestions(cachedFromDb as Suggestion[]);
          setIsCached(true);
          setIsOpen(true);
          // Continue to fetch fresh data in background
        }

        // Layer 3: Network
        const response: SuggestionsResponse = await api.getSuggestions(prefix, {
          limit,
          userId,
          fuzzy,
        });

        setSuggestions(response.suggestions);
        setIsCached(response.meta.cached);
        setIsOpen(response.suggestions.length > 0);

        // Update IndexedDB cache
        await cacheSuggestions(
          prefix,
          response.suggestions.map((s) => ({
            phrase: s.phrase,
            count: s.count,
            score: s.score,
          }))
        );
      } catch (err) {
        // Don't show error for abort
        if ((err as Error).name === 'AbortError') {
          return;
        }
        setError(err as Error);

        // Try to use IndexedDB cache as fallback
        const fallback = await getCachedSuggestions(prefix);
        if (fallback) {
          setSuggestions(fallback as Suggestion[]);
          setIsCached(true);
          setIsOpen(true);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [limit, userId, fuzzy, minChars]
  );

  // Debounced query effect
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    if (!query.trim()) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    debounceTimer.current = window.setTimeout(() => {
      fetchSuggestions(query.trim());
    }, debounceMs);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [query, debounceMs, fetchSuggestions]);

  // Reset highlighted index when suggestions change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [suggestions]);

  // Select a suggestion
  const selectSuggestion = useCallback(
    (index: number) => {
      if (index >= 0 && index < suggestions.length) {
        const selected = suggestions[index];
        setQuery(selected.phrase);
        setIsOpen(false);
        setHighlightedIndex(-1);

        // Track in history and popularity
        addToHistory(selected.phrase);
        updatePopularity(selected.phrase);

        // Log to backend
        api.logSearch(selected.phrase, userId).catch(() => {});

        onSelect?.(selected.phrase);
      }
    },
    [suggestions, userId, onSelect]
  );

  // Submit current query
  const submitQuery = useCallback(() => {
    if (!query.trim()) return;

    setIsOpen(false);
    setHighlightedIndex(-1);

    // Track submission
    addToHistory(query);
    updatePopularity(query);
    api.logSearch(query, userId).catch(() => {});

    onSubmit?.(query);
  }, [query, userId, onSubmit]);

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isOpen) {
        if (event.key === 'ArrowDown' && suggestions.length > 0) {
          setIsOpen(true);
          setHighlightedIndex(0);
          event.preventDefault();
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
    [isOpen, suggestions.length, highlightedIndex, selectSuggestion, submitQuery]
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
