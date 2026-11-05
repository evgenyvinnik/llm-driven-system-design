/**
 * Executor behavior against the real simulator logic (in-process, controlled
 * clock): idempotent apply with etags, crash/resume without a second write,
 * fencing, throttling, ambiguous 5xx, bake verification and automatic rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { InProcessControlPlane } from '../arm/in-process.js'
import { Fleet } from '../cloud-sim/fleet.js'
import { generateFleet, mulberry32 } from '../cloud-sim/generate.js'
import type { SimAccount } from '../cloud-sim/model.js'
import { processTarget } from './apply.js'
import { MemoryBuckets } from './buckets.js'
import { MemoryTargetStore } from './memory-store.js'
import type { CampaignEvent } from './types.js'
import { checkBakingTarget, type VerifyDeps } from './verify.js'

let now = Date.parse('2026-11-05T12:00:00Z')
const clock = () => now

interface Harness {
  fleet: Fleet
  store: MemoryTargetStore
  buckets: MemoryBuckets
  deps: VerifyDeps
  events: CampaignEvent[]
  account: SimAccount
  writes: () => number
}

function setup(): Harness {
  now = Date.parse('2026-11-05T12:00:00Z')
  const state = generateFleet(7, 3, 30, now)
  state.faults = { ...state.faults, error5xxRate: 0, writeCapacity: 1000, writeRefillPerSec: 1000, readCapacity: 1000, readRefillPerSec: 1000, periodicFireDelayMs: 0 }
  const fleet = new Fleet(state, clock, mulberry32(99))
  const account = fleet.state.accounts.find((a) => a.account.props.allowSharedKeyAccess)!
  // One well-behaved OAuth caller: turning shared key off breaks nothing (unless a test adds a dependency).
  account.clients = [{ id: 'oauth', app: 'api', authType: 'OAuth', callerIp: '10.0.0.5', userAgent: 'sdk', tlsVersion: 'TLS 1.2', protocol: 'HTTPS', perMinute: 60, schedule: 'continuous', lastRunDaysAgo: 0, brokenIntervals: [] }]
  const store = new MemoryTargetStore(clock)
  store.campaigns.set('c1', { id: 'c1', controlId: 'SA-02', status: 'running', bakeSeconds: 60 })
  store.addTarget({ id: 1, campaignId: 'c1', accountId: account.id, subscriptionId: account.subscriptionId })
  const buckets = new MemoryBuckets({ capacity: 10, refillPerSec: 10 }, clock)
  const events: CampaignEvent[] = []
  const deps: VerifyDeps = {
    store,
    arm: new InProcessControlPlane(fleet),
    buckets,
    events: async (_id, e) => {
      events.push(e)
    },
    clock,
    sleep: async (ms) => {
      now += ms
    },
    instanceId: 'test-executor',
    leaseMs: 15_000,
    maxAttempts: 3,
    maxInlineWaitMs: 2000,
    baselineWindowMs: 60_000,
    thresholds: { minErrors: 5, baselineMultiplier: 3, minErrorRate: 0.02 },
  }
  return { fleet, store, buckets, deps, events, account, writes: () => fleet.writeCounts([account.id])[account.id].account }
}

async function bakeOnce(h: Harness) {
  const [t] = await h.store.claimBaking('test-executor', 30_000, 1)
  return checkBakingTarget(h.deps, t, 'SA-02')
}

let h: Harness
beforeEach(() => {
  h = setup()
})

describe('idempotent apply', () => {
  it('records intent before writing, writes once with If-Match, and moves to baking', async () => {
    const realWrite = h.deps.arm.write.bind(h.deps.arm)
    let intentAtWrite: unknown = 'unset'
    h.deps.arm.write = async (...args) => {
      intentAtWrite = h.store.get(1).beforeValue
      expect(args[3]).toBe(h.account.account.etag)
      return realWrite(...args)
    }
    expect(await processTarget(h.deps, 1)).toBe('applied')
    expect(intentAtWrite).toBe(true)
    expect(h.store.get(1)).toMatchObject({ state: 'baking', beforeValue: true, afterValue: false, writeOutcome: 'written' })
    expect(h.account.account.props.allowSharedKeyAccess).toBe(false)
    expect(h.writes()).toBe(1)
  })

  it('skips an account someone else already fixed, without writing', async () => {
    h.fleet.writeResource(h.account.id, { properties: { allowSharedKeyAccess: false } }, undefined)
    const before = h.writes()
    expect(await processTarget(h.deps, 1)).toBe('skipped')
    expect(h.writes()).toBe(before)
  })

  it('re-reads and retries on an etag conflict, without clobbering the concurrent change', async () => {
    const realWrite = h.deps.arm.write.bind(h.deps.arm)
    let first = true
    h.deps.arm.write = async (...args) => {
      if (first) {
        first = false
        // An owner changes TLS between our read and our write.
        h.fleet.writeResource(h.account.id, { properties: { minimumTlsVersion: 'TLS1_2' } }, undefined)
      }
      return realWrite(...args)
    }
    expect(await processTarget(h.deps, 1)).toBe('applied')
    expect(h.fleet.stats.preconditionFailed).toBe(1)
    expect(h.account.account.props).toMatchObject({ allowSharedKeyAccess: false, minimumTlsVersion: 'TLS1_2' })
  })

  it('treats a 5xx as "outcome unknown": an applied write is confirmed by re-reading, not repeated', async () => {
    h.fleet.setFaults({ error5xxRate: 1, ambiguous5xxShare: 1 })
    expect(await processTarget(h.deps, 1)).toBe('applied')
    expect(h.store.get(1).writeOutcome).toBe('confirmed_after_5xx')
    expect(h.writes()).toBe(1)
  })

  it('defers after a 5xx that was not applied, counting the attempt, then succeeds later', async () => {
    h.fleet.setFaults({ error5xxRate: 1, ambiguous5xxShare: 0 })
    expect(await processTarget(h.deps, 1)).toBe('deferred')
    expect(h.store.get(1)).toMatchObject({ state: 'queued', attempts: 1 })
    expect(await processTarget(h.deps, 1)).toBe('not_claimed') // not due yet
    h.fleet.setFaults({ error5xxRate: 0 })
    now += 5_000
    expect(await processTarget(h.deps, 1)).toBe('applied')
    expect(h.writes()).toBe(1)
  })

  it('honors 429 Retry-After by deferring and blocking the subscription for every worker', async () => {
    h.fleet.setFaults({ writeCapacity: 1, writeRefillPerSec: 0.1 })
    h.fleet.writeResource(h.account.id, { properties: { minimumTlsVersion: h.account.account.props.minimumTlsVersion } }, undefined) // spends the only token
    expect(await processTarget(h.deps, 1)).toBe('deferred')
    expect(h.store.get(1).lastError).toMatch(/429/)
    expect(await h.buckets.take(h.account.subscriptionId)).toBe(10_000)
    expect(h.account.account.props.allowSharedKeyAccess).toBe(true)
  })

  it('releases work when the campaign is paused and cancels it when killed', async () => {
    h.store.campaigns.set('c1', { ...h.store.campaigns.get('c1')!, status: 'paused' })
    expect(await processTarget(h.deps, 1)).toBe('paused')
    expect(h.store.get(1).state).toBe('queued')
    h.store.campaigns.set('c1', { ...h.store.campaigns.get('c1')!, status: 'killed' })
    expect(await processTarget(h.deps, 1)).toBe('cancelled')
    expect(h.writes()).toBe(0)
  })

  it('skips an account whose exception was approved after planning', async () => {
    h.store.exceptions.add(`${h.account.id}|SA-02`)
    expect(await processTarget(h.deps, 1)).toBe('skipped')
    expect(h.writes()).toBe(0)
  })
})

describe('crash safety', () => {
  it('resumes after a crash between the write and its record without writing again', async () => {
    h.deps.afterWrite = () => {
      throw new Error('process killed')
    }
    await expect(processTarget(h.deps, 1)).rejects.toThrow('process killed')
    expect(h.store.get(1)).toMatchObject({ state: 'applying', beforeValue: true })
    expect(h.writes()).toBe(1)

    // Another executor picks it up once the lease expires.
    h.deps.afterWrite = undefined
    expect(await processTarget(h.deps, 1)).toBe('not_claimed')
    h.store.expireLeases()
    expect(await processTarget(h.deps, 1)).toBe('recovered')
    expect(h.writes()).toBe(1)
    // The before-value is still the original, so a rollback restores the right thing.
    expect(h.store.get(1)).toMatchObject({ state: 'baking', beforeValue: true, writeOutcome: 'recovered' })
    expect(h.store.auditLog.map((a) => a.action)).toEqual(['remediation.applied.recovered'])
  })

  it('fences out a worker whose lease expired: its late updates change nothing', async () => {
    const stale = (await h.store.claim(1, 'slow-worker', 15_000))!
    h.store.expireLeases()
    expect(await processTarget(h.deps, 1)).toBe('applied')
    expect(await h.store.markApplied(stale, { afterValue: false, etagAfter: 'x', outcome: 'written', bakeUntil: new Date(now) }, 'slow', 'SA-02')).toBe(false)
    expect(await h.store.finish(stale, 'failed', 'late', 'slow', 'SA-02')).toBe(false)
    expect(h.store.get(1).state).toBe('baking')
  })

  it('never re-applies a rolled-back target, even if a stale queue message arrives', async () => {
    h.fleet.injectHiddenDependency(h.account.id, 'AccountKey')
    await processTarget(h.deps, 1)
    now += 30_000
    expect(await bakeOnce(h)).toBe('rolled_back')
    expect(await processTarget(h.deps, 1)).toBe('not_claimed')
    expect(h.writes()).toBe(2)
  })
})

describe('bake verification and rollback', () => {
  it('verifies after a clean bake period', async () => {
    await processTarget(h.deps, 1)
    now += 20_000
    expect(await bakeOnce(h)).toBe('baking')
    now += 45_000
    expect(await bakeOnce(h)).toBe('verified')
    expect(h.events.map((e) => e.type)).toEqual(['target.applied', 'target.verified'])
  })

  it('rolls back on authorization failures from a dependency the logs missed, restoring the recorded value', async () => {
    h.fleet.injectHiddenDependency(h.account.id, 'AccountKey')
    await processTarget(h.deps, 1)
    now += 30_000
    expect(await bakeOnce(h)).toBe('rolled_back')
    expect(h.account.account.props.allowSharedKeyAccess).toBe(true)
    expect(h.writes()).toBe(2)
    expect(h.store.get(1).rollbackReason).toMatch(/authorization failures since change/)
    expect(h.store.auditLog.map((a) => a.action)).toEqual(['remediation.applied', 'remediation.rollback_triggered', 'remediation.rolled_back'])
  })

  it('rolls back idempotently: an account already restored by hand is not written again', async () => {
    h.fleet.injectHiddenDependency(h.account.id, 'AccountKey')
    await processTarget(h.deps, 1)
    now += 30_000
    const [t] = await h.store.claimBaking('test-executor', 30_000, 1)
    await h.store.startRollback(t, 'test', 'test', 'SA-02')
    h.fleet.writeResource(h.account.id, { properties: { allowSharedKeyAccess: true } }, undefined) // owner restored it
    await h.store.releaseBaking({ ...t })
    const writes = h.writes()
    expect(await bakeOnce(h)).toBe('rolled_back')
    expect(h.writes()).toBe(writes)
  })

  it('fails loudly when a deny policy blocks the rollback', async () => {
    h.fleet.injectHiddenDependency(h.account.id, 'AccountKey')
    await processTarget(h.deps, 1)
    h.fleet.setPolicy('SA-02', 'deny')
    now += 30_000
    expect(await bakeOnce(h)).toBe('rollback_failed')
    expect(h.store.get(1)).toMatchObject({ state: 'failed' })
    expect(h.store.get(1).lastError).toMatch(/ROLLBACK DENIED/)
    expect(h.account.account.props.allowSharedKeyAccess).toBe(false)
  })

  it('fails the target if someone reverts the setting during the bake (drift)', async () => {
    await processTarget(h.deps, 1)
    h.fleet.writeResource(h.account.id, { properties: { allowSharedKeyAccess: true } }, undefined)
    now += 10_000
    expect(await bakeOnce(h)).toBe('drifted')
    expect(h.store.get(1).state).toBe('failed')
  })
})
