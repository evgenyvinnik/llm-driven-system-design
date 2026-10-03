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
