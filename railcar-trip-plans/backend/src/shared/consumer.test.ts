import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { deadLetter, failureAction, processMessage, type ProcessDeps } from './consumer.js'
import type { EventRow } from './events/envelope.js'

/** An in-memory stand-in for the database: a processed set plus an effects log, both transactional. */
function fakeDeps() {
  const processed = new Set<string>()
  const effects: string[] = []
  const deps: ProcessDeps & { processed: Set<string>; effects: string[] } = {
    processed,
    effects,
    async withTx(fn) {
      const snapshot = { processed: new Set(processed), effects: [...effects] }
      try {
        return await fn({} as PoolClient)
      } catch (err) {
        // Roll back: neither the marker nor the effects survive a failed handler.
        processed.clear()
        snapshot.processed.forEach((p) => processed.add(p))
        effects.length = 0
        effects.push(...snapshot.effects)
        throw err
      }
    },
    async markProcessed(_tx, group, eventId) {
      const key = `${group}|${eventId}`
      if (processed.has(key)) return false
      processed.add(key)
      return true
    },
    async recordCheckpoint() {},
  }
  return deps
}

const row = (type = 'CarArrivedYard', eventId = '11111111-1111-4111-8111-111111111111'): EventRow => ({
  position: 1, event_id: eventId, type, version: 1, stream_id: 'car-HPSX1', stream_version: 1, topic: 'car', partition_key: 'HPSX1',
  occurred_at: '2026-11-04T12:00:00.000Z', recorded_at: '2026-11-04T12:01:00.000Z', correlation_id: eventId, causation_id: null, producer: 'yard:MID',
  payload: { carId: 'HPSX1', yardId: 'MID', trainRunId: null, track: null },
})

describe('processMessage (idempotent consumer)', () => {
  it('applies a message once; a redelivery is acknowledged as a duplicate with no second effect', async () => {
    const deps = fakeDeps()
    const handle = vi.fn(async () => {
      deps.effects.push('car_state updated')
    })
    const spec = { group: 'car-state', types: ['CarArrivedYard' as const], handle }
    expect((await processMessage(spec, row(), deps)).outcome).toBe('processed')
    expect((await processMessage(spec, row(), deps)).outcome).toBe('duplicate')
    expect((await processMessage(spec, row(), deps)).outcome).toBe('duplicate')
    expect(handle).toHaveBeenCalledTimes(1)
    expect(deps.effects).toEqual(['car_state updated'])
  })

  it('keeps groups independent: the same event is processed once per group', async () => {
    const deps = fakeDeps()
    const handle = vi.fn(async () => undefined)
    await processMessage({ group: 'car-state', types: ['CarArrivedYard'], handle }, row(), deps)
    await processMessage({ group: 'eta', types: ['CarArrivedYard'], handle }, row(), deps)
    expect(handle).toHaveBeenCalledTimes(2)
  })

  it('leaves no marker when the handler fails, so the retry really runs', async () => {
    const deps = fakeDeps()
    let attempt = 0
    const handle = vi.fn(async () => {
      deps.effects.push(`attempt ${++attempt}`)
      if (attempt === 1) throw new Error('database blip')
    })
    const spec = { group: 'eta', types: ['CarArrivedYard' as const], handle }
    await expect(processMessage(spec, row(), deps)).rejects.toThrow('database blip')
    expect(deps.processed.size).toBe(0)
    expect(deps.effects).toEqual([])
    expect((await processMessage(spec, row(), deps)).outcome).toBe('processed')
    expect(deps.effects).toEqual(['attempt 2'])
  })

  it('skips types the group does not handle without opening a transaction', async () => {
    const deps = fakeDeps()
    const withTx = vi.spyOn(deps, 'withTx')
    const result = await processMessage({ group: 'notifier', types: ['EtaUpdated'], handle: vi.fn() }, row(), deps)
    expect(result.outcome).toBe('skipped')
    expect(withTx).not.toHaveBeenCalled()
  })

  it('returns after-commit work only for processed messages', async () => {
    const deps = fakeDeps()
    const step = vi.fn(async () => undefined)
    const spec = { group: 'replanner', types: ['CarArrivedYard' as const], handle: async (_e: unknown, ctx: { afterCommit: (fn: () => Promise<void>) => void }) => ctx.afterCommit(step) }
    expect((await processMessage(spec, row(), deps)).after).toHaveLength(1)
    expect((await processMessage(spec, row(), deps)).after).toHaveLength(0)
  })

  it('fails (to be retried, then dead-lettered) on a schema version it cannot upcast', async () => {
    const deps = fakeDeps()
    const bad = { ...row('CarSighted'), version: 3, payload: { carId: 'HPSX1', siteId: 'AEI-MIDPRT' } }
    await expect(processMessage({ group: 'car-state', types: ['CarSighted'], handle: vi.fn() }, bad, deps)).rejects.toThrow('not a known schema version')
  })
})

describe('DLQ routing', () => {
  it('retries until the delivery count reaches the limit, then dead-letters', () => {
    expect(failureAction(1, 4)).toBe('retry')
    expect(failureAction(3, 4)).toBe('retry')
    expect(failureAction(4, 4)).toBe('dead_letter')
    expect(failureAction(9, 4)).toBe('dead_letter')
  })

  it('copies the message to the group DLQ with the error, then acknowledges the original', async () => {
    const calls: string[] = []
    const client = {
      xadd: vi.fn(async (...args: unknown[]) => {
        calls.push(`xadd ${args[0]}`)
        return '1-0'
      }),
      xack: vi.fn(async (...args: unknown[]) => {
        calls.push(`xack ${args[0]} ${args[1]} ${args[2]}`)
        return 1
      }),
      hdel: vi.fn(async () => 1),
    }
    await deadLetter(client as never, {
      group: 'car-state', stream: 'tp:car:3', messageId: '5-0', error: 'Car LPSX990001 is not in the car registry', deliveries: 4,
      fields: { id: 'e1', type: 'CarInterchanged', key: 'LPSX990001', e: '{}' },
    })
    expect(calls).toEqual(['xadd tp:dlq:car-state', 'xack tp:car:3 car-state 5-0'])
    const args = client.xadd.mock.calls[0]
    expect(args).toContain('Car LPSX990001 is not in the car registry')
    expect(args).toContain('CarInterchanged')
  })
})
