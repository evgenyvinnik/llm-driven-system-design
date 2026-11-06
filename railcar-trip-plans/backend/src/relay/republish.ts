/**
 * Publishes stored events to their partition streams again, exactly as a relay that crashed after XADD but
 * before marking the rows published would on restart. Every consumer group should count each one as a
 * duplicate and change nothing.
 *
 *   npm run relay:republish -- 5636            # one position
 *   npm run relay:republish -- 5600 5636       # a range
 */
process.env.SERVICE_NAME ??= 'republish'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { EVENT_COLUMNS } from '../shared/event-store.js'
import { toWire, type EventRow } from '../shared/events/envelope.js'
import { streamFor } from '../shared/streams.js'

const [from, to = from] = process.argv.slice(2).map(Number)
if (!Number.isFinite(from)) {
  console.error('usage: npm run relay:republish -- <fromPosition> [toPosition]')
  process.exit(1)
}
const { rows } = await pool.query<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE position BETWEEN $1 AND $2 ORDER BY position`, [from, to])
for (const row of rows) {
  const id = await redis.xadd(streamFor(row.topic, row.partition_key), '*', 'id', row.event_id, 'type', row.type, 'key', row.partition_key, 'e', toWire(row))
  console.log(`republished #${row.position} ${row.type} ${row.event_id} → ${streamFor(row.topic, row.partition_key)} ${id}`)
}
await pool.end()
redis.disconnect()
