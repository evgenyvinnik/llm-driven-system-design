/**
 * Highlight create: a retried upload returns the original highlight, never a duplicate.
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
vi.mock('../shared/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('../shared/highlights.js', () => ({
  createHighlight: vi.fn(),
  updateHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
}))
vi.mock('../shared/notify.js', () => ({
  notifyDevices: vi.fn(),
  deviceIdFrom: (req: Request) => req.header('x-device-id') ?? 'api',
}))

import { app } from './app.js'
import { createHighlight, updateHighlight } from '../shared/highlights.js'
import { notifyDevices } from '../shared/notify.js'

const BOOK = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ID = '9b2c1d0e-1111-4222-8333-444455556666'
const body = { id: ID, bookId: BOOK, locationStart: 0, locationEnd: 10, text: 'some words' }

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

function post(payload: unknown, headers: Record<string, string> = {}): Promise<globalThis.Response> {
  return fetch(`${base}/api/highlights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
}

describe('POST /api/highlights', () => {
  it('creates with the client id (201) and pokes the other devices', async () => {
    vi.mocked(createHighlight).mockResolvedValue({ status: 'created', highlight: { id: ID } as never, seq: 3 })
    const res = await post(body, { 'X-Device-Id': 'web-1' })
    expect(res.status).toBe(201)
    expect(vi.mocked(createHighlight).mock.calls[0][1]).toMatchObject({ id: ID, bookId: BOOK })
    expect(vi.mocked(notifyDevices).mock.calls[0].slice(0, 3)).toEqual([USER, 3, 'web-1'])
  })

  it('answers a retry with the stored highlight (200, Idempotent-Replayed) and no notification', async () => {
    vi.mocked(createHighlight).mockResolvedValue({ status: 'replayed', highlight: { id: ID } as never, seq: null })
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(res.headers.get('idempotent-replayed')).toBe('true')
    expect(notifyDevices).not.toHaveBeenCalled()
  })

  it('derives the same id from the same Idempotency-Key when the client sends no id', async () => {
    vi.mocked(createHighlight).mockResolvedValue({ status: 'created', highlight: { id: 'x' } as never, seq: 1 })
    const { id: _omit, ...withoutId } = body
    await post(withoutId, { 'Idempotency-Key': 'retry-me' })
    await post(withoutId, { 'Idempotency-Key': 'retry-me' })
    await post(withoutId, { 'Idempotency-Key': 'another' })
    const ids = vi.mocked(createHighlight).mock.calls.map((call) => call[1].id)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('rejects an invalid body with 400 before writing', async () => {
    const res = await post({ ...body, locationEnd: -1 })
    expect(res.status).toBe(400)
    expect(createHighlight).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/highlights/:id', () => {
  it('maps a tombstoned highlight to 410 Gone', async () => {
    vi.mocked(updateHighlight).mockResolvedValue({ status: 'gone', highlight: { id: ID } as never, seq: null })
    const res = await fetch(`${base}/api/highlights/${ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'too late' }),
    })
    expect(res.status).toBe(410)
  })
})
