/**
 * Passage grouping and popular-highlight aggregation (pure functions, used by the worker)
 * @module shared/passage
 */

/** Width of the location windows that near-identical selections are snapped to. */
export const PASSAGE_WINDOW = 100

/**
 * Maps a highlight's location range to the window-aligned passage it belongs to.
 * Readers rarely select exactly the same characters; snapping both ends outward to the
 * window grid groups "the same sentence, give or take a word" under one passage id.
 */
export function passageIdFor(start: number, end: number): string {
  const windowStart = Math.floor(start / PASSAGE_WINDOW) * PASSAGE_WINDOW
  const windowEnd = Math.max(windowStart + PASSAGE_WINDOW, Math.ceil(end / PASSAGE_WINDOW) * PASSAGE_WINDOW)
  return `${windowStart}-${windowEnd}`
}

/** One public highlight from a reader who consents to aggregation. */
export interface Contribution {
  userId: string
  locationStart: number
  locationEnd: number
  text: string
  createdAt: Date
}

/** A passage as published in popular_highlights. */
export interface PassageAggregate {
  passageId: string
  readerCount: number
  passageText: string
  locationStart: number
  locationEnd: number
  lastContributionAt: Date
}

interface Group {
  readers: Set<string>
  texts: Map<string, { readers: Set<string>; start: number; end: number }>
  lastContributionAt: Date
}

/**
 * Groups contributions into passages, counts DISTINCT readers (one reader highlighting a
 * passage twice is still one reader) and drops every passage below `minReaders`, so a
 * sub-threshold count never leaves this function. The displayed text is the exact selection
 * most readers made; ties go to the shorter text, then alphabetical, so output is deterministic.
 */
export function aggregatePassages(contributions: Contribution[], minReaders: number): PassageAggregate[] {
  const groups = new Map<string, Group>()

  for (const c of contributions) {
    const passageId = passageIdFor(c.locationStart, c.locationEnd)
    let group = groups.get(passageId)
    if (!group) {
      group = { readers: new Set(), texts: new Map(), lastContributionAt: c.createdAt }
      groups.set(passageId, group)
    }
    group.readers.add(c.userId)
    if (c.createdAt > group.lastContributionAt) group.lastContributionAt = c.createdAt

    const text = c.text.trim()
    const variant = group.texts.get(text)
    if (variant) {
      variant.readers.add(c.userId)
      variant.start = Math.min(variant.start, c.locationStart)
      variant.end = Math.max(variant.end, c.locationEnd)
    } else {
      group.texts.set(text, { readers: new Set([c.userId]), start: c.locationStart, end: c.locationEnd })
    }
  }

  const published: PassageAggregate[] = []
  for (const [passageId, group] of groups) {
    if (group.readers.size < minReaders) continue
    const [text, variant] = [...group.texts.entries()].sort(
      ([textA, a], [textB, b]) =>
        b.readers.size - a.readers.size || textA.length - textB.length || textA.localeCompare(textB)
    )[0]
    published.push({
      passageId,
      readerCount: group.readers.size,
      passageText: text,
      locationStart: variant.start,
      locationEnd: variant.end,
      lastContributionAt: group.lastContributionAt,
    })
  }

  return published.sort((a, b) => b.readerCount - a.readerCount || a.passageId.localeCompare(b.passageId))
}
