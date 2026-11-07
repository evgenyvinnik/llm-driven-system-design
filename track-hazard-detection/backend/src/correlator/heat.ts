/**
 * Rail buckling ("sun kink") risk from rail temperature. Continuous welded rail
 * is laid at a rail neutral temperature (RNT); the further the rail runs above
 * it, the more compressive stress builds and the higher the buckling risk.
 * The risk band uses the worse of the current temperature and a short linear
 * projection of the trend (capped at one band above the current one), so a
 * rail heating fast is flagged before it gets there. Bands and horizons are
 * illustrative assumptions.
 * @module correlator/heat
 */
import { config } from '../shared/config.js'

export type HeatBand = 'normal' | 'watch' | 'elevated' | 'critical'
export const BAND_RANK: Record<HeatBand, number> = { normal: 0, watch: 1, elevated: 2, critical: 3 }

export interface HeatConfig {
  watchDelta: number
  elevatedDelta: number
  criticalDelta: number
  trendMinutes: number
  projectMinutes: number
}

export interface Sample {
  occurredAt: string
  tempF: number
}

export interface HeatAssessment {
  band: HeatBand
  currentF: number
  projectedF: number
  slopeFPerMin: number
  currentBand: HeatBand
  projectedBand: HeatBand
}

export function bandFor(deltaF: number, cfg: HeatConfig = config.heat): HeatBand {
  if (deltaF >= cfg.criticalDelta) return 'critical'
  if (deltaF >= cfg.elevatedDelta) return 'elevated'
  if (deltaF >= cfg.watchDelta) return 'watch'
  return 'normal'
}

/** Least-squares slope in °F per minute. */
export function slopePerMinute(samples: Sample[]): number {
  if (samples.length < 3) return 0
  const t0 = Date.parse(samples[0].occurredAt)
  const xs = samples.map((s) => (Date.parse(s.occurredAt) - t0) / 60_000)
  const ys = samples.map((s) => s.tempF)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

/**
 * Assesses one rail-temperature sensor from its samples (any order; late
 * samples simply join the series). Uses the samples within `trendMinutes` of
 * the newest one.
 */
export function assessHeat(samples: Sample[], neutralTempF: number, cfg: HeatConfig = config.heat): HeatAssessment | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  const newest = Date.parse(sorted[sorted.length - 1].occurredAt)
  const window = sorted.filter((s) => Date.parse(s.occurredAt) >= newest - cfg.trendMinutes * 60_000)
  const currentF = window[window.length - 1].tempF
  const slope = slopePerMinute(window)
  // Only a rising trend raises the projection; a cooling rail is judged on its current temperature.
  const projectedF = Math.round((currentF + Math.max(0, slope) * cfg.projectMinutes) * 10) / 10
  const currentBand = bandFor(currentF - neutralTempF, cfg)
  const projectedBand = bandFor(projectedF - neutralTempF, cfg)
  // The projection may raise the band by one step, never more: a trend is a warning, not a measurement.
  const order: HeatBand[] = ['normal', 'watch', 'elevated', 'critical']
  const capped = order[Math.min(BAND_RANK[projectedBand], BAND_RANK[currentBand] + 1)]
  const band = BAND_RANK[capped] > BAND_RANK[currentBand] ? capped : currentBand
  return { band, currentF, projectedF, slopeFPerMin: Math.round(slope * 100) / 100, currentBand, projectedBand }
}
