import { useEffect, useRef, useState } from 'react'

/**
 * Loads on mount and every `intervalMs` (when given), keeping the previous
 * data visible while refetching. Polling pauses while the tab is hidden.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number | null, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (document.hidden) return
      loadRef
        .current()
        .then((d) => {
          if (!cancelled) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => !cancelled && setError(err.message))
    }
    run()
    const id = intervalMs ? setInterval(run, intervalMs) : undefined
    return () => {
      cancelled = true
      if (id) clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps])
  return { data, error, reload: () => setTick((t) => t + 1) }
}

/** Re-renders every `ms` so countdowns and ages stay current. */
export function useTicker(ms = 1000): void {
  const [, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}
