/**
 * A supervised LISTEN connection. `eval_tasks` wakes idle workers when work
 * appears (run created, retry, re-score); `eval_cancel` carries a run id whose
 * in-flight calls must stop now.
 *
 * After a laptop sleep the connection can die silently; the supervisor
 * reconnects with backoff. Nothing depends on NOTIFY for correctness: idle
 * workers poll, and in-flight runs are re-checked for cancellation every second.
 * @module worker/listener
 */
import pg from 'pg'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'

export function superviseListener(handlers: { onTasks: () => void; onCancel: (runId: string) => void }): { stop: () => Promise<void> } {
  let client: pg.Client | null = null
  let stopped = false
  let delay = 500

  const connect = async () => {
    if (stopped) return
    const c = new pg.Client({ connectionString: config.databaseUrl })
    c.on('error', (err) => logger.warn({ err: err.message }, 'listener connection error'))
    c.on('end', () => {
      if (client === c) client = null
      if (!stopped) {
        logger.warn({ retryInMs: delay }, 'listener disconnected; reconnecting')
        setTimeout(() => void connect(), delay)
        delay = Math.min(10_000, delay * 2)
      }
    })
    c.on('notification', (msg) => {
      if (msg.channel === 'eval_tasks') handlers.onTasks()
      else if (msg.channel === 'eval_cancel' && msg.payload) handlers.onCancel(msg.payload)
    })
    try {
      await c.connect()
      await c.query('LISTEN eval_tasks')
      await c.query('LISTEN eval_cancel')
      client = c
      delay = 500
      // Work may have appeared while we were disconnected.
      handlers.onTasks()
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), retryInMs: delay }, 'listener connect failed')
      await c.end().catch(() => undefined)
    }
  }
  void connect()

  return {
    stop: async () => {
      stopped = true
      await client?.end().catch(() => undefined)
    },
  }
}
