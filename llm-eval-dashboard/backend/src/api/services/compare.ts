/**
 * Comparison of two runs on one scorer: provenance first, statistics second.
 *
 * 1. Classify the pins (shared/provenance.ts): paired, unpaired over shared
 *    cases, or not comparable (different dataset, no common scorer version).
 * 2. Paired: per-case means on the common scorer version; cases errored or
 *    unscored in EITHER run are excluded from BOTH sides and counted.
 *    Unpaired: Welch interval over cases whose content is identical in both
 *    dataset versions.
 * 3. The verdict says "improvement" only when every requirement holds.
 * @module api/services/compare
 */
import { aggregateCases, caseMeans } from '../../shared/aggregate.js'
import type { Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import { classifyComparison, finalizeProvenance, type Provenance, type RunPins } from '../../shared/provenance.js'
import { pairedComparison, welchInterval, type PairedResult, type WelchResult } from '../../shared/stats.js'
import { loadRunHeader, loadRunResults, loadScoredRows, type RunHeader } from './results.js'

export type VerdictCode = 'improvement' | 'regression' | 'not_significant' | 'confounded' | 'not_claimable' | 'indicative_only' | 'not_comparable' | 'insufficient_data'

export interface CompareCase {
  caseKey: string
  tags: string[]
  input: Record<string, unknown>
  reference: string
  meanA: number | null
  meanB: number | null
  diff: number | null
  excluded: string | null
  samplesA: { sampleIndex: number; status: string; output: string | null; score: number | null; passed: boolean | null; errorCode: string | null }[]
  samplesB: CompareCase['samplesA']
}

export interface Comparison {
  a: RunHeader
  b: RunHeader
  scorer: { id: string; name: string; kind: string }
  provenance: Provenance
  paired: PairedResult | null
  unpaired: (WelchResult & { sharedCases: number; onlyA: number; onlyB: number; changed: number }) | null
  excludedCases: number
  totalCases: number
  verdict: { code: VerdictCode; headline: string; detail: string }
  cases: CompareCase[]
}

async function pinsFor(db: Queryable, header: RunHeader, scorerId: string): Promise<RunPins> {
  const results = await loadRunResults(db, header.id)
  return {
    runId: header.id,
    name: header.name,
    status: header.status,
    datasetId: header.dataset.id,
    datasetName: header.dataset.name,
    datasetVersionId: header.dataset.versionId,
    datasetVersion: header.dataset.version,
    promptId: header.prompt.id,
    promptName: header.prompt.name,
    promptVersionId: header.prompt.versionId,
    promptVersion: header.prompt.version,
    modelConfig: header.modelConfig,
    samplesPerCase: header.samplesPerCase,
    scorerVersions: results.scorers.filter((s) => s.scorerId === scorerId).map((s) => ({ id: s.scorerVersionId, version: s.version, complete: s.complete })),
  }
}

const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3)

async function loadSamples(db: Queryable, runId: string, scorerVersionId: string | null) {
  const { rows } = await db.query<{ case_key: string; tags: string[]; input: Record<string, unknown>; reference: string; content_hash: string; sample_index: number; status: string; output: string | null; error_code: string | null; score: number | null; passed: boolean | null }>(
    `SELECT cr.case_key, dc.tags, dc.input, dc.reference, dc.content_hash, cr.sample_index, cr.status, cr.output, cr.error_code, s.score, s.passed
       FROM case_results cr JOIN dataset_cases dc ON dc.id = cr.case_id
       LEFT JOIN scores s ON s.case_result_id = cr.id AND s.scorer_version_id = $2 AND s.status = 'scored'
      WHERE cr.run_id = $1 ORDER BY dc.ordinal, cr.sample_index`,
    [runId, scorerVersionId ?? ''],
  )
  return rows
}

export async function compareRuns(db: Queryable, workspaceId: string, runA: string, runB: string, scorerId: string): Promise<Comparison> {
  const [a, b] = await Promise.all([loadRunHeader(db, workspaceId, runA), loadRunHeader(db, workspaceId, runB)])
  const sc = await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM scorers WHERE id = $1 AND workspace_id = $2', [scorerId, workspaceId])
  if (!sc.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Scorer not found')
  const [pa, pb] = await Promise.all([pinsFor(db, a, scorerId), pinsFor(db, b, scorerId)])
  let provenance = classifyComparison(pa, pb)
  const svId = provenance.scorer.commonVersionId

  const [rowsA, rowsB] = await Promise.all([loadSamples(db, a.id, svId), loadSamples(db, b.id, svId)])
  const toSample = (r: (typeof rowsA)[number]) => ({ caseKey: r.case_key, sampleIndex: r.sample_index, status: r.status as 'succeeded', score: r.score, passed: r.passed })
  const meansA = caseMeans(rowsA.map(toSample))
  const meansB = caseMeans(rowsB.map(toSample))
  const statsA = new Map(aggregateCases(rowsA.map(toSample)).map((c) => [c.caseKey, c]))
  const statsB = new Map(aggregateCases(rowsB.map(toSample)).map((c) => [c.caseKey, c]))

  let paired: PairedResult | null = null
  let unpaired: Comparison['unpaired'] = null
  let excludedCases = 0
  let totalCases = 0
  const excludedReason = new Map<string, string>()

  if (provenance.mode === 'paired') {
    const keys = [...new Set(rowsA.map((r) => r.case_key))]
    totalCases = keys.length
    const pairs: { a: number; b: number }[] = []
    for (const k of keys) {
      const ma = meansA.get(k)
      const mb = meansB.get(k)
      if (ma === undefined || mb === undefined) {
        const why = (stats: typeof statsA, side: string) => {
          const c = stats.get(k)
          if (!c) return `missing in ${side}`
          if (c.errored > 0 && c.scored === 0) return `errored in ${side}`
          if (c.cancelled > 0 && c.scored === 0) return `cancelled in ${side}`
          return `unscored in ${side}`
        }
        excludedReason.set(k, [ma === undefined ? why(statsA, 'A') : null, mb === undefined ? why(statsB, 'B') : null].filter(Boolean).join(', '))
        continue
      }
      pairs.push({ a: ma, b: mb })
    }
    excludedCases = totalCases - pairs.length
    paired = pairedComparison(pairs)
  } else if (provenance.mode === 'unpaired_shared_cases') {
    const hashA = new Map(rowsA.map((r) => [r.case_key, r.content_hash]))
    const hashB = new Map(rowsB.map((r) => [r.case_key, r.content_hash]))
    const shared = [...hashA.keys()].filter((k) => hashB.get(k) === hashA.get(k))
    const changed = [...hashA.keys()].filter((k) => hashB.has(k) && hashB.get(k) !== hashA.get(k))
    for (const k of changed) excludedReason.set(k, 'changed between dataset versions')
    for (const k of hashA.keys()) if (!hashB.has(k)) excludedReason.set(k, `only in dataset v${a.dataset.version}`)
    for (const k of hashB.keys()) if (!hashA.has(k)) excludedReason.set(k, `only in dataset v${b.dataset.version}`)
    const va = shared.map((k) => meansA.get(k)).filter((x): x is number => x !== undefined)
    const vb = shared.map((k) => meansB.get(k)).filter((x): x is number => x !== undefined)
    totalCases = new Set([...hashA.keys(), ...hashB.keys()]).size
    excludedCases = totalCases - shared.length
    unpaired = { ...welchInterval(va, vb), sharedCases: shared.length, onlyA: [...hashA.keys()].filter((k) => !hashB.has(k)).length, onlyB: [...hashB.keys()].filter((k) => !hashA.has(k)).length, changed: changed.length }
  }

  const ci = paired?.ci ?? unpaired?.ci ?? null
  provenance = finalizeProvenance(provenance, { excludedCases, totalCases, ciLo: ci ? ci[0] : null, ciHi: ci ? ci[1] : null })
  const verdict = decideVerdict(provenance, paired, unpaired)

  const byKey = new Map<string, CompareCase>()
  const add = (rows: typeof rowsA, side: 'A' | 'B') => {
    for (const r of rows) {
      let c = byKey.get(r.case_key)
      if (!c) {
        c = { caseKey: r.case_key, tags: r.tags, input: r.input, reference: r.reference, meanA: null, meanB: null, diff: null, excluded: null, samplesA: [], samplesB: [] }
        byKey.set(r.case_key, c)
      }
      ;(side === 'A' ? c.samplesA : c.samplesB).push({ sampleIndex: r.sample_index, status: r.status, output: r.output, score: r.score, passed: r.passed, errorCode: r.error_code })
    }
  }
  add(rowsA, 'A')
  add(rowsB, 'B')
  for (const c of byKey.values()) {
    c.meanA = meansA.get(c.caseKey) ?? null
    c.meanB = meansB.get(c.caseKey) ?? null
    c.excluded = provenance.mode === 'not_comparable' ? 'not comparable' : (excludedReason.get(c.caseKey) ?? null)
    c.diff = c.meanA !== null && c.meanB !== null && !c.excluded ? c.meanB - c.meanA : null
  }
  // Largest regressions first; excluded cases last.
  const cases = [...byKey.values()].sort((x, y) => (x.diff ?? Infinity) - (y.diff ?? Infinity) || x.caseKey.localeCompare(y.caseKey))

  return { a, b, scorer: sc.rows[0], provenance, paired, unpaired, excludedCases, totalCases, verdict, cases }
}

export function decideVerdict(p: Provenance, paired: PairedResult | null, unpaired: Comparison['unpaired']): Comparison['verdict'] {
  if (p.mode === 'not_comparable') {
    const block = p.warnings.find((w) => w.severity === 'block')
    return { code: 'not_comparable', headline: block?.code === 'DIFFERENT_DATASETS' ? 'Different datasets: nothing to compare' : 'Scores not comparable', detail: block?.message ?? '' }
  }
  if (p.mode === 'unpaired_shared_cases' && unpaired) {
    return {
      code: 'indicative_only',
      headline: `Unpaired, indicative only: Δ ${fmt(unpaired.meanDiff)} [${fmt(unpaired.ci[0])}, ${fmt(unpaired.ci[1])}]`,
      detail: `Dataset versions differ, so cases can't be paired. Welch interval over ${unpaired.sharedCases} unchanged shared cases. Not evidence of an improvement.`,
    }
  }
  if (!paired || paired.verdict === 'insufficient_data') return { code: 'insufficient_data', headline: 'Not enough scored cases', detail: 'At least two cases must be scored in both runs.' }
  const range = `Δ ${fmt(paired.meanDiff)}, 95% CI [${fmt(paired.ci[0])}, ${fmt(paired.ci[1])}]`
  if (paired.verdict === 'not_significant') return { code: 'not_significant', headline: `Not significant: ${range}`, detail: `The interval crosses zero. ${paired.wins} wins, ${paired.losses} losses, ${paired.ties} ties over ${paired.n} paired cases.` }
  const direction = paired.verdict === 'improvement' ? 'better' : 'worse'
  if (p.factorsChanged.length > 1) return { code: 'confounded', headline: `B is ${direction}, but the cause is unknown: ${range}`, detail: 'The prompt and the model config both changed, so the difference can\'t be attributed to either.' }
  if (!p.claimEligible) {
    const unmet = p.requirements.filter((r) => r.met === false && r.key !== 'interval_excludes_zero').map((r) => r.label.toLowerCase())
    return { code: 'not_claimable', headline: `B looks ${direction}, but it can't be claimed yet: ${range}`, detail: `Unmet: ${unmet.join('; ')}.` }
  }
  return paired.verdict === 'improvement'
    ? { code: 'improvement', headline: `Improvement: ${range}`, detail: `${paired.wins} wins, ${paired.losses} losses, ${paired.ties} ties over ${paired.n} paired cases; one factor changed (${p.factorsChanged.join(', ')}).` }
    : { code: 'regression', headline: `Regression: ${range}`, detail: `${paired.wins} wins, ${paired.losses} losses, ${paired.ties} ties over ${paired.n} paired cases; one factor changed (${p.factorsChanged.join(', ')}).` }
}

/** Re-exported for tests and the e2e's raw recomputation. */
export { loadScoredRows }
