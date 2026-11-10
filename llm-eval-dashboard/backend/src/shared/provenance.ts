/**
 * Provenance classification for a comparison between two runs. Pure.
 *
 * A comparison may be called an improvement only when ALL of these hold:
 *   1. Both runs used the same dataset version, so cases pair one to one.
 *   2. Both runs were scored with the same scorer version, fully.
 *   3. Exactly one factor changed (prompt version OR model config), so the
 *      difference can be attributed.
 *   4. Both runs finished, and errored cases are few, listed and excluded from
 *      both sides (never averaged away on one side only).
 *   5. Enough samples to see nondeterminism (≥ 2 per case unless temperature 0).
 *   6. The paired 95% interval on the per-case difference excludes zero.
 * This module decides 1-5 from the pins; the statistics decide 6.
 * @module shared/provenance
 */

export interface ModelConfigPin {
  id: string
  name: string
  model: string
  temperature: number
  maxTokens: number
  seed: number
}

export interface RunPins {
  runId: string
  name: string
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  datasetId: string
  datasetName: string
  datasetVersionId: string
  datasetVersion: number
  promptId: string
  promptName: string
  promptVersionId: string
  promptVersion: number
  modelConfig: ModelConfigPin
  samplesPerCase: number
  /** Versions of the compared scorer that have scores on this run (any coverage). */
  scorerVersions: { id: string; version: number; complete: boolean }[]
}

export type WarningCode =
  | 'DIFFERENT_DATASETS'
  | 'MIXED_DATASET_VERSIONS'
  | 'SCORER_VERSION_MISMATCH'
  | 'SCORER_MISSING'
  | 'SCORING_INCOMPLETE'
  | 'MULTIPLE_FACTORS_CHANGED'
  | 'NO_FACTOR_CHANGED'
  | 'RUN_NOT_FINISHED'
  | 'SAMPLES_TOO_FEW'
  | 'SAMPLE_COUNTS_DIFFER'
  | 'SEED_ONLY_DIFFERS'
  | 'ERRORED_CASES_EXCLUDED'

export interface ProvenanceWarning {
  code: WarningCode
  /** block: no comparison of scores is shown; warn: shown but not claimable; info: context. */
  severity: 'block' | 'warn' | 'info'
  message: string
}

export interface ProvenanceRow {
  key: string
  label: string
  a: string
  b: string
  changed: boolean
  role: 'factor' | 'must_match' | 'context'
}

export type Factor = 'prompt' | 'model_config'

export interface Requirement {
  key: 'same_dataset_version' | 'same_scorer_version' | 'single_factor' | 'runs_finished' | 'enough_samples' | 'interval_excludes_zero'
  label: string
  met: boolean | null
  detail: string
}

export interface Provenance {
  rows: ProvenanceRow[]
  factorsChanged: Factor[]
  configFieldsChanged: string[]
  mode: 'paired' | 'unpaired_shared_cases' | 'not_comparable'
  scorer: {
    aVersions: number[]
    bVersions: number[]
    /** Latest version scored on both runs, if any: what the comparison uses. */
    commonVersionId: string | null
    commonVersion: number | null
    latestA: number | null
    latestB: number | null
    /** When versions don't match: re-score the run that lacks the newer version. */
    rescoreSuggestion: { runId: string; scorerVersionId: string; version: number } | null
  }
  warnings: ProvenanceWarning[]
  requirements: Requirement[]
  /** Requirements 1-5 hold; requirement 6 is decided by the interval. */
  claimEligible: boolean
}

const fmtTemp = (t: number) => t.toFixed(2).replace(/0$/, '')

export function classifyComparison(a: RunPins, b: RunPins, newestScorerVersions: Map<number, string> = new Map()): Provenance {
  const warnings: ProvenanceWarning[] = []
  const rows: ProvenanceRow[] = []

  const sameDataset = a.datasetId === b.datasetId
  const sameDatasetVersion = a.datasetVersionId === b.datasetVersionId
  rows.push({
    key: 'dataset',
    label: 'Dataset version',
    a: `${a.datasetName} v${a.datasetVersion}`,
    b: `${b.datasetName} v${b.datasetVersion}`,
    changed: !sameDatasetVersion,
    role: 'must_match',
  })

  const promptChanged = a.promptVersionId !== b.promptVersionId
  rows.push({
    key: 'prompt',
    label: 'Prompt version',
    a: `${a.promptName} v${a.promptVersion}`,
    b: `${b.promptName} v${b.promptVersion}`,
    changed: promptChanged,
    role: 'factor',
  })

  const ca = a.modelConfig
  const cb = b.modelConfig
  const configFieldsChanged: string[] = []
  if (ca.model !== cb.model) configFieldsChanged.push('model')
  if (Math.abs(ca.temperature - cb.temperature) > 1e-9) configFieldsChanged.push('temperature')
  if (ca.maxTokens !== cb.maxTokens) configFieldsChanged.push('max_tokens')
  const seedChanged = ca.seed !== cb.seed
  const configChanged = configFieldsChanged.length > 0
  rows.push({ key: 'model_config', label: 'Model config', a: ca.name, b: cb.name, changed: configChanged, role: 'factor' })
  rows.push({ key: 'model', label: '· model', a: ca.model, b: cb.model, changed: ca.model !== cb.model, role: 'context' })
  rows.push({ key: 'temperature', label: '· temperature', a: fmtTemp(ca.temperature), b: fmtTemp(cb.temperature), changed: configFieldsChanged.includes('temperature'), role: 'context' })
  rows.push({ key: 'max_tokens', label: '· max tokens', a: String(ca.maxTokens), b: String(cb.maxTokens), changed: configFieldsChanged.includes('max_tokens'), role: 'context' })
  rows.push({ key: 'seed', label: '· seed', a: String(ca.seed), b: String(cb.seed), changed: seedChanged, role: 'context' })
  rows.push({ key: 'samples', label: 'Samples per case', a: String(a.samplesPerCase), b: String(b.samplesPerCase), changed: a.samplesPerCase !== b.samplesPerCase, role: 'context' })

  // Scorer versions: compare on the newest version both runs were fully scored with.
  const aComplete = a.scorerVersions.filter((v) => v.complete)
  const bComplete = b.scorerVersions.filter((v) => v.complete)
  const common = aComplete.filter((v) => bComplete.some((w) => w.id === v.id)).sort((x, y) => y.version - x.version)[0] ?? null
  const latestA = a.scorerVersions.length > 0 ? Math.max(...a.scorerVersions.map((v) => v.version)) : null
  const latestB = b.scorerVersions.length > 0 ? Math.max(...b.scorerVersions.map((v) => v.version)) : null
  rows.push({
    key: 'scorer',
    label: 'Scorer version',
    a: a.scorerVersions.length ? a.scorerVersions.map((v) => `v${v.version}${v.complete ? '' : '…'}`).join(', ') : 'none',
    b: b.scorerVersions.length ? b.scorerVersions.map((v) => `v${v.version}${v.complete ? '' : '…'}`).join(', ') : 'none',
    changed: common === null,
    role: 'must_match',
  })

  let rescoreSuggestion: Provenance['scorer']['rescoreSuggestion'] = null
  let blocked = false
  if (!sameDataset) {
    warnings.push({ code: 'DIFFERENT_DATASETS', severity: 'block', message: `The runs evaluate different datasets (${a.datasetName} vs ${b.datasetName}); there is nothing to compare case by case.` })
    blocked = true
  } else if (!sameDatasetVersion) {
    warnings.push({
      code: 'MIXED_DATASET_VERSIONS',
      severity: 'warn',
      message: `Dataset versions differ (v${a.datasetVersion} vs v${b.datasetVersion}). Cases can't be paired, so this is an unpaired comparison over the cases both versions share unchanged. It can't support an improvement claim: re-run one side on the same version.`,
    })
  }

  if (a.scorerVersions.length === 0 || b.scorerVersions.length === 0) {
    warnings.push({ code: 'SCORER_MISSING', severity: 'block', message: `${a.scorerVersions.length === 0 ? a.name : b.name} has no scores for this scorer. Re-score it to compare.` })
    blocked = true
    const target = a.scorerVersions.length === 0 ? a : b
    const other = target === a ? b : a
    const best = [...other.scorerVersions].sort((x, y) => y.version - x.version)[0]
    if (best) rescoreSuggestion = { runId: target.runId, scorerVersionId: best.id, version: best.version }
  } else if (common === null) {
    const newest = Math.max(latestA ?? 0, latestB ?? 0)
    const behind = (latestA ?? 0) < newest ? a : b
    const newestId = newestScorerVersions.get(newest) ?? (behind === a ? b : a).scorerVersions.find((v) => v.version === newest)?.id ?? null
    warnings.push({
      code: 'SCORER_VERSION_MISMATCH',
      severity: 'block',
      message: `Scores are not comparable: ${a.name} was scored with v${a.scorerVersions.map((v) => v.version).join('/v')} and ${b.name} with v${b.scorerVersions.map((v) => v.version).join('/v')}. Re-score ${behind.name} with v${newest} (no new generations needed).`,
    })
    if (newestId) rescoreSuggestion = { runId: behind.runId, scorerVersionId: newestId, version: newest }
    blocked = true
  } else if (common.version < Math.max(latestA ?? 0, latestB ?? 0)) {
    const newest = Math.max(latestA ?? 0, latestB ?? 0)
    const behind = (latestA ?? 0) < newest ? a : b
    const newestId = (behind === a ? b : a).scorerVersions.find((v) => v.version === newest)?.id ?? null
    warnings.push({ code: 'SCORER_VERSION_MISMATCH', severity: 'info', message: `Compared on scorer v${common.version}, the newest version both runs share. ${behind.name} has no v${newest} scores; re-score it to compare on v${newest}.` })
    if (newestId) rescoreSuggestion = { runId: behind.runId, scorerVersionId: newestId, version: newest }
  }
  const incomplete = [...a.scorerVersions, ...b.scorerVersions].some((v) => !v.complete)
  if (incomplete) warnings.push({ code: 'SCORING_INCOMPLETE', severity: 'info', message: 'Some scorer versions are still scoring (marked …); they are used once complete.' })

  const factorsChanged: Factor[] = []
  if (promptChanged) factorsChanged.push('prompt')
  if (configChanged) factorsChanged.push('model_config')
  if (factorsChanged.length > 1) {
    warnings.push({
      code: 'MULTIPLE_FACTORS_CHANGED',
      severity: 'warn',
      message: `Both the prompt (v${a.promptVersion} → v${b.promptVersion}) and the model config (${configFieldsChanged.join(', ')}) changed. Any difference can't be attributed to either one: change one factor per comparison.`,
    })
  } else if (factorsChanged.length === 0) {
    warnings.push({ code: 'NO_FACTOR_CHANGED', severity: 'info', message: 'Same prompt version and model config: an A/A comparison. Any difference is sampling noise, so expect "not significant".' })
  }
  if (seedChanged && !configChanged) {
    warnings.push({ code: 'SEED_ONLY_DIFFERS', severity: 'info', message: 'Only the seed differs within the model config: that draws different samples, it does not change the system.' })
  }

  const unfinished = [a, b].filter((r) => r.status !== 'completed')
  if (unfinished.length > 0) {
    warnings.push({ code: 'RUN_NOT_FINISHED', severity: 'warn', message: `${unfinished.map((r) => `${r.name} is ${r.status}`).join('; ')}. Partial runs can't support a claim.` })
  }
  const fewSamples = [a, b].filter((r) => r.samplesPerCase < 2 && r.modelConfig.temperature > 0)
  if (fewSamples.length > 0) {
    warnings.push({ code: 'SAMPLES_TOO_FEW', severity: 'warn', message: `${fewSamples.map((r) => r.name).join(' and ')} took one sample per case at temperature > 0, so per-case noise is invisible. Use ≥ 2 samples (5 is a good default).` })
  }
  if (a.samplesPerCase !== b.samplesPerCase) {
    warnings.push({ code: 'SAMPLE_COUNTS_DIFFER', severity: 'info', message: `Sample counts differ (${a.samplesPerCase} vs ${b.samplesPerCase}). Per-case means are still comparable; the run with fewer samples is noisier.` })
  }

  const mode: Provenance['mode'] = blocked ? 'not_comparable' : sameDatasetVersion ? 'paired' : 'unpaired_shared_cases'
  const requirements: Requirement[] = [
    { key: 'same_dataset_version', label: 'Same dataset version (cases pair 1:1)', met: sameDatasetVersion, detail: sameDatasetVersion ? `v${a.datasetVersion}` : `v${a.datasetVersion} vs v${b.datasetVersion}` },
    { key: 'same_scorer_version', label: 'Same scorer version, fully scored', met: common !== null, detail: common ? `v${common.version}` : 'no common version' },
    { key: 'single_factor', label: 'Exactly one factor changed', met: factorsChanged.length === 1, detail: factorsChanged.length === 0 ? 'nothing changed (A/A)' : factorsChanged.join(' + ') },
    { key: 'runs_finished', label: 'Both runs finished; errored cases listed', met: unfinished.length === 0, detail: unfinished.length === 0 ? 'completed' : unfinished.map((r) => r.status).join(', ') },
    { key: 'enough_samples', label: '≥ 2 samples per case (or temperature 0)', met: fewSamples.length === 0, detail: `${a.samplesPerCase} and ${b.samplesPerCase}` },
    { key: 'interval_excludes_zero', label: 'Paired 95% CI excludes zero', met: null, detail: 'decided by the data' },
  ]
  const claimEligible = requirements.slice(0, 5).every((r) => r.met === true)

  return {
    rows,
    factorsChanged,
    configFieldsChanged,
    mode,
    scorer: {
      aVersions: a.scorerVersions.map((v) => v.version),
      bVersions: b.scorerVersions.map((v) => v.version),
      commonVersionId: common?.id ?? null,
      commonVersion: common?.version ?? null,
      latestA,
      latestB,
      rescoreSuggestion,
    },
    warnings,
    requirements,
    claimEligible,
  }
}

/** Adds the data-dependent requirement and warning once the statistics are known. */
export function finalizeProvenance(p: Provenance, stats: { excludedCases: number; totalCases: number; ciLo: number | null; ciHi: number | null }): Provenance {
  const warnings = [...p.warnings]
  const requirements = p.requirements.map((r) => ({ ...r }))
  const excludedShare = stats.totalCases > 0 ? stats.excludedCases / stats.totalCases : 0
  if (stats.excludedCases > 0) {
    warnings.push({
      code: 'ERRORED_CASES_EXCLUDED',
      severity: excludedShare > 0.1 ? 'warn' : 'info',
      message: `${stats.excludedCases} of ${stats.totalCases} cases are excluded from both sides because they errored or are unscored in at least one run.${excludedShare > 0.1 ? ' That is over 10%: retry the errored cases before drawing conclusions.' : ''}`,
    })
  }
  const finished = requirements.find((r) => r.key === 'runs_finished')
  if (finished && excludedShare > 0.1) {
    finished.met = false
    finished.detail = `${stats.excludedCases} of ${stats.totalCases} cases excluded`
  }
  const ci = requirements.find((r) => r.key === 'interval_excludes_zero')
  if (ci) {
    if (stats.ciLo === null || stats.ciHi === null || !Number.isFinite(stats.ciLo)) {
      ci.met = false
      ci.detail = 'no interval'
    } else {
      ci.met = stats.ciLo > 0 || stats.ciHi < 0
      ci.detail = `[${stats.ciLo.toFixed(3)}, ${stats.ciHi.toFixed(3)}]`
    }
  }
  const claimEligible = requirements.slice(0, 5).every((r) => r.met === true)
  return { ...p, warnings, requirements, claimEligible }
}
