/**
 * Uncertain inputs still get a recommendation, with a wider safety margin and
 * an honest confidence label. Each source of doubt widens the margin the
 * reserve check uses and adds a plain-language assumption the UI shows:
 * - stale fuel data (dark territory, failed uplink): the train has burned an
 *   unknown amount since its last reading,
 * - burn running away from the model (the forecast itself is in question),
 * - units whose level is dead-reckoned because their sensor is faulty,
 * - a suspected leak (that unit's burn could still be rising).
 * @module planner/confidence
 */

export interface UncertaintyInputs {
  baseMarginPct: number
  dataAgeHours: number
  trainCalibration: number
  sensorSuspectUnits: string[]
  leakSuspectUnits: string[]
  stalenessMarginPerHour: number
  maxExtraMargin: number
}

export interface Confidence {
  marginPct: number
  confidence: 'high' | 'medium' | 'low'
  assumptions: string[]
}

const pct = (x: number) => `${Math.round(x * 100)}%`

export function assessConfidence(u: UncertaintyInputs): Confidence {
  let extra = 0
  const assumptions: string[] = []
  if (u.dataAgeHours > 0.25) {
    const add = u.dataAgeHours * u.stalenessMarginPerHour
    extra += add
    assumptions.push(`Fuel data is ${u.dataAgeHours.toFixed(1)} h old; position and levels assumed unchanged since (+${pct(add)} margin)`)
  }
  const drift = Math.abs(u.trainCalibration - 1)
  if (drift > 0.1) {
    const add = Math.min(0.1, drift / 2)
    extra += add
    assumptions.push(`Burn is running ${u.trainCalibration > 1 ? '+' : '-'}${pct(drift)} vs the model; forecast scaled by measured burn (+${pct(add)} margin)`)
  }
  if (u.sensorSuspectUnits.length) {
    extra += 0.05
    assumptions.push(`Level of unit ${u.sensorSuspectUnits.join(', ')} is dead-reckoned from throttle notch (sensor faulty) (+5% margin)`)
  }
  if (u.leakSuspectUnits.length) {
    extra += 0.05
    assumptions.push(`Unit ${u.leakSuspectUnits.join(', ')} may be leaking; its burn share uses the measured rate (+5% margin)`)
  }
  extra = Math.min(u.maxExtraMargin, extra)
  const marginPct = u.baseMarginPct + extra
  assumptions.unshift(`Reserve checked against forecast burn +${pct(marginPct)} (roughly p90)`)
  const confidence = extra >= 0.1 ? 'low' : extra > 0.02 ? 'medium' : 'high'
  return { marginPct, confidence, assumptions }
}
