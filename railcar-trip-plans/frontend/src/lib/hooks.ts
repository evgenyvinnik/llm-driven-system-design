import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Fetches on mount and every `intervalMs` (read models are eventually consistent; polling is the simplest
 * honest way to show them converge). Keeps the last good data while a refresh is in flight.
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const loadRef = useRef(load)
  loadRef.current = load
  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    }
  }, [])
  useEffect(() => {
    setData(null)
    void refresh()
    if (intervalMs <= 0) return
    const timer = setInterval(() => void refresh(), intervalMs)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error, refresh }
}
