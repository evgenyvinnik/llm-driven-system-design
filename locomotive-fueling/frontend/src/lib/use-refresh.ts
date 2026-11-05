/**
 * Fetch-and-refresh hook. Refetches when any of `triggers` changes
 * (live-store counters), coalescing bursts, and polls every `pollMs` while
 * the live stream is disconnected. With a `cacheKey`, the last good response
 * is kept in localStorage and served when the network is gone: a cab tablet
 * in dark territory still shows the last plan, labelled with its age.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveStore } from '@/stores/live-store'

interface Options {
  triggers?: unknown[]
  pollMs?: number
  cacheKey?: string
  /** Minimum gap between refetches caused by live events. */
  coalesceMs?: number
}

export interface Refreshed<T> {
  data: T | null
  error: string | null
  stale: boolean
  fetchedAt: number | null
  reload: () => void
}

function readCache<T>(key?: string): { data: T; at: number } | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as { data: T; at: number }) : null
  } catch {
    return null
  }
}

export function useRefresh<T>(fetcher: () => Promise<T>, opts: Options = {}): Refreshed<T> {
  const cached = readCache<T>(opts.cacheKey)
  const [data, setData] = useState<T | null>(cached?.data ?? null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(cached?.at ?? null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(Boolean(cached))
  const connected = useLiveStore((s) => s.connected)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const last = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    last.current = Date.now()
    try {
      const next = await fetcherRef.current()
      setData(next)
      setError(null)
      setStale(false)
      setFetchedAt(Date.now())
      if (opts.cacheKey) {
        try {
          localStorage.setItem(opts.cacheKey, JSON.stringify({ data: next, at: Date.now() }))
        } catch {
          // Storage full or blocked: the live view still works.
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
      setStale(true)
    }
  }, [opts.cacheKey])

  // Live-event refetches, coalesced.
  const triggerKey = JSON.stringify(opts.triggers ?? [])
  useEffect(() => {
    const gap = opts.coalesceMs ?? 1000
    const wait = Math.max(0, last.current + gap - Date.now())
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void load(), wait)
    return () => window.clearTimeout(timer.current)
  }, [triggerKey, load, opts.coalesceMs])

  // Polling fallback while the stream is down.
  useEffect(() => {
    if (connected) return
    const id = window.setInterval(() => void load(), opts.pollMs ?? 10_000)
    return () => window.clearInterval(id)
  }, [connected, load, opts.pollMs])

  return { data, error, stale, fetchedAt, reload: () => void load() }
}
