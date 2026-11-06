import { describe, expect, it, vi } from 'vitest'
import { dispositionFor, StreamConsumer } from './consumer.js'
import { PermanentError, TransientError } from './events/envelope.js'

describe('dead-letter policy', () => {
  it('dead-letters permanent failures at once and transient ones after max deliveries', () => {
    expect(dispositionFor(new PermanentError('SCHEMA_INVALID', 'x'), 1, 4)).toBe('dead_letter')
    expect(dispositionFor(new TransientError('UNKNOWN_SENSOR', 'x'), 1, 4)).toBe('retry')
    expect(dispositionFor(new TransientError('UNKNOWN_SENSOR', 'x'), 4, 4)).toBe('dead_letter')
    expect(dispositionFor(new Error('db down'), 2, 4)).toBe('retry')
  })
})

function fakeRedis() {
  return { xack: vi.fn().mockResolvedValue(1), xadd: vi.fn().mockResolvedValue('1-0'), disconnect: vi.fn(), quit: vi.fn().mockResolvedValue('OK') }
}

const envelope = {
  eventId: '11111111-1111-4111-8111-111111111111',
  type: 'WaterLevelReported',
  version: 1,
  occurredAt: '2026-11-06T20:00:00.000Z',
  recordedAt: '2026-11-06T20:00:00.100Z',
  streamId: 'gw-GW-PRA-3',
  streamVersion: 9,
  partitionKey: 'PRA-3',
  correlationId: '11111111-1111-4111-8111-111111111111',
  causationId: null,
  source: 'GW-PRA-3',
  meta: { lane: 'bulk' },
  payload: { sensorId: 'WTR-207.9', inchesBelowRail: 'ERR' },
}

function consumerWith(handle: () => Promise<'ok'>) {
  const cmd = fakeRedis()
  const c = new StreamConsumer({ group: 'correlator', consumer: 'c1', lanes: [{ topic: 'edge.bulk', batch: 10 }], partitions: [0], handle, retryDelaysMs: [1, 1, 1], maxDeliveries: 3 }, { reader: fakeRedis() as never, cmd: cmd as never })
  ;(c as unknown as { running: boolean }).running = true
  const handleEntry = (fields: string[]) => (c as unknown as { handleEntry: (k: string, id: string, f: string[], d: number) => Promise<void> }).handleEntry('th:edge.bulk:0', '5-0', fields, 1)
  return { cmd, handleEntry }
}

describe('StreamConsumer', () => {
  it('acks after the handler succeeds', async () => {
    const handle = vi.fn().mockResolvedValue('ok')
    const { cmd, handleEntry } = consumerWith(handle)
    await handleEntry(['event', JSON.stringify(envelope), 'eventId', envelope.eventId, 'type', envelope.type])
    expect(handle).toHaveBeenCalledTimes(1)
    expect(cmd.xack).toHaveBeenCalledWith('th:edge.bulk:0', 'correlator', '5-0')
    expect(cmd.xadd).not.toHaveBeenCalled()
  })

  it('routes a poison message to the DLQ once and acks it', async () => {
    const handle = vi.fn().mockRejectedValue(new PermanentError('SCHEMA_INVALID', 'inchesBelowRail: Expected number'))
    const { cmd, handleEntry } = consumerWith(handle)
    await handleEntry(['event', JSON.stringify(envelope), 'eventId', envelope.eventId, 'type', envelope.type])
    expect(handle).toHaveBeenCalledTimes(1)
    expect(cmd.xadd).toHaveBeenCalledTimes(1)
    const args = cmd.xadd.mock.calls[0] as string[]
    expect(args[0]).toBe('th:dlq')
    expect(args).toContain('SCHEMA_INVALID')
    expect(cmd.xack).toHaveBeenCalledWith('th:edge.bulk:0', 'correlator', '5-0')
  })

  it('dead-letters unparseable messages without calling the handler', async () => {
    const handle = vi.fn()
    const { cmd, handleEntry } = consumerWith(handle)
    await handleEntry(['event', '{not json', 'eventId', 'x', 'type', 'y'])
    expect(handle).not.toHaveBeenCalled()
    expect(cmd.xadd.mock.calls[0]).toContain('INVALID_JSON')
  })

  it('retries a transient failure in place, then dead-letters it after max deliveries', async () => {
    const handle = vi.fn().mockRejectedValue(new TransientError('UNKNOWN_SENSOR', 'Sensor GEO-118.9 is not in the registry'))
    const { cmd, handleEntry } = consumerWith(handle)
    await handleEntry(['event', JSON.stringify(envelope), 'eventId', envelope.eventId, 'type', envelope.type])
    expect(handle).toHaveBeenCalledTimes(3)
    expect(cmd.xadd.mock.calls[0]).toContain('UNKNOWN_SENSOR')
    expect(cmd.xack).toHaveBeenCalledTimes(1)
  })

  it('recovers after a transient failure without dead-lettering', async () => {
    const handle = vi.fn().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue('ok')
    const { cmd, handleEntry } = consumerWith(handle)
    await handleEntry(['event', JSON.stringify(envelope), 'eventId', envelope.eventId, 'type', envelope.type])
    expect(handle).toHaveBeenCalledTimes(2)
    expect(cmd.xadd).not.toHaveBeenCalled()
    expect(cmd.xack).toHaveBeenCalledTimes(1)
  })
})
