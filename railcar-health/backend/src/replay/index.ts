/**
 * Replay tool.
 *
 *   npm run replay -- alert-queue          rebuild one projection from position 0 and compare with the live tables
 *   npm run replay -- all                  every projection
 *   npm run replay -- swap-case [--trip T] re-derive the "late reading after a wheelset swap" decision from events alone
 *   add --keep to leave the rebuilt tables in the `replay` schema for inspection
 *
 * Projection replay runs in one REPEATABLE READ transaction: it reads the live
 * group's checkpoint per broker stream, applies exactly the events at or below
 * those positions (in global order) into shadow tables with the same apply code
 * the live projector uses, then compares the shadow and live tables row for row
 * (EXCEPT in both directions) inside the same snapshot. Equal means the live
 * projection is exactly what its events say; anything else is a bug (or an event
 * sitting in the dead-letter stream).
 */
process.env.SERVICE_NAME ??= 'replay'
process.env.LOG_LEVEL ??= 'warn'
import { parseArgs } from 'node:util'
import { pool } from '../shared/db.js'
import { redis } from '../shared/cache.js'
import { listDeadLetters } from '../events/dlq.js'
import { applyEvents, eventsFor } from '../events/catchup.js'
import { projectionSpecs, type GroupSpec } from '../events/topology.js'
import { familyOfKey } from '../shared/stream.js'
import { replaySwapCase } from './swap-case.js'

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { keep: { type: 'boolean', default: false }, trip: { type: 'string' } } })
const target = positionals[0]

async function replayProjection(spec: GroupSpec): Promise<boolean> {
  const tables = spec.tables ?? []
  const client = await pool.connect()
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS replay')
    for (const t of tables) {
      await client.query(`DROP TABLE IF EXISTS replay.${t}`)
      await client.query(`CREATE TABLE replay.${t} (LIKE public.${t} INCLUDING ALL)`)
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const { rows: cps } = await client.query<{ stream_key: string; last_position: number }>('SELECT stream_key, last_position FROM consumer_checkpoints WHERE group_name = $1', [spec.group])
    const upTo = new Map(cps.map((c) => [familyOfKey(c.stream_key), Number(c.last_position)]))
    const events = await eventsFor(client, spec.group, upTo)
    await client.query('SET LOCAL search_path TO replay, public')
    const started = Date.now()
    await applyEvents(client, spec.group, events)
    const ms = Date.now() - started
    let match = true
    console.log(`\n${spec.name}  (${spec.group})  ${events.length} events replayed from position 0 in ${ms} ms`)
    console.log(`  checkpoints: ${[...upTo].map(([f, p]) => `${f} ≤ ${p}`).join(', ') || 'none'}`)
    for (const t of tables) {
      // One client, one snapshot: these run one after another.
      const live = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${t}`)
      const replayed = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM replay.${t}`)
      const onlyLive = await client.query(`SELECT * FROM (SELECT * FROM public.${t} EXCEPT ALL SELECT * FROM replay.${t}) d LIMIT 3`)
      const onlyReplay = await client.query(`SELECT * FROM (SELECT * FROM replay.${t} EXCEPT ALL SELECT * FROM public.${t}) d LIMIT 3`)
      const ok = onlyLive.rowCount === 0 && onlyReplay.rowCount === 0
      match &&= ok
      console.log(`  ${ok ? 'MATCH   ' : 'MISMATCH'} ${t.padEnd(22)} live ${String(live.rows[0].n).padStart(5)}  replay ${String(replayed.rows[0].n).padStart(5)}`)
      if (!ok) {
        for (const r of onlyLive.rows) console.log(`      only live:   ${JSON.stringify(r).slice(0, 240)}`)
        for (const r of onlyReplay.rows) console.log(`      only replay: ${JSON.stringify(r).slice(0, 240)}`)
      }
    }
    await client.query('COMMIT')
    if (!match) {
      const dead = (await listDeadLetters(redis, 1000)).filter((d) => d.group === spec.group)
      if (dead.length > 0) console.log(`  note: ${dead.length} ${spec.group} message(s) are in the dead-letter stream; the live projection has not applied them yet (redrive them)`)
    }
    if (!args.keep) for (const t of tables) await client.query(`DROP TABLE IF EXISTS replay.${t}`)
    return match
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  const specs = projectionSpecs()
  if (!target || (target !== 'all' && target !== 'swap-case' && !specs.some((s) => s.name === target))) {
    console.log(`usage: npm run replay -- <${specs.map((s) => s.name).join('|')}|all|swap-case> [--keep] [--trip <tripId>]`)
    process.exitCode = 2
    return
  }
  if (target === 'swap-case') {
    process.exitCode = (await replaySwapCase(pool, args.trip)) ? 0 : 1
    return
  }
  let ok = true
  for (const spec of specs.filter((s) => target === 'all' || s.name === target)) ok = (await replayProjection(spec)) && ok
  console.log(ok ? '\nReplay matches the live projection(s).' : '\nReplay does NOT match: see the rows above.')
  process.exitCode = ok ? 0 : 1
}

try {
  await main()
} finally {
  await pool.end()
  redis.disconnect()
}
