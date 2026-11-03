/**
 * Coalesces high-frequency stream deltas into one store update per animation
 * frame. Tokens arrive 20 to 100 times a second, across possibly several
 * generations; committing each one would re-render (and re-parse markdown)
 * far more often than the screen can paint. Instead, text accumulates in a
 * plain buffer and is committed once per frame, for all generations at once.
 *
 * Hidden tabs don't run animation frames, so there the flush falls back to a
 * slow timer: state stays current (a finished answer still lands) without
 * spending frames nobody sees.
 */
export class FrameBatcher<T> {
  private pending = new Map<string, T[]>()
  private scheduled = false

  constructor(private commit: (batch: Map<string, T[]>) => void) {}

  push(key: string, item: T): void {
    const list = this.pending.get(key)
    if (list) list.push(item)
    else this.pending.set(key, [item])
    this.schedule()
  }

  /** Commits immediately (used before applying an end event, so no text is left behind). */
  flush(): void {
    this.scheduled = false
    if (this.pending.size === 0) return
    const batch = this.pending
    this.pending = new Map()
    this.commit(batch)
  }

  drop(key: string): void {
    this.pending.delete(key)
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    const hidden = typeof document !== 'undefined' && document.hidden
    if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.flush())
    else setTimeout(() => this.flush(), hidden ? 500 : 16)
  }
}
