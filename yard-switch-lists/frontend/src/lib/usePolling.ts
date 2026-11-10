import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Polls an endpoint. Polling rather than a long-lived stream, because the board
 * only needs a two-second freshness and a held-open connection would keep the
 * page from ever going network-idle.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const next = await fetcherRef.current()
      if (alive.current) {
        setData(next)
        setError(null)
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : 'Failed to load')
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    if (intervalMs <= 0) return () => void (alive.current = false)
    const timer = setInterval(() => void refresh(), intervalMs)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [intervalMs, refresh])

  return { data, error, refresh }
}
