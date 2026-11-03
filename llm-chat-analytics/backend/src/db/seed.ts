/**
 * Seeds PostgreSQL (orgs, users, roles, prices, metric coverage) and produces
 * 35 days of on-time chat history to Kafka. Ingest drains that backlog when it
 * starts, so the dashboard shows "catching up" until the watermark reaches now.
 *
 *   npm run db:seed              # skips history if it was already produced
 *   npm run db:seed -- --reset   # stop the backend first: wipes ClickHouse, Valkey keys and the topic
 */
import bcrypt from 'bcryptjs'
import { DateTime } from 'luxon'
import { redis } from '../shared/cache.js'
import { clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { ensureTopic, kafka } from '../shared/kafka.js'
import { DAY, MINUTE } from '../shared/time.js'
import { produceHistory } from '../generator/produce.js'
import { defaultIncidents } from '../generator/traffic.js'
import { MODELS, ORGS } from '../generator/profiles.js'

const HISTORY_DAYS = Number(process.env.SEED_HISTORY_DAYS || 35)
const reset = process.argv.includes('--reset')

const USERS = [
  { username: 'alice', name: 'Alice Moreno', staff: false, roles: { larkspur: 'admin', kestrel: 'analyst' } },
  { username: 'bob', name: 'Bob Okafor', staff: false, roles: { larkspur: 'analyst' } },
  { username: 'carol', name: 'Carol Iyer', staff: false, roles: { kestrel: 'admin', atelier: 'admin' } },
  { username: 'dana', name: 'Dana Lindqvist (support)', staff: true, roles: {} },
] as const

async function seedPostgres(): Promise<void> {
  for (const org of ORGS) {
    await pool.query(
      `INSERT INTO orgs (id, name, time_zone) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, time_zone = EXCLUDED.time_zone`,
      [org.id, org.name, org.timeZone],
    )
  }
  const hash = await bcrypt.hash('password123', 10)
  for (const u of USERS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (username, password_hash, display_name, is_staff) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name, is_staff = EXCLUDED.is_staff
       RETURNING id`,
      [u.username, hash, u.name, u.staff],
    )
    for (const [orgId, role] of Object.entries(u.roles)) {
      await pool.query(
        `INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
        [rows[0].id, orgId, role],
      )
    }
  }
  const priceStart = new Date(Date.now() - 400 * DAY)
  for (const m of MODELS) {
    await pool.query(
      `INSERT INTO model_prices (model, effective_from, input_micros_per_mtok, output_micros_per_mtok)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [m.id, priceStart, m.inputMicrosPerMTok, m.outputMicrosPerMTok],
    )
  }

  // Relative to today, so a fresh seed always shows both coverage states.
  const today = DateTime.utc().startOf('day')
  const abandonFrom = today.minus({ days: 14 }).toISODate()
  const coverage = [
    { metric: 'abandon_rate', collected: abandonFrom, available: abandonFrom, note: 'The chat server started reporting abandoned generations on this date. Earlier generations that were stopped were never recorded.' },
    { metric: 'responses_abandoned', collected: abandonFrom, available: abandonFrom, note: 'Same collection start as abandon rate.' },
    {
      metric: 'tokens_per_response',
      collected: today.minus({ days: HISTORY_DAYS }).toISODate(),
      available: today.minus({ days: 3 }).toISODate(),
      note: 'New metric. Its inputs exist in the raw events for all of history; rollups are recomputed backwards by `npm run rollups:rebuild`.',
    },
  ]
  for (const c of coverage) {
    await pool.query(
      `INSERT INTO metric_coverage (metric, collected_from, available_from, note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (metric) DO ${reset ? 'UPDATE SET collected_from = EXCLUDED.collected_from, available_from = EXCLUDED.available_from, note = EXCLUDED.note' : 'NOTHING'}`,
      [c.metric, c.collected, c.available, c.note],
    )
  }
  console.log(`Seeded ${ORGS.length} orgs, ${USERS.length} users (password: password123), prices and metric coverage`)
}

async function wipe(): Promise<void> {
  for (const table of ['events', 'rejected_events', 'rollup_minute', 'rollup_hour', 'rollup_day_local']) {
    await clickhouse.command({ query: `TRUNCATE TABLE IF EXISTS ${table}` })
  }
  for (const pattern of ['dedup:*', 'ingest:*', 'rev:*', 'q:*', 'generator:*']) {
    let cursor = '0'
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
      cursor = next
      if (found.length) await redis.unlink(...found)
    } while (cursor !== '0')
  }
  const admin = kafka.admin()
  await admin.connect()
  try {
    if ((await admin.listTopics()).includes(config.kafka.topic)) {
      await admin.deleteTopics({ topics: [config.kafka.topic] })
      await new Promise((r) => setTimeout(r, 2000))
    }
    await admin.deleteGroups([config.kafka.groupId]).catch(() => undefined)
  } finally {
    await admin.disconnect()
  }
  console.log('Wiped ClickHouse tables, Valkey keys, the Kafka topic and the consumer group')
}

async function seedHistory(): Promise<void> {
  if (!reset && (await redis.get('generator:cursor'))) {
    console.log('History was already produced (generator:cursor is set); skipping. Use --reset to start over.')
    return
  }
  await ensureTopic()
  const producer = kafka.producer({ allowAutoTopicCreation: false })
  await producer.connect()
  try {
    const to = Math.floor(Date.now() / MINUTE) * MINUTE
    const { rows } = await pool.query<{ collected_from: Date }>("SELECT collected_from FROM metric_coverage WHERE metric = 'abandon_rate'")
    const started = Date.now()
    const n = await produceHistory(producer, to - HISTORY_DAYS * DAY, to, {
      abandonTrackedFrom: rows[0].collected_from.getTime(),
      incidents: defaultIncidents(to),
      anchor: to,
    })
    console.log(`Produced ${n} events (${HISTORY_DAYS} days) to Kafka in ${((Date.now() - started) / 1000).toFixed(1)}s; ingest will drain them`)
  } finally {
    await producer.disconnect()
  }
}

try {
  if (reset) await wipe()
  await seedPostgres()
  await seedHistory()
} catch (err) {
  console.error('Seed failed:', err)
  process.exitCode = 1
} finally {
  await Promise.allSettled([pool.end(), redis.quit(), clickhouse.close()])
}
