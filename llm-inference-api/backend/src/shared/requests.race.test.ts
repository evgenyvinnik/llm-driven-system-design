/**
 * The cancel/complete race against a real PostgreSQL. Runs only when
 * TEST_DATABASE_URL points at a migrated and seeded database, e.g.
 *   TEST_DATABASE_URL=postgresql://inference:inference_password@localhost:5432/llm_inference npm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('cancel vs complete race (PostgreSQL)', () => {
  let mod: typeof import('./requests.js')
  let db: typeof import('./db.js')
  let org = ''
  let key = ''
  const ids: string[] = []

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    db = await import('./db.js')
    mod = await import('./requests.js')
    const { rows } = await db.pool.query<{ org_id: string; id: string }>('SELECT org_id, id FROM api_keys LIMIT 1')
    org = rows[0].org_id
    key = rows[0].id
  })

  afterAll(async () => {
    if (ids.length) await db.pool.query('DELETE FROM requests WHERE id = ANY($1)', [ids])
    await db.pool.end()
  })

  it('exactly one of two concurrent terminal transitions wins, 50 times out of 50', async () => {
    for (let i = 0; i < 50; i++) ids.push(`req_racetest_${Date.now()}_${i}`)
    await db.pool.query(
      `INSERT INTO requests (id, org_id, api_key_id, model, mode, priority_class, status, max_tokens, est_input_tokens, est_cost_tokens, prefix_key, input, deadline_at)
       SELECT unnest($1::text[]), $2, $3, 'mock-large', 'async', 'batch', 'running', 10, 1, 11, 'k', '{}'::jsonb, now() + interval '1 hour'`,
      [ids, org, key],
    )
    let completed = 0
    let cancelled = 0
    await Promise.all(
      ids.map(async (id, i) => {
        const complete = () => mod.transition(db.pool, id, 'completed', { output_text: 'x', finished_at: new Date() })
        const cancel = () => mod.transition(db.pool, id, 'cancelled', { cancel_reason: 'client_request', finished_at: new Date() })
        const [a, b] = await Promise.all(i % 2 ? [complete(), cancel()] : [cancel(), complete()])
        const winners = [a, b].filter(Boolean)
        expect(winners).toHaveLength(1)
        const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM requests WHERE id = $1', [id])
        expect(rows[0].status).toBe(winners[0]!.status)
        if (rows[0].status === 'completed') completed++
        else cancelled++
      }),
    )
    expect(completed + cancelled).toBe(50)
  })

  it('a terminal request never moves again', async () => {
    const id = ids[0]
    expect(await mod.transition(db.pool, id, 'failed', { error_type: 'api_error' })).toBeNull()
    expect(await mod.transition(db.pool, id, 'running', {})).toBeNull()
  })
})
