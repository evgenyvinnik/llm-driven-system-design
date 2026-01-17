import { useState, useEffect, useCallback, useRef } from 'react';
import { searchApi } from '@/services/api';

export function useAutocomplete(minChars = 2, debounceMs = 200) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < minChars) {
      setSuggestions([]);
      return;
    }

    setIsLoading(true);
    try {
      const result = await searchApi.autocomplete(q);
      setSuggestions(result.suggestions);
    } catch {
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  }, [minChars]);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      fetchSuggestions(query);
    }, debounceMs);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [query, debounceMs, fetchSuggestions]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Escape':
        setSuggestions([]);
        setSelectedIndex(-1);
        break;
    }
  }, [suggestions.length]);

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setSelectedIndex(-1);
  }, []);

  return {
    query,
    setQuery,
    suggestions,
    isLoading,
    selectedIndex,
    setSelectedIndex,
    handleKeyDown,
    clearSuggestions,
    selectedSuggestion: selectedIndex >= 0 ? suggestions[selectedIndex] : null,
  };
}
