/**
 * Records breaker transitions as DependencyCircuitOpened / Closed events in
 * the outbox. A breaker is in-memory per process, so the event names the
 * instance. The ops timeline and the analytics projection read them from the log.
 * @module shared/circuit-events
 */
import { randomUUID } from 'node:crypto'
import { withTransaction } from './db.js'
import { appendEvents } from './event-store.js'
import { dependencyStream } from './events.js'
import { logger } from './logger.js'
import type { BreakerState } from './breakers.js'
import type { Dependency } from './domain.js'

export function recordCircuitTransition(dep: Dependency, state: BreakerState, openMs: number | null, instanceId: string, producer: string): void {
  if (state === 'halfOpen') {
    logger.info({ dep, instanceId }, 'circuit half-open')
    return
  }
  logger.warn({ dep, state, instanceId, openMs }, `circuit ${state}`)
  const correlationId = `circuit-${randomUUID().slice(0, 8)}`
  withTransaction((client) =>
    appendEvents(
      client,
      [
        state === 'open'
          ? { type: 'DependencyCircuitOpened', streamId: dependencyStream(dep), correlationId, payload: { dependency: dep, instance_id: instanceId, reason: 'error rate over threshold in rolling window' } }
          : { type: 'DependencyCircuitClosed', streamId: dependencyStream(dep), correlationId, payload: { dependency: dep, instance_id: instanceId, open_ms: openMs } },
      ],
      producer,
    ),
  ).catch((err) => logger.warn({ err: (err as Error).message, dep }, 'could not record circuit event'))
}
