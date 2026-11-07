/**
 * Fetch now, then refetch every `intervalMs` while the tab is visible.
 * Polling instead of a live stream keeps the console simple: delivery state
 * changes on the order of seconds, and every refetch goes through the same
 * org-scoped endpoints as the first load.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/services/api'

export interface Polled<T> {
  data: T | null
  error: string | null
  /** HTTP status of the last failed fetch (0 = network), or null after a success. */
  errorStatus: number | null
  loading: boolean
  reload: () => void
}

export function usePoll<T>(fetcher: () => Promise<T>, intervalMs = 2000, deps: unknown[] = []): Polled<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const depsKey = JSON.stringify(deps)

  const load = useCallback(async () => {
    try {
      const next = await fetcherRef.current()
      setData(next)
      setError(null)
      setErrorStatus(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setErrorStatus(err instanceof ApiError ? err.status : 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    setData(null)
    void load()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [load, intervalMs, depsKey])

  return { data, error, errorStatus, loading, reload: () => void load() }
}
