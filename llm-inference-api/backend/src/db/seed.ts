/**
 * Seeds tiers, four orgs on three tiers, console users, API keys with known
 * local secrets, and a little request/batch history so every screen has data
 * before the load generator runs. Truncates everything and clears `inf:*` keys.
 * All console passwords are `password123`.
 */
import bcrypt from 'bcryptjs'
import { createHash, randomUUID } from 'node:crypto'
import { keys, redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { KEYS, ORGS, TIERS } from './fixtures.js'

const USERS = [
  { username: 'alice', name: 'Alice Romero', admin: false, orgs: [['acme', 'owner'], ['initech', 'member']] },
  { username: 'bob', name: 'Bob Tanaka', admin: false, orgs: [['globex', 'owner']] },
  { username: 'admin', name: 'Ada Admin', admin: true, orgs: [['acme', 'member']] },
]

const SYSTEMS = [
  'You are a support assistant for Acme Robotics. Answer from the product manual, cite the section, and keep answers under 120 words.',
  'You summarize research notes for Globex Labs into three bullet points and one open question.',
  'You classify incoming documents for Umbrella Data into one of twelve categories and explain the choice in one sentence.',
]

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function seed(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('TRUNCATE usage, batches, requests, api_keys, memberships, users, orgs, tiers CASCADE')
    for (const t of TIERS) {
      await client.query(
        'INSERT INTO tiers (name, tokens_per_minute, requests_per_minute, max_queued_interactive, max_queued_batch, weight) VALUES ($1,$2,$3,$4,$5,$6)',
        [t.name, t.tpm, t.rpm, t.qi, t.qb, t.weight],
      )
    }
    const orgIds = new Map<string, string>()
    for (const o of ORGS) {
      const { rows } = await client.query<{ id: string }>('INSERT INTO orgs (slug, name, tier) VALUES ($1,$2,$3) RETURNING id', [o.slug, o.name, o.tier])
      orgIds.set(o.slug, rows[0].id)
    }
    const hash = await bcrypt.hash('password123', 10)
    for (const u of USERS) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING id',
        [u.username, u.name, hash, u.admin],
      )
      for (const [org, role] of u.orgs) await client.query('INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,$3)', [rows[0].id, orgIds.get(org), role])
    }
    const keyIds = new Map<string, string>()
    for (const k of KEYS) {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO api_keys (org_id, name, key_prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id',
        [orgIds.get(k.org), k.name, `${k.secret.slice(0, 14)}…`, sha(k.secret)],
      )
      keyIds.set(`${k.org}/${k.name}`, rows[0].id)
    }

    // History: completed, cancelled and failed requests over the last half hour, with batches.
    const now = Date.now()
    const plan: { key: string; mode: 'sync' | 'stream' | 'async'; status: string; sys: number }[] = []
    const keyCycle = ['acme/production', 'acme/production', 'acme/staging', 'globex/default', 'initech/hack-day', 'umbrella/bulk-ingest']
    for (let i = 0; i < 24; i++) {
      const status = i === 7 ? 'cancelled' : i === 12 ? 'failed' : 'completed'
      plan.push({ key: keyCycle[i % keyCycle.length], mode: (['stream', 'sync', 'async'] as const)[i % 3], status, sys: i % SYSTEMS.length })
    }
    let batchId = randomUUID()
    for (const [i, p] of plan.entries()) {
      if (i % 3 === 0) {
        batchId = randomUUID()
        await client.query(
          'INSERT INTO batches (id, priority_class, size, max_size, trigger, oldest_wait_ms, backends, created_at) VALUES ($1,$2,$3,4,$4,$5,$6, to_timestamp($7/1000.0))',
          [batchId, p.mode === 'async' ? 'batch' : 'interactive', 3, i % 2 ? 'full' : 'max_wait', i % 2 ? 4 : 25, JSON.stringify({ b1: 2, b2: 1 }), now - (30 - i) * 60_000],
        )
      }
      const [org, keyName] = p.key.split('/')
      const backend = ['b1', 'b2', 'b3'][i % 3]
      const id = `req_seed_${String(i + 1).padStart(4, '0')}`
      const created = now - (30 - i) * 60_000 - 2000
      const cls = p.mode === 'async' ? 'batch' : 'interactive'
      const queueMs = 8 + ((i * 37) % 60)
      const ttftMs = i % 4 === 0 ? 640 + (i % 5) * 20 : 130 + (i % 3) * 10
      const outTok = p.status === 'cancelled' ? 12 : p.status === 'failed' ? 9 : 40 + ((i * 13) % 90)
      const execMs = ttftMs + outTok * 26
      const input = { system: SYSTEMS[p.sys], messages: [{ role: 'user', content: `Seeded example request ${i + 1}` }], metadata: null }
      const inputTokens = Math.ceil(SYSTEMS[p.sys].length / 4) + 10
      await client.query(
        `INSERT INTO requests (id, org_id, api_key_id, model, mode, priority_class, status, max_tokens, est_input_tokens, est_cost_tokens, prefix_key, prefix_tokens,
           input, output_text, stop_reason, error_type, error_message, cancel_reason, backend_id, model_version, batch_id, attempts, affinity, deadline_at,
           created_at, dispatched_at, first_token_at, finished_at)
         VALUES ($1,$2,$3,'mock-large',$4,$5,$6,256,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'mock-large-2026-10',$18,1,$19,
           to_timestamp($20/1000.0), to_timestamp($21/1000.0), to_timestamp($22/1000.0), to_timestamp($23/1000.0), to_timestamp($24/1000.0))`,
        [
          id, orgIds.get(org), keyIds.get(p.key), p.mode, cls, p.status, inputTokens, inputTokens + 256, sha(SYSTEMS[p.sys]).slice(0, 16), Math.ceil(SYSTEMS[p.sys].length / 4),
          JSON.stringify(input),
          p.status === 'failed' ? 'Admission control charges the estimated cost before any work is queued. The request id' : 'Admission control charges the estimated cost before any work is queued. The request id is assigned at the edge and owns the work from then on.',
          p.status === 'completed' ? 'end_turn' : null,
          p.status === 'failed' ? 'api_error' : null,
          p.status === 'failed' ? `Backend ${backend} failed after 9 output tokens. Output had started, so the request cannot move to another backend; retry it.` : null,
          p.status === 'cancelled' ? 'client_disconnected' : null,
          backend, batchId, i % 4 === 0 ? 'spill' : 'primary',
          created + 3_600_000, created, created + queueMs, created + queueMs + ttftMs, created + queueMs + execMs,
        ],
      )
      await client.query(
        `INSERT INTO usage (request_id, org_id, api_key_id, priority_class, status, input_tokens, cached_input_tokens, output_tokens, reserved_tokens, refunded_tokens,
           queue_ms, ttft_ms, exec_ms, total_ms, tokens_per_sec, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, to_timestamp($16/1000.0))`,
        [
          id, orgIds.get(org), keyIds.get(p.key), cls, p.status, inputTokens, i % 4 === 0 ? 0 : Math.ceil(SYSTEMS[p.sys].length / 4), outTok,
          inputTokens + 256, Math.max(0, 256 - outTok), queueMs, ttftMs, execMs, queueMs + execMs, 38.5, created + queueMs + execMs,
        ],
      )
      void keyName
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  // Clear every Valkey key of this project (buckets, queues, logs, sessions, config).
  let cursor = '0'
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.pattern, 'COUNT', 500)
    cursor = next
    if (found.length > 0) await redis.del(...found)
  } while (cursor !== '0')
}

try {
  await seed()
  console.log('Seeded: 3 tiers, 4 orgs, 3 users (password123), 5 API keys, 24 historical requests')
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await pool.end()
  redis.disconnect()
}
