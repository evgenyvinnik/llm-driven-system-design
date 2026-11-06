import { describe, expect, it, vi } from 'vitest'
import type { DeadLetter } from './dlq.js'
import { processDelivery, type RuntimeDeps } from './consumer.js'
import type { GroupSpec } from './topology.js'

const spec: GroupSpec = { group: 'notifier', kind: 'integration', families: ['cases'], handles: ['NotificationRequested'], description: 'test' }

const event = (type = 'NotificationRequested', payload: Record<string, unknown> = {
  caseId: '11111111-1111-4111-8111-111111111111', notificationId: '22222222-2222-4222-8222-222222222222', channel: 'yard', target: 'CDJ', kind: 'opened', message: 'hi',
}) => ({
  global_position: 7, event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', stream_id: 'case-11111111-1111-4111-8111-111111111111', stream_type: 'case', stream_version: 3,
  type, version: 1, family: 'cases', partition_key: 'k', occurred_at: '2026-11-05T12:00:00Z', recorded_at: '2026-11-05T12:00:00Z', committed_at: '2026-11-05T12:00:00Z',
  correlation_id: 'c', causation_id: null, actor: 'analyzer', tags: [], payload,
})

const fields = (e: object, extra: string[] = []) => ['event', JSON.stringify(e), 'type', (e as { type: string }).type, ...extra]

/** A fake transaction whose processed_events table is a Set: the runtime's idempotency check runs against it. */
function harness(handlerImpl: () => Promise<void> = async () => undefined) {
  const processed = new Set<string>()
  const acked: string[] = []
  const dead: DeadLetter[] = []
  const handler = vi.fn(handlerImpl)
  let fault: { match: string; mode: 'transient' | 'permanent' | 'crash_after_commit' } | null = null
  const crashes: string[] = []
  const deps: RuntimeDeps = {
    transaction: async (_ctx, fn) => {
      const staged = new Set(processed)
      const client = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.startsWith('INSERT INTO processed_events')) {
            const key = `${params[0]}|${params[1]}`
            if (staged.has(key)) return { rows: [], rowCount: 0 }
            staged.add(key)
            return { rows: [1], rowCount: 1 }
          }
          return { rows: [], rowCount: 1 }
        },
      }
      const result = await fn({ client: client as never, batch: {} as never })
      for (const k of staged) processed.add(k) // commit
      return { result }
    },
    ack: async (_key, id) => void acked.push(id),
    deadLetter: async (d) => void dead.push(d),
    fault: async () => fault,
    publish: async () => undefined,
    maxDeliveries: 3,
    crash: (reason) => void crashes.push(reason),
  }
  return { deps, handler, acked, dead, processed, crashes, setFault: (f: typeof fault) => (fault = f) }
}

describe('idempotent consumers', () => {
  it('applies a message once; a redelivery (relay republish or crash before XACK) is acked as a no-op', async () => {
    const h = harness()
    const d = { streamKey: 'rh:ev:cases', id: '1-0', fields: fields(event()), deliveries: 1 }
    expect(await processDelivery(h.deps, spec, h.handler, d)).toBe('processed')
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, id: '2-0' })).toBe('duplicate')
    expect(h.handler).toHaveBeenCalledTimes(1)
    expect(h.acked).toEqual(['1-0', '2-0'])
  })

  it('survives a crash after commit but before XACK: the restart redelivers the message and it is a no-op', async () => {
    const h = harness()
    h.setFault({ match: '', mode: 'crash_after_commit' })
    const d = { streamKey: 'rh:ev:cases', id: '1-0', fields: fields(event()), deliveries: 1 }
    expect(await processDelivery(h.deps, spec, h.handler, d)).toBe('failed')
    expect(h.crashes).toHaveLength(1)
    expect(h.acked).toEqual([]) // still pending
    // The restarted consumer drains its pending entries first: the effects are already committed.
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, deliveries: 2 })).toBe('duplicate')
    expect(h.handler).toHaveBeenCalledTimes(1)
    expect(h.acked).toEqual(['1-0'])
  })

  it('rolls back the processed mark when the handler fails, so the retry really runs', async () => {
    let calls = 0
    const h = harness(async () => {
      calls += 1
      if (calls === 1) throw new Error('database blip')
    })
    const d = { streamKey: 'rh:ev:cases', id: '1-0', fields: fields(event()), deliveries: 1 }
    expect(await processDelivery(h.deps, spec, h.handler, d)).toBe('failed')
    expect(h.acked).toEqual([]) // left pending for the reclaim loop
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, deliveries: 2 })).toBe('processed')
    expect(h.processed.size).toBe(1)
  })

  it('acks event types the group does not handle, and redrives addressed to another group, without running the handler', async () => {
    const h = harness()
    expect(await processDelivery(h.deps, spec, h.handler, { streamKey: 'k', id: '1-0', fields: fields(event('AlertRaised')), deliveries: 1 })).toBe('skipped')
    expect(await processDelivery(h.deps, spec, h.handler, { streamKey: 'k', id: '2-0', fields: fields(event(), ['redriveFor', 'workorder-sync']), deliveries: 1 })).toBe('skipped')
    expect(h.handler).not.toHaveBeenCalled()
    expect(h.acked).toEqual(['1-0', '2-0'])
  })
})

describe('dead-letter routing', () => {
  it('dead-letters a schema violation at once: retrying a bad payload can never succeed', async () => {
    const h = harness()
    const bad = event('NotificationRequested', { caseId: 'not-a-uuid', channel: 'pager' })
    expect(await processDelivery(h.deps, spec, h.handler, { streamKey: 'rh:ev:cases', id: '1-0', fields: fields(bad), deliveries: 1 })).toBe('dead_lettered')
    expect(h.dead[0]).toMatchObject({ group: 'notifier', permanent: true, attempts: 1, type: 'NotificationRequested' })
    expect(h.dead[0].error).toMatch(/schema violation/)
    expect(h.acked).toEqual(['1-0'])
    expect(h.handler).not.toHaveBeenCalled()
  })

  it('retries a transient failure, then dead-letters it after max deliveries with the error and the raw event', async () => {
    const h = harness()
    h.setFault({ match: 'CDJ', mode: 'transient' })
    const d = { streamKey: 'rh:ev:cases', id: '1-0', fields: fields(event()), deliveries: 1 }
    expect(await processDelivery(h.deps, spec, h.handler, d)).toBe('failed')
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, deliveries: 2 })).toBe('failed')
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, deliveries: 3 })).toBe('dead_lettered')
    expect(h.dead).toHaveLength(1)
    expect(h.dead[0]).toMatchObject({ permanent: false, attempts: 3, eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    expect(JSON.parse(h.dead[0].event).type).toBe('NotificationRequested')
    // After the cause is fixed, a redrive addressed to this group is processed normally.
    h.setFault(null)
    expect(await processDelivery(h.deps, spec, h.handler, { ...d, id: '9-0', fields: fields(event(), ['redriveFor', 'notifier']) })).toBe('processed')
  })

  it('dead-letters a message that keeps killing its consumer before it can fail cleanly', async () => {
    const h = harness()
    expect(await processDelivery(h.deps, spec, h.handler, { streamKey: 'k', id: '1-0', fields: fields(event()), deliveries: 4 })).toBe('dead_lettered')
    expect(h.dead[0].error).toMatch(/delivered 3 times/)
  })
})
