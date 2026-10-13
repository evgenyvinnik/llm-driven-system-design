import { useCallback, useRef, useState } from 'react';
import type { ToggleResult } from '../services/api';

interface OptimisticToggleOptions {
  initialActive: boolean;
  /** Optional counter shown next to the toggle (e.g. likes). */
  initialCount?: number;
  activate: () => Promise<ToggleResult>;
  deactivate: () => Promise<ToggleResult>;
}

/**
 * Optimistic on/off toggle for likes and saves.
 *
 * The UI flips immediately and the request runs in the background:
 * - while a request is in flight further taps are ignored, so a double-tap can't send
 *   like + unlike out of order;
 * - on failure the state and count roll back and `error` explains why;
 * - when the server answers `idempotent: true` (it already had that state, e.g. liked in another
 *   tab) the state stays but the optimistic +1/-1 is undone, because the server's count already
 *   included it.
 */
export function useOptimisticToggle({ initialActive, initialCount = 0, activate, deactivate }: OptimisticToggleOptions) {
  const [active, setActive] = useState(initialActive);
  const [count, setCount] = useState(initialCount);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const toggle = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;

    const next = !active;
    const delta = next ? 1 : -1;
    setActive(next);
    setCount((value) => value + delta);
    setError(null);

    try {
      const result = await (next ? activate() : deactivate());
      if (result?.idempotent) {
        setCount((value) => value - delta);
      }
    } catch (err) {
      setActive(!next);
      setCount((value) => value - delta);
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      inFlight.current = false;
    }
  }, [active, activate, deactivate]);

  return { active, count, error, toggle };
}
