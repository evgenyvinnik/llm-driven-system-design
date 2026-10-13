/**
 * Sync push endpoint: per-operation results, poison operations rejected individually,
 * and one fan-out notification for the batch.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'net'
import type http from 'http'
import type { Request, Response, NextFunction } from 'express'

const USER = '11111111-2222-4333-8444-555555555555'

vi.mock('../shared/auth.js', () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    req.userId = USER
    next()
  },
}))
vi.mock('../shared/db.js', () => ({ query: vi.fn() }))
vi.mock('../shared/cache.js', () => ({ redis: { get: vi.fn(), duplicate: vi.fn() } }))
vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('../shared/highlights.js', () => ({
  createHighlight: vi.fn(),
  updateHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
  changesSince: vi.fn(),
}))
vi.mock('../shared/notify.js', () => ({
  notifyDevices: vi.fn(),
  syncChannel: (userId: string) => `sync:user:${userId}`,
  deviceIdFrom: (req: Request) => req.header('x-device-id') ?? 'api',
}))

import { app } from './app.js'
import { HttpError } from '../shared/errors.js'
import { changesSince, createHighlight, deleteHighlight, updateHighlight } from '../shared/highlights.js'
import { notifyDevices } from '../shared/notify.js'

const BOOK = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const H1 = '9b2c1d0e-1111-4222-8333-444455556666'
const H2 = '9b2c1d0e-1111-4222-8333-777777777777'

let server: http.Server
let base: string

beforeAll(async () => {
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
})
beforeEach(() => {
  vi.clearAllMocks()
})

function push(ops: unknown[]): Promise<globalThis.Response> {
  return fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'kindle-1' },
    body: JSON.stringify({ ops }),
  })
}

describe('POST /api/sync/push', () => {
  it('applies each operation in order and rejects invalid ones without failing the batch', async () => {
    vi.mocked(createHighlight).mockResolvedValue({ status: 'created', highlight: { id: H1 } as never, seq: 7 })
    vi.mocked(updateHighlight).mockResolvedValue({ status: 'not_found', seq: null })
    vi.mocked(deleteHighlight).mockResolvedValue({ status: 'deleted', highlight: { id: H2 } as never, seq: 8 })

    const res = await push([
      {
        opId: 'a',
        kind: 'create',
        highlight: { id: H1, bookId: BOOK, locationStart: 0, locationEnd: 10, text: 'some words' },
        clientUpdatedAt: 1_700_000_000_000,
      },
      { opId: 'b', kind: 'update', id: H2, changes: {} },
      { opId: 'c', kind: 'update', id: H2, changes: { note: 'n' } },
      { opId: 'd', kind: 'delete', id: H2 },
    ])

    expect(res.status).toBe(200)
    const { results } = (await res.json()) as { results: Array<{ opId: string; status: string }> }
    expect(results.map((r) => [r.opId, r.status])).toEqual([
      ['a', 'created'],
      ['b', 'rejected'],
      ['c', 'not_found'],
      ['d', 'deleted'],
    ])
    expect(createHighlight).toHaveBeenCalledWith(USER, expect.objectContaining({ id: H1 }), {
      deviceId: 'kindle-1',
      clientTs: 1_700_000_000_000,
    })
    expect(notifyDevices).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyDevices).mock.calls[0].slice(0, 3)).toEqual([USER, 8, 'kindle-1'])
  })

  it('reports a 422 from the write path as a rejected operation', async () => {
    vi.mocked(createHighlight).mockRejectedValue(new HttpError(422, 'Highlight id was already used for a different highlight'))
    const res = await push([
      { opId: 'x', kind: 'create', highlight: { id: H1, bookId: BOOK, locationStart: 0, locationEnd: 4, text: 'word' } },
    ])
    const { results } = (await res.json()) as { results: Array<{ status: string; error: string }> }
    expect(results[0].status).toBe('rejected')
    expect(results[0].error).toContain('different highlight')
    expect(notifyDevices).not.toHaveBeenCalled()
  })

  it('does not notify when nothing changed (a replayed batch)', async () => {
    vi.mocked(createHighlight).mockResolvedValue({ status: 'replayed', highlight: { id: H1 } as never, seq: null })
    await push([
      { opId: 'r', kind: 'create', highlight: { id: H1, bookId: BOOK, locationStart: 0, locationEnd: 4, text: 'word' } },
    ])
    expect(notifyDevices).not.toHaveBeenCalled()
  })

  it('rejects an empty or oversized batch', async () => {
    expect((await push([])).status).toBe(400)
    expect((await push(Array.from({ length: 101 }, (_, i) => ({ opId: String(i), kind: 'delete', id: H1 })))).status).toBe(400)
  })
})

describe('GET /api/sync/changes', () => {
  it('passes the cursor and a clamped limit to the change feed', async () => {
    vi.mocked(changesSince).mockResolvedValue({ changes: [], cursor: 41, hasMore: false, resync: false })
    const res = await fetch(`${base}/api/sync/changes?since=41&limit=99999`)
    expect(await res.json()).toEqual({ changes: [], cursor: 41, hasMore: false, resync: false })
    expect(changesSince).toHaveBeenCalledWith(USER, 41, 500)
  })
})
