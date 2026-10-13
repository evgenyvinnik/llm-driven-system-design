/**
 * Popular-highlights API: the privacy threshold is enforced by the server, not the caller.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'net'
import type http from 'http'

vi.mock('../shared/db.js', () => ({ query: vi.fn() }))
vi.mock('../shared/cache.js', () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  withJitter: (ttl: number) => ttl,
  redis: { get: vi.fn() },
}))
vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { app } from './app.js'
import { query } from '../shared/db.js'
import { cacheGet, cacheSet } from '../shared/cache.js'
import { MIN_READERS } from '../shared/privacy.js'

const BOOK = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
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
  vi.mocked(query).mockReset()
  vi.mocked(cacheGet).mockReset()
  vi.mocked(cacheSet).mockReset()
})

const passage = (id: string, readers: number) => ({
  passage_id: id,
  passage_text: `text ${id}`,
  reader_count: readers,
  location_start: 0,
  location_end: 100,
  last_contribution_at: null,
})

describe('GET /api/books/:bookId/popular', () => {
  it('queries with the server threshold even when the caller asks for minCount=1', async () => {
    vi.mocked(cacheGet).mockResolvedValue(null)
    vi.mocked(query).mockResolvedValue({ rows: [passage('0-100', MIN_READERS + 3)] } as never)

    const res = await fetch(`${base}/api/books/${BOOK}/popular?minCount=1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1)

    const params = vi.mocked(query).mock.calls[0][1] as unknown[]
    expect(params[1]).toBe(MIN_READERS)
    expect(cacheSet).toHaveBeenCalledOnce()
  })

  it('filters cached rows by the effective threshold and applies limit', async () => {
    vi.mocked(cacheGet).mockResolvedValue([
      passage('0-100', MIN_READERS + 5),
      passage('100-200', MIN_READERS + 1),
      passage('200-300', MIN_READERS - 1),
    ])

    const res = await fetch(`${base}/api/books/${BOOK}/popular?minCount=1&limit=10`)
    const body = (await res.json()) as Array<{ passage_id: string }>
    expect(body.map((p) => p.passage_id)).toEqual(['0-100', '100-200'])

    const stricter = await fetch(`${base}/api/books/${BOOK}/popular?minCount=${MIN_READERS + 2}`)
    expect(((await stricter.json()) as unknown[]).length).toBe(1)
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects a malformed book id before touching the database', async () => {
    const res = await fetch(`${base}/api/books/not-a-uuid/popular`)
    expect(res.status).toBe(400)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('GET /api/books/:bookId/count', () => {
  it('answers null instead of a sub-threshold count', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never)
    const res = await fetch(`${base}/api/books/${BOOK}/count?start=203&end=219`)
    expect(await res.json()).toEqual({ passageId: '200-300', readers: null })
    const params = vi.mocked(query).mock.calls[0][1] as unknown[]
    expect(params).toEqual([BOOK, '200-300', MIN_READERS])
  })
})
