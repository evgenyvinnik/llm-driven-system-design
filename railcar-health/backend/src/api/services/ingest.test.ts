import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory stand-in for the fact-log tables ingest touches, honouring ON CONFLICT DO NOTHING.
const passes = new Map<string, { sha: string }>()
const readings = new Map<string, number>()
/** Events staged in the ingest transaction (the outbox), as the store would commit them. */
const committed: Array<{ streamId: string; expected: unknown; type: string; payload: Record<string, unknown>; causationId?: string | null; correlationId?: string }> = []
let failInsertFor: string | null = null

async function fakeQuery(sql: string, params: unknown[] = []) {
  if (sql.includes('SELECT id FROM detectors')) return { rows: (params[0] as string[]).filter((id) => id.startsWith('HBD-')).map((id) => ({ id })), rowCount: 1 }
  if (sql.includes('INSERT INTO detector_passes')) {
    const key = `${params[0]}|${params[1]}`
    if (key === failInsertFor) throw new Error('disk full')
    if (passes.has(key)) return { rows: [], rowCount: 0 }
    passes.set(key, { sha: params[13] as string })
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('INSERT INTO axle_readings')) {
    const key = `${params[0]}|${params[1]}`
    readings.set(key, (readings.get(key) ?? 0) + (params[2] as number[]).length)
    return { rows: [], rowCount: (params[2] as number[]).length }
  }
  if (sql.includes('SELECT payload_sha')) return { rows: [{ payload_sha: passes.get(`${params[0]}|${params[1]}`)!.sha }], rowCount: 1 }
  throw new Error(`unexpected SQL: ${sql}`)
}

vi.mock('../../shared/db.js', () => ({ pool: { query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) } }))
// The transaction: staged events are kept only if the callback finishes (commit), like PostgreSQL would.
vi.mock('../../events/store.js', () => ({
  withEventTransaction: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const staged: typeof committed = []
    let n = 0
    const batch = { append: (streamId: string, expected: unknown, e: (typeof committed)[number]) => (staged.push({ ...e, streamId, expected }), `evt-${++n}`) }
    const result = await fn({ client: { query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) }, batch })
    committed.push(...staged)
    return { result, events: [] }
  },
}))

const { ingestBatch, batchSchema, payloadSha } = await import('./ingest.js')

function pass(passId: string, passedAt: string, bearing = 100) {
  return {
    passId, detectorId: 'HBD-112', tripId: 'Q-HARCDJ-1', passedAt, direction: 'EB' as const, speedMph: 50, ambientF: 60, axleCount: 2,
    axles: [
      { seq: 1, rail: 'N' as const, bearingF: bearing, wheelF: 70 },
      { seq: 1, rail: 'S' as const, bearingF: 101, wheelF: 70 },
      { seq: 2, rail: 'N' as const, bearingF: 99, wheelF: 70 },
      { seq: 2, rail: 'S' as const, bearingF: 98, wheelF: 70 },
    ],
  }
}

const receivedAt = new Date('2026-11-05T14:00:00Z')
const batch = (...p: ReturnType<typeof pass>[]) => batchSchema.parse({ gatewayId: 'GW-112', sentAt: receivedAt.toISOString(), passes: p })

beforeEach(() => {
  passes.clear()
  readings.clear()
  committed.length = 0
  failInsertFor = null
})

describe('ingestBatch: fact log + transactional outbox', () => {
  it('stores a new pass with PassRecorded and AxleReadingsRecorded in the same transaction; a retry is a duplicate and appends nothing', async () => {
    const first = await ingestBatch(batch(pass('P1', '2026-11-05T13:58:00Z')), receivedAt)
    expect(first).toMatchObject({ accepted: 1, duplicates: 0 })
    const retry = await ingestBatch(batch(pass('P1', '2026-11-05T13:58:00Z')), receivedAt)
    expect(retry).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(readings.get('HBD-112|P1')).toBe(4)
    expect(committed.map((e) => e.type)).toEqual(['PassRecorded', 'AxleReadingsRecorded'])
    expect(committed.every((e) => e.streamId === 'pass-HBD-112/P1' && e.expected === 'no_stream')).toBe(true)
  })

  it('makes AxleReadingsRecorded a claim check caused by PassRecorded, in one correlation', () => {
    return ingestBatch(batch(pass('P1', '2026-11-05T13:58:00Z')), receivedAt).then(() => {
      const [recorded, readingsEvent] = committed
      expect(readingsEvent.causationId).toBe('evt-1')
      expect(recorded.correlationId).toBe('pass:HBD-112/P1')
      expect(readingsEvent.correlationId).toBe('pass:HBD-112/P1')
      expect(readingsEvent.payload).toMatchObject({ readingCount: 4, maxBearingF: 101, claimCheck: { store: 'axle_readings', detectorId: 'HBD-112', passId: 'P1' } })
      expect(readingsEvent.payload).not.toHaveProperty('axles')
    })
  })

  it('marks passes measured long before they arrived as late and routes their readings to the backfill lane, in any order within the batch', async () => {
    const res = await ingestBatch(batch(pass('P3', '2026-11-05T13:55:00Z'), pass('P2', '2026-11-05T12:50:00Z')), receivedAt)
    expect(res.results.map((r) => [r.passId, r.late, r.lagMinutes, r.lane])).toEqual([
      ['P3', false, 5, 'live'],
      ['P2', true, 70, 'backfill'],
    ])
    expect(committed.filter((e) => e.type === 'AxleReadingsRecorded').map((e) => `${e.payload.passId}:${e.payload.lane}`)).toEqual(['P3:live', 'P2:backfill'])
  })

  it('has no separate publish step that can be lost: if the transaction fails, neither the pass nor its events exist', async () => {
    failInsertFor = 'HBD-112|P4'
    await expect(ingestBatch(batch(pass('P0', '2026-11-05T13:57:00Z'), pass('P4', '2026-11-05T13:58:00Z')), receivedAt)).rejects.toThrow('disk full')
    expect(committed).toEqual([])
  })

  it('reports a retry with different readings as a conflict, keeps the first copy and appends nothing', async () => {
    await ingestBatch(batch(pass('P5', '2026-11-05T13:58:00Z', 100)), receivedAt)
    const res = await ingestBatch(batch(pass('P5', '2026-11-05T13:58:00Z', 140)), receivedAt)
    expect(res.results[0].status).toBe('conflict')
    expect(passes.get('HBD-112|P5')!.sha).toBe(payloadSha(pass('P5', '2026-11-05T13:58:00Z', 100)))
    expect(committed).toHaveLength(2)
  })

  it('rejects a batch naming an unknown detector', async () => {
    const bad = batchSchema.parse({ gatewayId: 'GW-1', sentAt: receivedAt.toISOString(), passes: [{ ...pass('P6', '2026-11-05T13:58:00Z'), detectorId: 'XYZ-1' }] })
    await expect(ingestBatch(bad, receivedAt)).rejects.toMatchObject({ status: 422, code: 'UNKNOWN_DETECTOR' })
  })

  it('validates axle sequence numbers against the axle count', () => {
    const p = pass('P7', '2026-11-05T13:58:00Z')
    expect(batchSchema.safeParse({ gatewayId: 'GW', sentAt: receivedAt.toISOString(), passes: [{ ...p, axleCount: 1 }] }).success).toBe(false)
  })
})
