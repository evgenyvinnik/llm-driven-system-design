/**
 * Rebuilds projections from the event store, from global position 0, through
 * the same reducers the live projector uses, and reports whether the rebuilt
 * read model matches what was live (md5 over every row).
 *
 *   npm run replay -- hazards
 *   npm run replay -- all
 */
import { pool } from '../shared/db.js'
import { PROJECTIONS, projectionByName } from '../projector/projections.js'
import { rebuildProjection } from '../projector/store.js'

const arg = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'all'
const targets = arg === 'all' ? PROJECTIONS : [projectionByName(arg)].filter((p) => p !== undefined)
if (targets.length === 0) {
  console.error(`Unknown projection "${arg}". Use one of: ${PROJECTIONS.map((p) => p.name).join(', ')}, all`)
  process.exit(2)
}

let mismatched = 0
for (const projection of targets) {
  const r = await rebuildProjection(projection)
  const verdict = r.match ? 'MATCH' : r.liveStreamsBehind > 0 ? 'DIFFERENT (live projection was behind; replay caught it up)' : 'DIFFERENT'
  if (!r.match) mismatched += 1
  console.log(
    `${r.projection.padEnd(13)} replayed ${String(r.eventsReplayed).padStart(5)} events in ${String(r.ms).padStart(4)} ms | ` +
      `live ${r.before.rows} rows ${r.before.md5.slice(0, 12)} | rebuilt ${r.after.rows} rows ${r.after.md5.slice(0, 12)} | ${verdict}`,
  )
}
await pool.end()
process.exit(mismatched > 0 ? 1 : 0)
