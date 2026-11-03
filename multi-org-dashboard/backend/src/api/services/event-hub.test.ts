import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/db.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../../shared/cache.js', () => ({ redis: { get: vi.fn() }, createRedisConnection: vi.fn() }))

import type { Redis } from 'ioredis'
import { redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { EventHub } from './event-hub.js'

function fakeResponse() {
  const frames: string[] = []
  return {
    frames,
    events: () => frames.filter((f) => f.startsWith('event:')).map((f) => f.split('\n')[0].slice(7)),
    write: vi.fn((chunk: string) => {
      frames.push(chunk)
      return true
    }),
    end: vi.fn(),
  }
}

const subscriber = { on: vi.fn(), psubscribe: vi.fn().mockResolvedValue(2), quit: vi.fn().mockResolvedValue('OK') }
let hub: EventHub

beforeEach(() => {
  subscriber.psubscribe.mockClear()
  hub = new EventHub(() => subscriber as unknown as Redis)
})

describe('EventHub', () => {
  it('delivers org events only to members of that org', () => {
    const alice = fakeResponse()
    const dev = fakeResponse()
    hub.add('alice', 's1', ['org_lumen', 'org_harbor'], alice)
    hub.add('dev', 's2', ['org_lumen'], dev)
    hub.dispatch('evt:org:org_harbor', JSON.stringify({ type: 'authz.changed', orgId: 'org_harbor', version: 5 }))
    expect(alice.events()).toEqual(['authz.changed'])
    expect(dev.events()).toEqual([])
  })

  it('stops delivering an org’s events once access to it is revoked', () => {
    const dev = fakeResponse()
    hub.add('dev', 's2', ['org_lumen'], dev)
    hub.dispatch('evt:user:dev', JSON.stringify({ type: 'access.revoked', orgId: 'org_lumen', orgName: 'Lumen', reason: 'removed' }))
    hub.dispatch('evt:org:org_lumen', JSON.stringify({ type: 'authz.changed', orgId: 'org_lumen', version: 9 }))
    hub.dispatch('evt:user:dev', JSON.stringify({ type: 'export.progress', orgId: 'org_lumen', exportId: 'e1', processedRows: 1, totalRows: 2 }))
    expect(dev.events()).toEqual(['access.revoked'])
  })

  it('closes every stream of a user whose sessions were revoked', () => {
    const tab1 = fakeResponse()
    const tab2 = fakeResponse()
    hub.add('dev', 's2', ['org_lumen'], tab1)
    hub.add('dev', 's3', ['org_lumen'], tab2)
    hub.dispatch('evt:user:dev', JSON.stringify({ type: 'session.revoked', reason: 'no_memberships' }))
    expect(tab1.end).toHaveBeenCalled()
    expect(tab2.end).toHaveBeenCalled()
    expect(hub.size).toBe(0)
  })

  it('reconciles against PostgreSQL when a pub/sub message was lost', async () => {
    const dev = fakeResponse()
    const conn = hub.add('dev', 's2', ['org_lumen'], dev)
    vi.mocked(redis.get).mockResolvedValueOnce(JSON.stringify({ id: 'dev' }))
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never) // no memberships any more
    await hub.reconcile(conn)
    expect(dev.events()).toEqual(['access.revoked', 'versions'])
    expect(conn.orgIds.size).toBe(0)
  })

  it('ends the stream when the session is gone', async () => {
    const dev = fakeResponse()
    const conn = hub.add('dev', 's2', ['org_lumen'], dev)
    vi.mocked(redis.get).mockResolvedValueOnce(null)
    await hub.reconcile(conn)
    expect(dev.events()).toEqual(['session.revoked'])
    expect(dev.end).toHaveBeenCalled()
  })

  it('uses one subscription for any number of streams', () => {
    hub.add('a', 's1', [], fakeResponse())
    hub.add('b', 's2', [], fakeResponse())
    expect(subscriber.psubscribe).toHaveBeenCalledTimes(1)
  })
})
