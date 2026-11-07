/**
 * Seeds two workspaces (Acme: alice + carol; Globex: bob), datasets with
 * versions, prompts, model configs, scorers, and finished runs materialized
 * with the live code path (db/materialize.ts): an errored run, a significant
 * improvement, a "not significant" pair, mixed provenance, re-scored runs,
 * a cancelled and a failed run, and human annotations.
 *
 * Wipes and recreates everything: `npm run db:seed`.
 */
import bcrypt from 'bcryptjs'
import type pg from 'pg'
import { HTTP_STATUS } from '../model/skills/explain.js'
import { isSpotCheck } from '../shared/agreement.js'
import { caseHash, versionHash } from '../shared/dataset-diff.js'
import { pool } from '../shared/db.js'
import type { ScorerKind } from '../shared/scorers.js'
import { extractVariables } from '../shared/template.js'
import { materializeRun } from './materialize.js'
import { DATASETS, MODEL_CONFIGS, PROMPTS, SCORERS, SEED_RUNS, USERS, WORKSPACES } from './seed-data.js'

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR)
const json = (v: unknown) => JSON.stringify(v)

async function seed() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      'TRUNCATE annotations, scores, case_attempts, case_results, run_scorers, eval_runs, scorer_versions, scorers, model_configs, prompt_versions, prompts, dataset_cases, dataset_versions, datasets, users, workspaces CASCADE',
    )
    const hash = await bcrypt.hash('password123', 10)
    for (const w of WORKSPACES) await client.query('INSERT INTO workspaces (id, name, created_at) VALUES ($1, $2, $3)', [w.id, w.name, ago(24 * 10)])
    for (const u of USERS) await client.query('INSERT INTO users (id, username, display_name, password_hash, workspace_id) VALUES ($1, $2, $3, $4, $5)', [u.id, u.username, u.displayName, hash, u.workspaceId])
    const owner = (ws: string) => USERS.find((u) => u.workspaceId === ws)!.id

    const casesByVersion = new Map<string, { id: string; caseKey: string; input: Record<string, unknown>; reference: string }[]>()
    for (const d of DATASETS) {
      const head = Math.max(...d.versions.map((v) => v.version))
      const first = d.versions[0]
      await client.query('INSERT INTO datasets (id, workspace_id, name, description, head_version, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        d.id, d.workspaceId, d.name, d.description, head, first.by, ago(first.daysAgo * 24), ago(d.versions[d.versions.length - 1].daysAgo * 24),
      ])
      for (const v of d.versions) {
        await client.query('INSERT INTO dataset_versions (id, dataset_id, version, message, case_count, content_hash, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
          v.id, d.id, v.version, v.message, v.cases.length, versionHash(v.cases), v.by, ago(v.daysAgo * 24),
        ])
        const rows = v.cases.map((c, i) => ({ id: `${v.id}:${c.caseKey}`, case_key: c.caseKey, ordinal: i + 1, input: c.input, reference: c.reference, tags: c.tags, content_hash: caseHash(c) }))
        await client.query(
          `INSERT INTO dataset_cases (id, dataset_version_id, case_key, ordinal, input, reference, tags, content_hash)
           SELECT x.id, $1, x.case_key, x.ordinal, x.input, x.reference, ARRAY(SELECT jsonb_array_elements_text(x.tags)), x.content_hash
             FROM jsonb_to_recordset($2::jsonb) AS x(id text, case_key text, ordinal int, input jsonb, reference text, tags jsonb, content_hash text)`,
          [v.id, json(rows)],
        )
        casesByVersion.set(v.id, rows.map((r) => ({ id: r.id, caseKey: r.case_key, input: r.input, reference: r.reference })))
      }
    }

    const promptVersions = new Map<string, { system: string; template: string }>()
    for (const p of PROMPTS) {
      await client.query('INSERT INTO prompts (id, workspace_id, name, description, head_version, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        p.id, p.workspaceId, p.name, p.description, p.versions.length, p.versions[0].by, ago(p.versions[0].daysAgo * 24), ago(p.versions[p.versions.length - 1].daysAgo * 24),
      ])
      for (const v of p.versions) {
        await client.query('INSERT INTO prompt_versions (id, prompt_id, version, system_text, template, variables, message, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          v.id, p.id, v.version, v.system, v.template, extractVariables(v.system, v.template), v.message, v.by, ago(v.daysAgo * 24),
        ])
        promptVersions.set(v.id, { system: v.system, template: v.template })
      }
    }

    for (const m of MODEL_CONFIGS) {
      await client.query('INSERT INTO model_configs (id, workspace_id, name, model, temperature, max_tokens, seed, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        m.id, m.workspaceId, m.name, m.model, m.temperature, m.maxTokens, m.seed, owner(m.workspaceId), ago(24 * 7),
      ])
    }

    const scorerVersions = new Map<string, { id: string; kind: ScorerKind; config: Record<string, unknown> }>()
    for (const s of SCORERS) {
      await client.query('INSERT INTO scorers (id, workspace_id, name, kind, description, head_version, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        s.id, s.workspaceId, s.name, s.kind, s.description, s.versions.length, owner(s.workspaceId), ago(24 * 7),
      ])
      for (const v of s.versions) {
        const createdAt = v.version === 1 ? ago(24 * 7) : ago(20)
        await client.query('INSERT INTO scorer_versions (id, scorer_id, version, config, message, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [v.id, s.id, v.version, v.config, v.message, owner(s.workspaceId), createdAt])
        scorerVersions.set(v.id, { id: v.id, kind: s.kind, config: v.config })
      }
    }

    for (const run of SEED_RUNS) await seedRun(client, run, casesByVersion, promptVersions, scorerVersions)
    await client.query('COMMIT')
    console.log(`Seeded ${WORKSPACES.length} workspaces, ${USERS.length} users, ${DATASETS.length} datasets, ${PROMPTS.length} prompts, ${SCORERS.length} scorers, ${SEED_RUNS.length} runs`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

type Client = pg.PoolClient

async function seedRun(
  client: Client,
  run: (typeof SEED_RUNS)[number],
  casesByVersion: Map<string, { id: string; caseKey: string; input: Record<string, unknown>; reference: string }[]>,
  promptVersions: Map<string, { system: string; template: string }>,
  scorerVersions: Map<string, { id: string; kind: ScorerKind; config: Record<string, unknown> }>,
) {
  const cases = casesByVersion.get(run.datasetVersionId)!
  const config = MODEL_CONFIGS.find((m) => m.id === run.modelConfigId)!
  const createdAt = ago(run.hoursAgo)
  const allScorers = [...run.scorers, ...(run.rescore ?? [])].map((id) => scorerVersions.get(id)!)
  const out = materializeRun({
    runId: run.id,
    createdAt,
    samples: run.samples,
    concurrency: 4,
    cases,
    prompt: promptVersions.get(run.promptVersionId)!,
    config,
    scorers: allScorers,
    transientRate: run.transientRate ?? 0,
    cancelAfter: run.cancelAfter,
  })
  const succeeded = out.tasks.filter((t) => t.status === 'succeeded').length
  const status = run.cancelAfter !== undefined ? 'cancelled' : succeeded > 0 ? 'completed' : 'failed'
  const startedAt = new Date(createdAt.getTime() + 150)
  const finishedAt = new Date(createdAt.getTime() + out.durationMs + 400)
  const topError = out.tasks.find((t) => t.status === 'errored')?.error_code
  await client.query(
    `INSERT INTO eval_runs (id, workspace_id, name, dataset_version_id, prompt_version_id, model_config_id, samples_per_case, concurrency_limit, status, total_tasks,
                            failure_reason, created_by, idempotency_key, request_hash, created_at, started_at, finished_at, cancel_requested_at, last_claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 4, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16)`,
    [
      run.id, run.workspaceId, run.name, run.datasetVersionId, run.promptVersionId, run.modelConfigId, run.samples, status, out.tasks.length,
      status === 'failed' ? `every task errored; most common: ${topError}` : null,
      run.by, `seed-${run.id}`, 'seed'.padEnd(64, '0'), createdAt, startedAt, finishedAt, status === 'cancelled' ? finishedAt : null,
    ],
  )
  const rescoreAt = new Date(finishedAt.getTime() + 2 * HOUR)
  for (const id of run.scorers) await client.query(`INSERT INTO run_scorers (run_id, scorer_version_id, origin, added_by, added_at) VALUES ($1, $2, 'pinned', $3, $4)`, [run.id, id, run.by, createdAt])
  for (const id of run.rescore ?? []) await client.query(`INSERT INTO run_scorers (run_id, scorer_version_id, origin, added_by, added_at) VALUES ($1, $2, 'rescore', $3, $4)`, [run.id, id, run.by, rescoreAt])

  await client.query(
    `INSERT INTO case_results (id, run_id, case_id, case_key, sample_index, status, attempts, round_attempts, output, finish_reason, input_tokens, output_tokens,
                               queue_ms, ttft_ms, generation_ms, error_code, error_message, enqueued_at, available_at, started_at, finished_at)
     SELECT x.id, $1, x.case_id, x.case_key, x.sample_index, x.status, x.attempts, x.attempts, x.output, x.finish_reason, x.input_tokens, x.output_tokens,
            x.queue_ms, x.ttft_ms, x.generation_ms, x.error_code, x.error_message, $2, $2, x.started_at, COALESCE(x.finished_at, $3)
       FROM jsonb_to_recordset($4::jsonb) AS x(id text, case_id text, case_key text, sample_index int, status text, attempts int, output text, finish_reason text,
            input_tokens int, output_tokens int, queue_ms int, ttft_ms int, generation_ms int, error_code text, error_message text, started_at timestamptz, finished_at timestamptz)`,
    [run.id, createdAt, finishedAt, json(out.tasks)],
  )
  await client.query(
    `INSERT INTO case_attempts (case_result_id, attempt, worker_id, outcome, error_code, http_status, delay_ms, started_at, finished_at)
     SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(case_result_id text, attempt int, worker_id text, outcome text, error_code text, http_status int, delay_ms int, started_at timestamptz, finished_at timestamptz)`,
    [json(out.attempts)],
  )
  const rescored = new Set(run.rescore ?? [])
  await client.query(
    `INSERT INTO scores (case_result_id, scorer_version_id, run_id, status, score, passed, confidence, rationale, attempts, created_at, scored_at)
     SELECT x.case_result_id, x.scorer_version_id, $1, 'scored', x.score, x.passed, x.confidence, x.rationale, 1, x.at, x.at
       FROM jsonb_to_recordset($2::jsonb) AS x(case_result_id text, scorer_version_id text, score numeric, passed boolean, confidence numeric, rationale text, at timestamptz)`,
    [run.id, json(out.scores.map((s) => ({ ...s, at: rescored.has(s.scorer_version_id) ? rescoreAt : finishedAt })))],
  )

  // Human review on the judge-graded run: label the queue items (low confidence,
  // disagreeing samples) and the spot-check slice. Reviewers pass an answer that
  // names the right status, whatever its length.
  const human = run.scorers.find((id) => scorerVersions.get(id)?.kind === 'human')
  if (human) {
    const judge = run.scorers.find((id) => scorerVersions.get(id)?.kind === 'model_graded')!
    const byCase = new Map<string, typeof out.tasks>()
    for (const t of out.tasks) byCase.set(t.case_key, [...(byCase.get(t.case_key) ?? []), t])
    const judgeScore = new Map(out.scores.filter((s) => s.scorer_version_id === judge).map((s) => [s.case_result_id, s]))
    let n = 0
    for (const t of out.tasks) {
      if (t.status !== 'succeeded' || !t.output) continue
      const js = judgeScore.get(t.id)
      const samePasses = (byCase.get(t.case_key) ?? []).map((x) => judgeScore.get(x.id)?.passed)
      const disagree = samePasses.some((p) => p !== samePasses[0])
      const lowConf = out.scores.some((s) => s.case_result_id === t.id && s.confidence !== null && s.confidence < 0.5)
      if (!(lowConf || disagree || isSpotCheck(t.id))) continue
      if (n >= 14) break
      const code = Number(cases.find((c) => c.id === t.case_id)?.input.code)
      const right = HTTP_STATUS[code] ? t.output.includes(`${code} ${HTTP_STATUS[code].name}`) : false
      const note = right ? (js?.passed ? '' : 'Correct, just wordy') : 'Wrong status name'
      await client.query(`INSERT INTO annotations (case_result_id, run_id, label, note, annotated_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`, [
        t.id, run.id, right ? 'pass' : 'fail', note, n % 2 === 0 ? 'usr_carol' : 'usr_alice', new Date(finishedAt.getTime() + (n + 1) * 600_000),
      ])
      await client.query(`INSERT INTO scores (case_result_id, scorer_version_id, run_id, status, score, passed, rationale, attempts, scored_at) VALUES ($1, $2, $3, 'scored', $4, $5, $6, 0, now())`, [
        t.id, human, run.id, right ? 1 : 0, right, note || `labeled ${right ? 'pass' : 'fail'}`,
      ])
      n++
    }
  }
}

await seed()
