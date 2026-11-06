/**
 * A simulated edge gateway: store-and-forward with per-gateway sequence
 * numbers and at-least-once delivery.
 *
 * - Events are buffered locally and sent in batches; they leave the buffer only
 *   when the API acknowledges the batch (2xx). Anything unacknowledged is resent.
 * - Critical events are sent first (their own batch), then bulk readings in
 *   sequence order: priority starts at the edge.
 * - Each batch carries the gateway's watermark: the time of the oldest event
 *   still in its buffer ("everything before this has been delivered").
 * - `online = false` simulates a lost link; `loseNextAck()` simulates a response
 *   lost on the way back, so the same batch is sent twice.
 */
import { randomUUID } from 'node:crypto'
import { classifyLane } from '../shared/events/edge.js'
import { postBatch, type EdgeEvent } from './client.js'

interface Buffered extends EdgeEvent {
  lane: 'critical' | 'bulk'
}

export class Gateway {
  online = true
  /**
   * A real gateway persists its sequence counter across reboots (the dedup key is (gateway, seq)).
   * The simulator has no disk, so it seeds the counter from the clock: still strictly increasing across restarts.
   */
  private seq = Date.now() * 100
  private buffer: Buffered[] = []
  private dropAck = false
  private inFlight = false
  private resend: { batchId: string; events: Buffered[] } | null = null
  sent = 0
  duplicatesReported = 0

  constructor(
    readonly id: string,
    readonly cameraSchemaVersion: number,
  ) {}

  emit(type: string, occurredAt: Date, payload: Record<string, unknown>, version = 1): EdgeEvent {
    this.seq += 1
    const e: Buffered = { eventId: randomUUID(), seq: this.seq, type, version, occurredAt: occurredAt.toISOString(), payload, lane: classifyLane(type, payload) }
    this.buffer.push(e)
    return e
  }

  get buffered(): number {
    return this.buffer.length
  }

  loseNextAck(): void {
    this.dropAck = true
  }

  async flush(): Promise<void> {
    if (!this.online || this.inFlight || (this.buffer.length === 0 && !this.resend)) return
    this.inFlight = true
    try {
      let batchId: string
      let events: Buffered[]
      if (this.resend) {
        ;({ batchId, events } = this.resend)
      } else {
        const critical = this.buffer.filter((e) => e.lane === 'critical').slice(0, 200)
        events = critical.length ? critical : this.buffer.filter((e) => e.lane === 'bulk').slice(0, 5000)
        batchId = randomUUID()
      }
      const watermark = this.buffer.length ? this.buffer.reduce((m, e) => (e.occurredAt < m ? e.occurredAt : m), this.buffer[0].occurredAt) : new Date().toISOString()
      const reply = await postBatch({
        sourceId: this.id,
        batchId,
        watermark,
        bufferedCount: this.buffer.length,
        events: events.map(({ lane: _lane, ...e }) => e),
      })
      this.duplicatesReported += reply.duplicates
      if (this.dropAck) {
        // The API stored the batch, but the gateway never saw the reply: it will send the same batch again.
        this.dropAck = false
        this.resend = { batchId, events }
        return
      }
      const ids = new Set(events.map((e) => e.eventId))
      this.buffer = this.buffer.filter((e) => !ids.has(e.eventId))
      this.resend = null
      this.sent += events.length
    } catch {
      // Link or API down: keep everything buffered and try again on the next flush.
    } finally {
      this.inFlight = false
    }
  }
}
