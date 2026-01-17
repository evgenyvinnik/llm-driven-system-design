import { useEffect, useCallback } from 'react';
import { useSpotlightStore } from '../stores/spotlightStore';

export function useKeyboardShortcut() {
  const { toggleSpotlight, isOpen, closeSpotlight, selectNext, selectPrevious, results, suggestions, query, selectedIndex, executeResult } = useSpotlightStore();

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Cmd/Ctrl + K to toggle spotlight
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      toggleSpotlight();
      return;
    }

    // Only handle these keys when spotlight is open
    if (!isOpen) return;

    // Escape to close
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSpotlight();
      return;
    }

    // Arrow down
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectNext();
      return;
    }

    // Arrow up
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectPrevious();
      return;
    }

    // Enter to execute
    if (e.key === 'Enter') {
      e.preventDefault();
      const items = query.trim().length > 0 ? results : suggestions;
      if (items[selectedIndex]) {
        executeResult(items[selectedIndex] as Parameters<typeof executeResult>[0]);
      }
      return;
    }
  }, [isOpen, toggleSpotlight, closeSpotlight, selectNext, selectPrevious, results, suggestions, query, selectedIndex, executeResult]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
