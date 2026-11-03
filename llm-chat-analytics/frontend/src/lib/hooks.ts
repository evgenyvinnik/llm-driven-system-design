import { useEffect, useState } from 'react'

/** The current time, re-read every `ms`. Resolved ranges only change when a boundary passes. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/**
 * Settles a fast-changing value. The UI shows the newest filters instantly;
 * requests follow the settled value, so a burst of clicks becomes one request.
 */
export function useDebounced<T>(value: T, ms: number, equal: (a: T, b: T) => boolean = Object.is): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (equal(value, settled)) return
    const id = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(id)
  }, [value, settled, ms, equal])
  return settled
}
