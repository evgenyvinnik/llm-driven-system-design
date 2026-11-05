/**
 * Detector health. A biased detector shifts absolute temperatures; a silent one
 * leaves a coverage gap; an offline gateway delays data that will still come.
 * Each is detected from the data itself: bias by comparing a detector's train
 * medians with its neighbours' for the same trains (ambient, load and speed
 * cancel), silence by trains that were seen on both sides but not at the detector.
 * @module analyzer/detector-health
 */
import type { Direction } from '../shared/domain.js'

export type DetectorStatus = 'ok' | 'offline' | 'silent' | 'biased'

/** This detector's train median above ambient minus the mean of its neighbours' for the same train. */
export function biasSample(center: number, left: number | null, right: number | null): number | null {
  const neighbours = [left, right].filter((v): v is number => v !== null)
  if (neighbours.length < 2) return null
  return center - neighbours.reduce((s, v) => s + v, 0) / neighbours.length
}

export function biasEstimate(samples: number[], alarmF: number, minSamples: number): { offset: number | null; n: number; biased: boolean } {
  const recent = samples.slice(-8)
  if (recent.length === 0) return { offset: null, n: 0, biased: false }
  const offset = recent.reduce((s, v) => s + v, 0) / recent.length
  return { offset, n: recent.length, biased: recent.length >= minSamples && Math.abs(offset) >= alarmF }
}

export interface RouteDetector {
  id: string
  milepost: number
}

/** Detectors between origin and destination, in the order the train reaches them. */
export function detectorsOnRoute<T extends RouteDetector>(detectors: T[], direction: Direction, originMp: number, destinationMp: number): T[] {
  const lo = Math.min(originMp, destinationMp)
  const hi = Math.max(originMp, destinationMp)
  const within = detectors.filter((d) => d.milepost > lo && d.milepost < hi)
  return within.sort((a, b) => (direction === 'EB' ? a.milepost - b.milepost : b.milepost - a.milepost))
}

/**
 * Every detector the train should already have passed (up to the furthest one
 * it was seen at) is either received or missing. Recomputed from the full set of
 * observed detectors each time, so late data flips "missing" back to "received".
 */
export function expectedPassStatuses(route: RouteDetector[], observed: Set<string>): Array<{ detectorId: string; status: 'missing' | 'received' }> {
  let furthest = -1
  route.forEach((d, i) => {
    if (observed.has(d.id)) furthest = i
  })
  return route.slice(0, furthest + 1).map((d) => ({ detectorId: d.id, status: observed.has(d.id) ? 'received' : 'missing' }))
}

export function detectorStatus(input: {
  lastHeardAtMs: number | null
  nowMs: number
  offlineAfterMs: number
  missedRecent: number
  biased: boolean
  biasOffset: number | null
}): { status: DetectorStatus; reason: string | null } {
  if (input.lastHeardAtMs === null || input.nowMs - input.lastHeardAtMs > input.offlineAfterMs) {
    return { status: 'offline', reason: 'No gateway heartbeat: data may be buffered at the site and arrive late' }
  }
  if (input.missedRecent >= 2) {
    return { status: 'silent', reason: `${input.missedRecent} trains seen on both sides were not reported: coverage gap` }
  }
  if (input.biased && input.biasOffset !== null) {
    const dir = input.biasOffset < 0 ? 'low' : 'high'
    return { status: 'biased', reason: `Reads ${Math.abs(Math.round(input.biasOffset))}°F ${dir} vs neighbouring detectors on the same trains` }
  }
  return { status: 'ok', reason: null }
}
