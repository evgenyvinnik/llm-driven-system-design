/**
 * Recomputes rollups from raw events for a range of org-local days. This is the
 * backfill path for a new metric (and the repair path if a duplicate ever got
 * past ingest dedup, or an org changed its time zone).
 *
 *   npm run rollups:rebuild -- --from 2026-10-01 --to 2026-10-30 [--org larkspur] [--metric tokens_per_response] [--relocalize]
 *
 * Only sealed days are rebuilt: a day older than the maximum lateness can no
 * longer receive events, so deleting and re-inserting its rollups cannot race
 * with the live materialized views. Recent days are refused.
 */
import { DateTime } from 'luxon'
import { keys, redis } from '../shared/cache.js'
import { clickhouse } from '../shared/clickhouse.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { HOUR, startOfLocalDate, toChDateTime } from '../shared/time.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const STATES = `
    countIf(event_type = 'conversation_started') AS conversations,
    countIf(event_type = 'message_sent') AS messages,
    countIf(event_type = 'response_completed') AS responses_ok,
    countIf(event_type = 'response_failed') AS responses_failed,
    countIf(event_type = 'response_abandoned') AS responses_abandoned,
    sum(toUInt64(input_tokens)) AS input_tokens,
    sum(toUInt64(output_tokens)) AS output_tokens,
    sum(cost_micros) AS cost_micros,
    countIf(is_late = 1) AS late_events,
    maxIf(ingested_at, is_late = 1) AS last_revised_at,
    uniqCombined64StateIf(user_id, event_type = 'message_sent') AS active_users,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(ttft_ms, event_type = 'response_completed') AS ttft,
    quantilesTDigestStateIf(0.5, 0.95, 0.99)(latency_ms, event_type = 'response_completed') AS latency`

async function rebuildOrg(org: { id: string; time_zone: string }, from: string, to: string, relocalize: boolean): Promise<void> {
  const settings = { mutations_sync: '2', insert_deduplicate: 0 } as const
  const start = startOfLocalDate(from, org.time_zone)
  const end = startOfLocalDate(to, org.time_zone)
  const h0 = toChDateTime(Math.floor(start / HOUR) * HOUR)
  const h1 = toChDateTime(Math.ceil(end / HOUR) * HOUR)
  const p = { org: org.id, from, to, h0, h1, tz: org.time_zone, s: start / 1000, e: end / 1000 }

  if (relocalize) {
    // The org changed time zone: recompute each raw event's local date with the current zone first.
    await clickhouse.command({
      query: `ALTER TABLE events UPDATE local_date = toDate(event_time, {tz:String}), org_tz = {tz:String}
               WHERE org_id = {org:String} AND event_time >= toDateTime64({s:Float64}, 3, 'UTC') - INTERVAL 1 DAY
                 AND event_time < toDateTime64({e:Float64}, 3, 'UTC') + INTERVAL 1 DAY`,
      query_params: p,
      clickhouse_settings: settings,
    })
  }

  await clickhouse.command({
    query: 'ALTER TABLE rollup_day_local DELETE WHERE org_id = {org:String} AND local_date >= {from:Date} AND local_date < {to:Date}',
    query_params: p,
    clickhouse_settings: settings,
  })
  await clickhouse.command({
    query: `INSERT INTO rollup_day_local
            SELECT local_date, org_id, model, feature, ${STATES}
              FROM events FINAL
             WHERE org_id = {org:String} AND local_date >= {from:Date} AND local_date < {to:Date}
             GROUP BY local_date, org_id, model, feature`,
    query_params: p,
    clickhouse_settings: settings,
  })
  await clickhouse.command({
    query: "ALTER TABLE rollup_hour DELETE WHERE org_id = {org:String} AND bucket >= {h0:DateTime('UTC')} AND bucket < {h1:DateTime('UTC')}",
    query_params: p,
    clickhouse_settings: settings,
  })
  await clickhouse.command({
    query: `INSERT INTO rollup_hour
            SELECT toStartOfHour(toDateTime(event_time, 'UTC')) AS bucket, org_id, model, feature, ${STATES}
              FROM events FINAL
             WHERE org_id = {org:String} AND event_time >= toDateTime64({h0:String}, 3, 'UTC') AND event_time < toDateTime64({h1:String}, 3, 'UTC')
             GROUP BY bucket, org_id, model, feature`,
    query_params: p,
    clickhouse_settings: settings,
  })

  // Cached windows over these days are now stale.
  const days: string[] = []
  for (let d = DateTime.fromISO(from); d.toISODate()! < to; d = d.plus({ days: 1 })) days.push(d.toISODate()!)
  const tx = redis.multi()
  for (const day of days) tx.hincrby(keys.revision(org.id), day, 1)
  await tx.exec()
  console.log(`Rebuilt ${org.id}: ${days.length} local days (${from} → ${to}) and hours ${h0} → ${h1} UTC`)
}

async function main(): Promise<void> {
  const from = arg('from')
  const to = arg('to')
  const metric = arg('metric')
  const onlyOrg = arg('org')
  if (!from || !to) throw new Error('--from and --to (YYYY-MM-DD, local dates, to exclusive) are required')

  const sealedBefore = DateTime.utc().minus({ milliseconds: config.maxLatenessMs }).startOf('day').toISODate()!
  if (to > sealedBefore && !process.argv.includes('--force')) {
    throw new Error(`Days on or after ${sealedBefore} can still receive late events; rebuilding them would race with ingest. Pass --to ${sealedBefore} or --force.`)
  }

  const { rows } = await pool.query<{ id: string; time_zone: string }>(
    'SELECT id, time_zone FROM orgs WHERE $1::text IS NULL OR id = $1 ORDER BY id',
    [onlyOrg ?? null],
  )
  for (const org of rows) await rebuildOrg(org, from, to, process.argv.includes('--relocalize'))

  if (metric) {
    const { rowCount } = await pool.query(
      'UPDATE metric_coverage SET available_from = GREATEST(collected_from, LEAST(available_from, $2::date)) WHERE metric = $1',
      [metric, from],
    )
    console.log(rowCount ? `Coverage for ${metric} now starts at ${from} (or its collection start, if later)` : `No coverage row for ${metric}`)
  }
}

main()
  .catch((err) => {
    console.error('Rebuild failed:', err.message)
    process.exitCode = 1
  })
  .finally(() => Promise.allSettled([pool.end(), redis.quit(), clickhouse.close()]))
