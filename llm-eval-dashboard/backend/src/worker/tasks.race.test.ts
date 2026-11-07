/**
 * The work queue against a real PostgreSQL: idempotent task writes, lease
 * fencing, the per-run concurrency limit, fairness and idempotent run
 * creation. Runs only when TEST_DATABASE_URL points at a migrated and seeded
 * database, e.g.
 *   TEST_DATABASE_URL=postgresql://evals:evals_password@localhost:5432/llm_eval npm test
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('work queue (PostgreSQL)', () => {
  let db: typeof import('../shared/db.js')
  let tasks: typeof import('./tasks.js')
  let runs: typeof import('../api/services/runs.js')
  const created: string[] = []

  async function makeRun(limit: number, samples = 2): Promise<string> {
    const id = `run_racetest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    created.push(id)
    await db.pool.query(
      `INSERT INTO eval_runs (id, workspace_id, name, dataset_version_id, prompt_version_id, model_config_id, samples_per_case, concurrency_limit, total_tasks, created_by, idempotency_key, request_hash)
       VALUES ($1, 'ws_acme', 'race test', 'dsv_triage_2', 'pv_triage_2', 'mc_small_t07', $2, $3, 23 * $2, 'usr_alice', $1, repeat('0', 64))`,
      [id, samples, limit],
    )
    await db.pool.query(
      `INSERT INTO case_results (id, run_id, case_id, case_key, sample_index)
       SELECT 'cr_' || substr(md5($1 || c.id || s.i), 1, 20), $1, c.id, c.case_key, s.i FROM dataset_cases c CROSS JOIN generate_series(0, $2 - 1) s(i) WHERE c.dataset_version_id = 'dsv_triage_2'`,
      [id, samples],
    )
    return id
  }

  async function claim(workerId: string, leaseMs = 30_000) {
    const client = await db.pool.connect()
    try {
      return await tasks.claimGenerationTask(client, workerId, leaseMs)
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    db = await import('../shared/db.js')
    tasks = await import('./tasks.js')
    runs = await import('../api/services/runs.js')
    // Keep other runs out of the way of the claim order.
    await db.pool.query(`UPDATE eval_runs SET last_claimed_at = now() + interval '1 hour' WHERE status IN ('queued', 'running') AND id NOT LIKE 'run_racetest_%'`)
  })

  // Stop each test's runs so they don't compete for claims in the next test.
  afterEach(async () => {
    if (created.length) await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = ANY($1)`, [created])
  })

  afterAll(async () => {
    if (created.length) await db.pool.query('DELETE FROM eval_runs WHERE id = ANY($1)', [created])
    await db.pool.query(`DELETE FROM eval_runs WHERE idempotency_key LIKE 'racetest-%'`)
    await db.pool.end()
  })

  it('concurrent claimers never share a task and never exceed the run limit', async () => {
    const run = await makeRun(3)
    const got: NonNullable<Awaited<ReturnType<typeof claim>>>[] = []
    // Bursts of 10 parallel claims; claimers that find the run locked return null and try again.
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`w${i}`)))
      for (const r of results) if (r) got.push(r)
    }
    expect(got.every((r) => r.runId === run)).toBe(true)
    expect(got).toHaveLength(3)
    expect(new Set(got.map((r) => r!.id)).size).toBe(3)
    const { rows } = await db.pool.query<{ n: number }>(`SELECT count(*) AS n FROM case_results WHERE run_id = $1 AND status = 'running'`, [run])
    expect(rows[0].n).toBe(3)
    await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = $1`, [run])
  })

  it('a re-leased task keeps one row; the stale holder cannot write', async () => {
    const run = await makeRun(1)
    const first = (await claim('worker-a'))!
    expect(first.runId).toBe(run)
    // worker-a "dies": its lease expires and worker-b takes the task over.
    await db.pool.query(`UPDATE case_results SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [first.id])
    const second = (await claim('worker-b'))!
    expect(second.id).toBe(first.id)
    expect(second.reclaimed).toBe(true)
    expect(second.attempt).toBe(2)

    const out = { output: 'billing', finishReason: 'stop', inputTokens: 10, outputTokens: 1, ttftMs: 5, generationMs: 5 }
    const c1 = await db.pool.connect()
    try {
      expect(await tasks.completeTask(c1, first, out, [])).toBe(false)
      expect(await tasks.failTask(db.pool, first, { kind: 'errored', errorCode: 'x', errorMessage: 'x' })).toBe(false)
      expect(await tasks.completeTask(c1, second, out, [{ scorerVersionId: 'scv_exact_1', status: 'scored', score: 1, passed: true, rationale: 'ok' }])).toBe(true)
      // A duplicate completion (e.g. a retried write) is rejected by the fence.
      expect(await tasks.completeTask(c1, second, out, [])).toBe(false)
    } finally {
      c1.release()
    }
    const rows = await db.pool.query<{ n: number; status: string; attempts: number }>(
      `SELECT count(*) OVER () AS n, status, attempts FROM case_results WHERE run_id = $1 AND case_id = (SELECT case_id FROM case_results WHERE id = $2) AND sample_index = $3`,
      [run, first.id, first.sampleIndex],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ status: 'succeeded', attempts: 2 })
    const att = await db.pool.query<{ attempt: number; outcome: string }>('SELECT attempt, outcome FROM case_attempts WHERE case_result_id = $1 ORDER BY attempt', [first.id])
    expect(att.rows).toEqual([
      { attempt: 1, outcome: 'lease_expired' },
      { attempt: 2, outcome: 'succeeded' },
    ])
    const scores = await db.pool.query<{ n: number }>('SELECT count(*) AS n FROM scores WHERE case_result_id = $1', [first.id])
    expect(scores.rows[0].n).toBe(1)
    await expect(
      db.pool.query(`INSERT INTO case_results (id, run_id, case_id, case_key, sample_index) SELECT 'cr_dup_' || $2, run_id, case_id, case_key, sample_index FROM case_results WHERE id = $1`, [first.id, Date.now()]),
    ).rejects.toMatchObject({ code: '23505' })
    await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = $1`, [run])
  })

  it('retry writes push the task out with the database clock', async () => {
    const run = await makeRun(1)
    const t = (await claim('worker-r'))!
    expect(await tasks.failTask(db.pool, t, { kind: 'retry', delayMs: 60_000, errorCode: 'rate_limited', errorMessage: '429', httpStatus: 429 })).toBe(true)
    const r = await db.pool.query<{ status: string; due_in: number }>(`SELECT status, EXTRACT(EPOCH FROM (available_at - now())) AS due_in FROM case_results WHERE id = $1`, [t.id])
    expect(r.rows[0].status).toBe('pending')
    expect(Number(r.rows[0].due_in)).toBeGreaterThan(55)
    const next = await claim('worker-r')
    expect(next?.id).not.toBe(t.id)
    await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = $1`, [run])
  })

  it('finalizeRun transitions exactly once under concurrency', async () => {
    const run = await makeRun(4, 1)
    await db.pool.query(`UPDATE eval_runs SET status = 'running' WHERE id = $1`, [run])
    await db.pool.query(`UPDATE case_results SET status = CASE WHEN sample_index = 0 AND case_key = 't-023' THEN 'errored' ELSE 'succeeded' END WHERE run_id = $1`, [run])
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => tasks.finalizeRun(db.pool, run)))
    expect(outcomes.filter(Boolean)).toEqual(['completed'])
  })

  it('serves concurrent runs round robin', async () => {
    const a = await makeRun(10)
    const b = await makeRun(10)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) seen.push((await claim('worker-f'))!.runId)
    expect(seen.filter((r) => r === a)).toHaveLength(3)
    expect(seen.filter((r) => r === b)).toHaveLength(3)
    await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = ANY($1)`, [[a, b]])
  })

  it('run creation is idempotent under concurrent duplicates', async () => {
    const key = `racetest-${Date.now()}`
    const body = { datasetVersionId: 'dsv_triage_2', promptVersionId: 'pv_triage_2', modelConfigId: 'mc_small_t07', scorerVersionIds: ['scv_exact_1'], samplesPerCase: 1 }
    const results = await Promise.all(Array.from({ length: 5 }, () => runs.createRun('ws_acme', 'usr_alice', key, body)))
    expect(new Set(results.map((r) => r.runId)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    const count = await db.pool.query<{ n: number }>('SELECT count(*) AS n FROM case_results WHERE run_id = $1', [results[0].runId])
    expect(count.rows[0].n).toBe(23)
    await expect(runs.createRun('ws_acme', 'usr_alice', key, { ...body, samplesPerCase: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    await db.pool.query(`UPDATE eval_runs SET status = 'cancelled' WHERE id = $1`, [results[0].runId])
  })
})
