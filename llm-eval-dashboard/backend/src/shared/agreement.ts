/**
 * Judge-vs-human agreement. Pure.
 *
 * Agreement on items picked BECAUSE the judge was unsure (low confidence,
 * disagreeing samples) is biased low by construction, so the queue mixes in a
 * random spot-check slice and agreement is reported for both.
 * @module shared/agreement
 */

export interface LabelPair {
  judgePassed: boolean
  humanPassed: boolean
}

export interface Agreement {
  n: number
  agree: number
  rate: number | null
  /** Cohen's kappa: agreement beyond chance. Null when undefined (n = 0 or no variation). */
  kappa: number | null
  judgePassRate: number | null
  humanPassRate: number | null
}

export function agreement(pairs: readonly LabelPair[]): Agreement {
  const n = pairs.length
  if (n === 0) return { n: 0, agree: 0, rate: null, kappa: null, judgePassRate: null, humanPassRate: null }
  const agree = pairs.filter((p) => p.judgePassed === p.humanPassed).length
  const pj = pairs.filter((p) => p.judgePassed).length / n
  const ph = pairs.filter((p) => p.humanPassed).length / n
  const po = agree / n
  const pe = pj * ph + (1 - pj) * (1 - ph)
  const kappa = pe >= 1 ? null : (po - pe) / (1 - pe)
  return { n, agree, rate: po, kappa, judgePassRate: pj, humanPassRate: ph }
}

/** Deterministic ~1-in-`every` spot check by id, so the slice is stable across page loads. */
export function isSpotCheck(id: string, every = 8): boolean {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % every === 0
}
