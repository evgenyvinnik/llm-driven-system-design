import { useEffect, useState } from 'react'

/**
 * Tracks an element's width so SVG charts can draw at real pixel size (no
 * stretched text). Uses a callback ref, so it attaches whenever the element
 * mounts, even if the component rendered a placeholder first.
 */
export function useWidth<T extends HTMLElement>(fallback = 800) {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    if (!el) return
    setWidth(Math.max(320, Math.floor(el.getBoundingClientRect().width)))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return { ref: setEl, width }
}
