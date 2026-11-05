import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory stand-in for the two tables ingest touches, honouring ON CONFLICT DO NOTHING.
const passes = new Map<string, { sha: string; publishedAt: Date | null }>()
const readings = new Map<string, number>()
const published: string[] = []

async function fakeQuery(sql: string, params: unknown[] = []) {
  if (sql.includes('SELECT id FROM detectors')) return { rows: (params[0] as string[]).filter((id) => id.startsWith('HBD-')).map((id) => ({ id })), rowCount: 1 }
  if (sql.includes('INSERT INTO detector_passes')) {
    const key = `${params[0]}|${params[1]}`
    if (passes.has(key)) return { rows: [], rowCount: 0 }
    passes.set(key, { sha: params[13] as string, publishedAt: null })
    return { rows: [], rowCount: 1 }
  }
  if (sql.includes('INSERT INTO axle_readings')) {
    const key = `${params[0]}|${params[1]}`
    readings.set(key, (readings.get(key) ?? 0) + (params[2] as number[]).length)
    return { rows: [], rowCount: (params[2] as number[]).length }
  }
  if (sql.includes('SELECT payload_sha, published_at')) {
    const row = passes.get(`${params[0]}|${params[1]}`)!
    return { rows: [{ payload_sha: row.sha, published_at: row.publishedAt }], rowCount: 1 }
  }
  if (sql.includes('SET published_at = now()')) {
    passes.get(`${params[0]}|${params[1]}`)!.publishedAt = new Date()
    return { rows: [], rowCount: 1 }
  }
  throw new Error(`unexpected SQL: ${sql}`)
}

vi.mock('../../shared/db.js', () => ({
  pool: { query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) }),
}))
vi.mock('../../shared/stream.js', () => ({
  publishPass: async (_client: unknown, detectorId: string, passId: string) => {
    published.push(`${detectorId}|${passId}`)
    return '1-0'
  },
}))

const { ingestBatch, batchSchema } = await import('./ingest.js')

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
  published.length = 0
})

describe('ingestBatch', () => {
  it('stores and publishes a new pass once, and acknowledges a retry as a duplicate without republishing', async () => {
    const first = await ingestBatch(batch(pass('P1', '2026-11-05T13:58:00Z')), receivedAt, {} as never)
    expect(first).toMatchObject({ accepted: 1, duplicates: 0 })
    const retry = await ingestBatch(batch(pass('P1', '2026-11-05T13:58:00Z')), receivedAt, {} as never)
    expect(retry).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(readings.get('HBD-112|P1')).toBe(4)
    expect(published).toEqual(['HBD-112|P1'])
  })

  it('marks passes measured long before they arrived as late, in any order within the batch', async () => {
    const res = await ingestBatch(batch(pass('P3', '2026-11-05T13:55:00Z'), pass('P2', '2026-11-05T12:50:00Z')), receivedAt, {} as never)
    expect(res.results.map((r) => [r.passId, r.late, r.lagMinutes])).toEqual([
      ['P3', false, 5],
      ['P2', true, 70],
    ])
  })

  it('publishes on retry if the first attempt committed but crashed before publishing', async () => {
    passes.set('HBD-112|P4', { sha: 'x', publishedAt: null })
    const p = pass('P4', '2026-11-05T13:58:00Z')
    const { payloadSha } = await import('./ingest.js')
    passes.get('HBD-112|P4')!.sha = payloadSha(p)
    const res = await ingestBatch(batch(p), receivedAt, {} as never)
    expect(res.duplicates).toBe(1)
    expect(published).toEqual(['HBD-112|P4'])
  })

  it('reports a retry with different readings as a conflict and keeps the first copy', async () => {
    await ingestBatch(batch(pass('P5', '2026-11-05T13:58:00Z', 100)), receivedAt, {} as never)
    const res = await ingestBatch(batch(pass('P5', '2026-11-05T13:58:00Z', 140)), receivedAt, {} as never)
    expect(res.results[0].status).toBe('conflict')
    expect(published).toEqual(['HBD-112|P5'])
  })

  it('rejects a batch naming an unknown detector', async () => {
    const bad = batchSchema.parse({ gatewayId: 'GW-1', sentAt: receivedAt.toISOString(), passes: [{ ...pass('P6', '2026-11-05T13:58:00Z'), detectorId: 'XYZ-1' }] })
    await expect(ingestBatch(bad, receivedAt, {} as never)).rejects.toMatchObject({ status: 422, code: 'UNKNOWN_DETECTOR' })
  })

  it('validates axle sequence numbers against the axle count', () => {
    const p = pass('P7', '2026-11-05T13:58:00Z')
    expect(batchSchema.safeParse({ gatewayId: 'GW', sentAt: receivedAt.toISOString(), passes: [{ ...p, axleCount: 1 }] }).success).toBe(false)
  })
})
