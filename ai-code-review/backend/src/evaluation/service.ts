/**
 * Durable evaluation runs: a row per run, a row per case. The replay itself is pure
 * and takes milliseconds, so it runs inline; a real provider would make this a job.
 * @module evaluation/service
 */
import { pool, withTransaction } from '../shared/db.js'
import { POLICY_VERSION } from '../shared/gate/rules.js'
import { newId } from '../shared/ids.js'
import { summarize, type EvaluationSummary } from './metrics.js'
import { corpusHash, loadCorpus, replayCorpus } from './replay.js'
import type { CaseResult } from './types.js'

export interface EvaluationRow {
  id: string
  status: string
  model_version: string
  policy_version: string
  corpus_hash: string
  corpus_size: number
  partial: boolean
  summary: EvaluationSummary | null
  created_by: string
  created_at: Date
  finished_at: Date | null
}

export async function runEvaluation(args: { modelVersion: string; limit?: number; createdBy: string }): Promise<EvaluationRow> {
  const full = loadCorpus()
  const corpus = args.limit ? full.slice(0, args.limit) : full
  const id = newId('eval')
  const partial = corpus.length < full.length
  await pool.query(`INSERT INTO evaluations (id, model_version, policy_version, corpus_hash, corpus_size, partial, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, args.modelVersion, POLICY_VERSION, corpusHash(corpus), corpus.length, partial, args.createdBy])
  let rows: CaseResult[]
  try {
    rows = await replayCorpus(corpus, args.modelVersion)
  } catch (err) {
    await pool.query(`UPDATE evaluations SET status = 'failed', finished_at = now() WHERE id = $1`, [id])
    throw err
  }
  const summary = summarize(rows)
  return withTransaction(async (tx) => {
    for (const r of rows) {
      await tx.query(
        `INSERT INTO evaluation_cases (evaluation_id, case_id, title, class, dangerous, injection, human_decision, in_scope, model_verdict, model_confidence, model_only, gated, observe_would, reason_code, reason, failed_rules, tools_denied, scanner_hit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, r.caseId, r.title, r.class, r.dangerous, r.injection, r.humanDecision, r.inScope, r.modelVerdict, r.modelConfidence, r.modelOnly, r.gated, r.observeWould, r.reasonCode, r.reason, JSON.stringify(r.failedRules), r.toolsDenied, r.scannerHit],
      )
    }
    const res = await tx.query<EvaluationRow>(`UPDATE evaluations SET status = 'completed', summary = $2, finished_at = now() WHERE id = $1 RETURNING *`, [id, JSON.stringify(summary)])
    return res.rows[0]
  })
}

export async function latestEvaluation(modelVersion: string): Promise<EvaluationRow | null> {
  const res = await pool.query<EvaluationRow>(
    `SELECT * FROM evaluations WHERE model_version = $1 AND policy_version = $2 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
    [modelVersion, POLICY_VERSION],
  )
  return res.rows[0] ?? null
}
