/**
 * Fetch now, then refetch every `intervalMs` while the tab is visible. Run state changes on
 * the scale of seconds, so polling keeps these screens simple; only the live log view holds a
 * connection open.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/services/api'

export interface Polled<T> {
  data: T | null
  error: string | null
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
  // A response from before the dependencies changed must not overwrite the new screen.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = generation.current
    try {
      const next = await fetcherRef.current()
      if (mine !== generation.current) return
      setData(next)
      setError(null)
      setErrorStatus(null)
    } catch (err) {
      if (mine !== generation.current) return
      setError(err instanceof Error ? err.message : 'Request failed')
      setErrorStatus(err instanceof ApiError ? err.status : 0)
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    generation.current++
    setLoading(true)
    setData(null)
    void load()
    if (intervalMs <= 0) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [load, intervalMs, depsKey])

  return { data, error, errorStatus, loading, reload: () => void load() }
}
