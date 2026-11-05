/**
 * Planner and safety parameters. Defaults here; admins override them in the
 * model_params table. Values are illustrative assumptions.
 * @module domain/params
 */
export interface ModelParams {
  /** Per-unit reserve as a share of tank capacity. */
  reservePct: number
  /** Absolute per-unit reserve floor, gallons. */
  reserveMinGal: number
  /** Forecast burn is inflated by this much when checking the reserve (planning against roughly p90 burn). */
  safetyMarginPct: number
  /** Cost of one train-hour of delay (crew, locomotive time, network knock-on). */
  delayCostPerHour: number
  /** Fixed cost of stopping a train at all (braking, restart fuel, risk). */
  stopPenalty: number
  /** Switch plans only when the candidate saves more than max(abs, pct × current cost). */
  hysteresisAbs: number
  hysteresisPct: number
  /** Re-plan when train-level burn calibration moves more than this from what the plan assumed. */
  deviationBand: number
  /** Place DTL orders once the stop is within this many hours. */
  orderWindowHours: number
  /** Credit fuel left at the destination (it fuels the next trip). */
  valueRemainingFuel: boolean
  /**
   * The credit is the destination pad price minus this discount: the next trip
   * can buy elsewhere, so leftover fuel is worth less than the posted price.
   * Zero makes the optimizer tanker aggressively into expensive terminals.
   */
  terminalDiscountPerGal: number
  /** Fuel-level grid for the optimizer, train-gallons. */
  gridGal: number
  /** Extra bar for changing an accepted plan (crew re-briefing, reservations released, disruption). */
  acceptedChangeCost: number
  /** Optimizer time budget; past it the planner falls back to greedy, then to the last good plan. */
  optimizerBudgetMs: number
  /** Safety margin added per hour of fuel-data age (dark territory, failed uplink). */
  stalenessMarginPerHour: number
  /** Cap on all margin widening combined. */
  maxExtraMargin: number
  /** An accepted pad slot is released if the train hasn't arrived this long after the slot ends. */
  reservationGraceHours: number
}

export const DEFAULT_PARAMS: ModelParams = {
  reservePct: 0.1,
  reserveMinGal: 500,
  safetyMarginPct: 0.1,
  delayCostPerHour: 600,
  stopPenalty: 250,
  hysteresisAbs: 150,
  hysteresisPct: 0.02,
  deviationBand: 0.12,
  orderWindowHours: 12,
  valueRemainingFuel: true,
  terminalDiscountPerGal: 0.25,
  gridGal: 25,
  acceptedChangeCost: 400,
  optimizerBudgetMs: 500,
  stalenessMarginPerHour: 0.03,
  maxExtraMargin: 0.2,
  reservationGraceHours: 2,
}

export function mergeParams(rows: { key: string; value: unknown }[]): ModelParams {
  const out: ModelParams = { ...DEFAULT_PARAMS }
  for (const row of rows) {
    if (row.key in out && typeof row.value === typeof (DEFAULT_PARAMS as unknown as Record<string, unknown>)[row.key]) {
      ;(out as unknown as Record<string, unknown>)[row.key] = row.value
    }
  }
  return out
}
