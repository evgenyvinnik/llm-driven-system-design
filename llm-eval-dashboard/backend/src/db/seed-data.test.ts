import { describe, expect, it } from 'vitest'
import { oracleCategory } from '../model/skills/classify.js'
import { oracleOrder } from '../model/skills/extract.js'
import { DATASETS, PROMPTS, SCORERS, SEED_RUNS } from './seed-data.js'
import { parseScorerConfig } from '../shared/scorers.js'
import { extractVariables } from '../shared/template.js'

describe('seed references', () => {
  it('match the oracles, except the two v1 mislabels that v2 fixes', () => {
    const mismatches: string[] = []
    for (const d of DATASETS) {
      for (const v of d.versions) {
        for (const c of v.cases) {
          if (c.input.ticket && oracleCategory(c.input.ticket).label !== c.reference) mismatches.push(`${v.id}:${c.caseKey}`)
          if (c.input.email) {
            const o = oracleOrder(c.input.email)
            const r = JSON.parse(c.reference)
            for (const k of ['product', 'quantity', 'city', 'priority'] as const) if (o[k] !== r[k]) mismatches.push(`${v.id}:${c.caseKey}:${k}`)
          }
        }
      }
    }
    expect(mismatches).toEqual(['dsv_triage_1:t-010', 'dsv_triage_1:t-017'])
  })

  it('every prompt variable exists in the datasets its runs use, and scorer configs are valid', () => {
    const versions = new Map(DATASETS.flatMap((d) => d.versions.map((v) => [v.id, v] as const)))
    const prompts = new Map(PROMPTS.flatMap((p) => p.versions.map((v) => [v.id, v] as const)))
    for (const run of SEED_RUNS) {
      const vars = extractVariables(prompts.get(run.promptVersionId)!.system, prompts.get(run.promptVersionId)!.template)
      for (const c of versions.get(run.datasetVersionId)!.cases) for (const v of vars) expect(c.input[v], `${run.id} ${c.caseKey} ${v}`).toBeDefined()
    }
    for (const s of SCORERS) for (const v of s.versions) expect(() => parseScorerConfig(s.kind, v.config)).not.toThrow()
  })
})
