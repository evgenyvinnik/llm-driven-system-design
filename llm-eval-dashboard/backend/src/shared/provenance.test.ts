import { describe, expect, it } from 'vitest'
import { classifyComparison, finalizeProvenance, type RunPins } from './provenance.js'

const base: RunPins = {
  runId: 'run_a',
  name: 'A',
  status: 'completed',
  datasetId: 'ds',
  datasetName: 'triage',
  datasetVersionId: 'dsv2',
  datasetVersion: 2,
  promptId: 'pr',
  promptName: 'Triage',
  promptVersionId: 'pv1',
  promptVersion: 1,
  modelConfig: { id: 'mc1', name: 'small', model: 'mock-small', temperature: 0.7, maxTokens: 160, seed: 29 },
  samplesPerCase: 5,
  scorerVersions: [{ id: 'sv1', version: 1, complete: true }],
}
const run = (over: Partial<RunPins>): RunPins => ({ ...base, ...over })
const codes = (p: ReturnType<typeof classifyComparison>) => p.warnings.map((w) => w.code)

describe('classifyComparison', () => {
  it('a one-factor change on the same dataset and scorer version is paired and claimable', () => {
    const p = classifyComparison(base, run({ runId: 'run_b', name: 'B', promptVersionId: 'pv2', promptVersion: 2 }))
    expect(p.mode).toBe('paired')
    expect(p.factorsChanged).toEqual(['prompt'])
    expect(p.claimEligible).toBe(true)
    expect(p.scorer.commonVersion).toBe(1)
  })

  it('mixed dataset versions: unpaired over shared cases, never claimable', () => {
    const p = classifyComparison(run({ datasetVersionId: 'dsv1', datasetVersion: 1 }), run({ runId: 'run_b', promptVersionId: 'pv2', promptVersion: 2 }))
    expect(p.mode).toBe('unpaired_shared_cases')
    expect(codes(p)).toContain('MIXED_DATASET_VERSIONS')
    expect(p.claimEligible).toBe(false)
  })

  it('different datasets are not comparable at all', () => {
    const p = classifyComparison(base, run({ runId: 'run_b', datasetId: 'other', datasetName: 'orders', datasetVersionId: 'x' }))
    expect(p.mode).toBe('not_comparable')
    expect(codes(p)).toContain('DIFFERENT_DATASETS')
  })

  it('scorer version mismatch blocks the comparison and suggests re-scoring the run behind', () => {
    const p = classifyComparison(base, run({ runId: 'run_b', name: 'B', promptVersionId: 'pv2', promptVersion: 2, scorerVersions: [{ id: 'sv2', version: 2, complete: true }] }))
    expect(p.mode).toBe('not_comparable')
    expect(codes(p)).toContain('SCORER_VERSION_MISMATCH')
    expect(p.scorer.rescoreSuggestion).toEqual({ runId: 'run_a', scorerVersionId: 'sv2', version: 2 })
  })

  it('a shared older scorer version is used, with a note about the newer one', () => {
    const p = classifyComparison(run({ scorerVersions: [{ id: 'sv1', version: 1, complete: true }, { id: 'sv2', version: 2, complete: true }] }), run({ runId: 'run_b', name: 'B', promptVersionId: 'pv2', promptVersion: 2 }))
    expect(p.mode).toBe('paired')
    expect(p.scorer.commonVersion).toBe(1)
    expect(p.scorer.rescoreSuggestion?.runId).toBe('run_b')
  })

  it('an incomplete re-score is not used yet', () => {
    const p = classifyComparison(base, run({ runId: 'run_b', promptVersionId: 'pv2', scorerVersions: [{ id: 'sv1', version: 1, complete: false }] }))
    expect(p.mode).toBe('not_comparable')
    expect(codes(p)).toContain('SCORING_INCOMPLETE')
  })

  it('prompt and model config both changed: confounded', () => {
    const p = classifyComparison(base, run({ runId: 'run_b', promptVersionId: 'pv2', promptVersion: 2, modelConfig: { ...base.modelConfig, id: 'mc2', name: 'large', model: 'mock-large' } }))
    expect(p.factorsChanged).toEqual(['prompt', 'model_config'])
    expect(p.configFieldsChanged).toEqual(['model'])
    expect(codes(p)).toContain('MULTIPLE_FACTORS_CHANGED')
    expect(p.claimEligible).toBe(false)
  })

  it('same pins is an A/A comparison; a seed-only change is not a factor', () => {
    expect(codes(classifyComparison(base, run({ runId: 'run_b' })))).toContain('NO_FACTOR_CHANGED')
    const seedOnly = classifyComparison(base, run({ runId: 'run_b', modelConfig: { ...base.modelConfig, id: 'mc3', seed: 11 } }))
    expect(seedOnly.factorsChanged).toEqual([])
    expect(codes(seedOnly)).toContain('SEED_ONLY_DIFFERS')
  })

  it('unfinished runs and single samples at temperature > 0 block a claim', () => {
    const p = classifyComparison(run({ status: 'running' }), run({ runId: 'run_b', promptVersionId: 'pv2', samplesPerCase: 1 }))
    expect(codes(p)).toEqual(expect.arrayContaining(['RUN_NOT_FINISHED', 'SAMPLES_TOO_FEW', 'SAMPLE_COUNTS_DIFFER']))
    expect(p.claimEligible).toBe(false)
    const t0 = classifyComparison(run({ samplesPerCase: 1, modelConfig: { ...base.modelConfig, temperature: 0 } }), run({ runId: 'run_b', promptVersionId: 'pv2', samplesPerCase: 1, modelConfig: { ...base.modelConfig, temperature: 0 } }))
    expect(codes(t0)).not.toContain('SAMPLES_TOO_FEW')
  })
})

describe('finalizeProvenance', () => {
  const p = classifyComparison(base, run({ runId: 'run_b', promptVersionId: 'pv2', promptVersion: 2 }))

  it('excluding more than 10% of cases makes the comparison unclaimable', () => {
    const f = finalizeProvenance(p, { excludedCases: 4, totalCases: 23, ciLo: 0.05, ciHi: 0.2 })
    expect(f.warnings.find((w) => w.code === 'ERRORED_CASES_EXCLUDED')?.severity).toBe('warn')
    expect(f.claimEligible).toBe(false)
  })

  it('a few excluded cases are reported but do not block', () => {
    const f = finalizeProvenance(p, { excludedCases: 1, totalCases: 23, ciLo: 0.05, ciHi: 0.2 })
    expect(f.warnings.find((w) => w.code === 'ERRORED_CASES_EXCLUDED')?.severity).toBe('info')
    expect(f.claimEligible).toBe(true)
    expect(f.requirements.find((r) => r.key === 'interval_excludes_zero')?.met).toBe(true)
  })

  it('an interval crossing zero fails the last requirement', () => {
    const f = finalizeProvenance(p, { excludedCases: 0, totalCases: 23, ciLo: -0.05, ciHi: 0.2 })
    expect(f.requirements.find((r) => r.key === 'interval_excludes_zero')?.met).toBe(false)
  })
})
