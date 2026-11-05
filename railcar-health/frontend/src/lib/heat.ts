/**
 * Sequential one-hue (warm) ramp for bearing temperatures: light = cool, dark
 * = hot. Status colours stay reserved for risk tiers.
 */
const RAMP = ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#ea580c', '#c2410c', '#9a3412', '#7c2d12']

export function heatColor(value: number | null, min: number, max: number): string {
  if (value === null || Number.isNaN(value)) return '#e2e8f0'
  const t = Math.min(1, Math.max(0, (value - min) / (max - min)))
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
}

export const HEAT_RAMP = RAMP

export type HeatMode = 'ambient' | 'median'
export const HEAT_SCALE: Record<HeatMode, [number, number]> = { ambient: [20, 200], median: [-10, 90] }
