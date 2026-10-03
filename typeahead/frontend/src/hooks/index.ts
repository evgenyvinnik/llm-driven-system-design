import { useEffect, useRef, useMemo } from 'react';

/**
 * useDebounce - Debounce a callback function.
 * The returned function has cancel(), which drops a pending call (e.g. when the input is
 * cleared or a suggestion is selected, so a stale search does not fire afterwards).
 */
export function useDebounce<T extends (...args: never[]) => void>(
  callback: T,
  delay: number
): T & { cancel: () => void } {
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return useMemo(() => {
    const cancel = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
      }
    };

    const debounced = (...args: Parameters<T>) => {
      cancel();
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = undefined;
        callback(...args);
      }, delay);
    };

    return Object.assign(debounced, { cancel }) as unknown as T & { cancel: () => void };
  }, [callback, delay]);
}

/**
 * useClickOutside - Detect clicks outside an element
 */
export function useClickOutside(
  ref: React.RefObject<HTMLElement>,
  handler: () => void
): void {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        handler();
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, [ref, handler]);
}

/**
 * useKeyboard - Handle keyboard navigation
 */
export function useKeyboard(
  handlers: {
    onArrowDown?: () => void;
    onArrowUp?: () => void;
    onEnter?: () => void;
    onEscape?: () => void;
    onTab?: () => void;
  },
  isActive: boolean
): void {
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          handlers.onArrowDown?.();
          break;
        case 'ArrowUp':
          event.preventDefault();
          handlers.onArrowUp?.();
          break;
        case 'Enter':
          handlers.onEnter?.();
          break;
        case 'Escape':
          handlers.onEscape?.();
          break;
        case 'Tab':
          handlers.onTab?.();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handlers, isActive]);
}
