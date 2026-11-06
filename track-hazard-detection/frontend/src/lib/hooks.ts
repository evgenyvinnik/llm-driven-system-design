import { useEffect, useRef, useState } from 'react'

/** Fetches on mount and whenever deps change; keeps the previous data visible while refetching. */
export function useFetch<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const last = useRef(0)
  useEffect(() => {
    let cancelled = false
    // Live notices can arrive in bursts; coalesce refetches to at most ~3 per second.
    const wait = Math.max(0, 300 - (Date.now() - last.current))
    const timer = setTimeout(() => {
      last.current = Date.now()
      load()
        .then((d) => {
          if (!cancelled) {
            setData(d)
            setError(null)
          }
        })
        .catch((err: Error) => !cancelled && setError(err.message))
    }, wait)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { data, error, reload: () => setTick((t) => t + 1) }
}

/** Re-renders every `ms` so relative ages and countdowns stay current. */
export function useTicker(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
