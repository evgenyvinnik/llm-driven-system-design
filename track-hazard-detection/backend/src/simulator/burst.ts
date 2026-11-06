/**
 * Priority-lane demo. One gateway uploads a large bulk backlog; once the
 * correlator's bulk lane is visibly backed up, another gateway reports a
 * critical slide-fence trip. Prints how long the correlator took to act on the
 * critical event while the bulk lane was still draining.
 *
 *   npm run demo:burst -- --backlog 5000
 */
import { randomUUID } from 'node:crypto'
import { redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { fieldsToObject, partitionsOf } from '../shared/streams.js'
import { postBatch } from './client.js'

const i = process.argv.indexOf('--backlog')
const backlog = i >= 0 ? Number(process.argv[i + 1]) || 5000 : 5000

async function bulkLag(): Promise<number> {
  let lag = 0
  for (const key of partitionsOf('edge.bulk')) {
    const groups = (await redis.xinfo('GROUPS', key)) as unknown[]
    for (const g of groups) {
      const o = fieldsToObject((g as unknown[]).map(String))
      if (o.name === 'correlator') lag += (Number(o.lag) || 0) + (Number(o.pending) || 0)
    }
  }
  return lag
}

const start = Date.now() - 3 * 3600_000
const seq0 = Date.now() * 100
const bulk = Array.from({ length: backlog }, (_, n) => ({
  eventId: randomUUID(),
  seq: seq0 + n,
  type: 'SensorReadingReported',
  version: 1,
  occurredAt: new Date(start + n * 1000).toISOString(),
  payload: { sensorId: 'GEO-195.0', kind: 'vibration', windowSec: 10, peakMmS: 0.8, rmsMmS: 0.3 },
}))

const t0 = Date.now()
console.log('bulk backlog', await postBatch({ sourceId: 'GW-PRA-2', batchId: randomUUID(), events: bulk }), `in ${Date.now() - t0} ms`)
let lag = 0
for (let n = 0; n < 50 && lag < Math.min(1000, backlog / 2); n++) {
  lag = await bulkLag()
  await new Promise((r) => setTimeout(r, 50))
}
console.log(`correlator bulk lane backlog before the critical event: ${lag}`)

const fenceId = randomUUID()
const fence = {
  eventId: fenceId,
  seq: Date.now() * 100,
  type: 'SlideFenceTripped',
  version: 1,
  occurredAt: new Date().toISOString(),
  payload: { sensorId: 'FNC-113.0', wire: 1, interlockSignalDropped: true, signalId: 'CAN-1130W' },
}
await postBatch({ sourceId: 'GW-CAN-2', batchId: randomUUID(), events: [fence] })

for (let n = 0; n < 300; n++) {
  // The correlator's decision: an evidence row for the trip (it opens a hazard, or joins the open one at that fence).
  const { rows } = await pool.query<{ recorded_at: Date; hazard_id: string | null }>('SELECT recorded_at, hazard_id FROM evidence WHERE event_id = $1', [fenceId])
  if (rows[0]) {
    console.log(`correlator decided on the fence trip ${new Date(rows[0].recorded_at).getTime() - Date.parse(fence.occurredAt)} ms after it occurred (hazard ${rows[0].hazard_id?.slice(0, 8) ?? 'none'})`)
    console.log(`correlator bulk lane backlog at that moment: ${await bulkLag()}`)
    break
  }
  await new Promise((r) => setTimeout(r, 20))
}
await pool.end()
redis.disconnect()
