import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from '@/services/api'

/**
 * Short polling for snapshot data (admin views). Overlapping polls are
 * skipped, polling pauses while the tab is hidden, and the last good data is
 * kept on error so a blip doesn't blank the page.
 */
export function usePoll<T>(load: () => Promise<T>, everyMs: number) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const busy = useRef(false)
  const loadRef = useRef(load)
  loadRef.current = load

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      setData(await loadRef.current())
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Request failed')
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, everyMs)
    return () => clearInterval(t)
  }, [refresh, everyMs])

  return { data, error, updatedAt, refresh }
}
