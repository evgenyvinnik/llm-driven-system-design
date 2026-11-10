/**
 * Review worker: claims runs, heartbeats leases, listens for cancellation, and
 * runs the sweeper and reconciler. It holds a read-only host credential.
 */
import pg from 'pg'

process.env.SERVICE_NAME ??= 'worker'
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { httpHostReader } = await import('../shared/host-client.js')
const { startOpsServer } = await import('../shared/worker-http.js')
const { claimNextRun, heartbeat } = await import('./runs.js')
const { executeRun } = await import('./pipeline.js')
const { createHttpCaller, withTransportRetries } = await import('./model-client.js')
const { reconcileOnce } = await import('./reconciler.js')
const { sweepWaitingDecisions } = await import('./sweeper.js')

type Claimed = NonNullable<Awaited<ReturnType<typeof claimNextRun>>>

const deps = { reader: httpHostReader, caller: withTransportRetries(createHttpCaller()), actor: 'worker' }
const inFlight = new Map<string, AbortController>()
let stopping = false

async function runOne(run: Claimed): Promise<void> {
  const abort = new AbortController()
  inFlight.set(run.id, abort)
  const timer = setInterval(() => {
    void heartbeat(run.id, run.lease_token as string)
      .then((alive) => {
        if (!alive) abort.abort()
      })
      .catch(() => undefined)
  }, Math.floor(config.worker.leaseMs / 3))
  try {
    const end = await executeRun(deps, run, abort.signal)
    logger.info({ runId: run.id, pr: run.pr_number, sha: run.head_sha.slice(0, 7), kind: run.kind, end }, 'run finished')
  } catch (err) {
    logger.error({ runId: run.id, err }, 'run crashed; its lease will expire')
  } finally {
    clearInterval(timer)
    inFlight.delete(run.id)
  }
}

let wake: (() => void) | null = null

async function slot(): Promise<void> {
  while (!stopping) {
    const run = await claimNextRun(config.instanceId).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'claim failed')
      return null
    })
    if (run) {
      await runOne(run)
      continue
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.worker.idlePollMs)
      wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }
}

// Cancellation and wake-ups arrive over LISTEN/NOTIFY; polling and heartbeats back them up.
async function listen(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: config.databaseUrl })
  client.on('error', (err) => logger.warn({ err: err.message }, 'listener error'))
  await client.connect()
  await client.query('LISTEN review_run_cancel')
  await client.query('LISTEN review_run_queued')
  client.on('notification', (n) => {
    if (n.channel === 'review_run_cancel' && n.payload) inFlight.get(n.payload)?.abort()
    if (n.channel === 'review_run_queued') wake?.()
  })
  return client
}

const listener = await listen().catch((err) => {
  logger.warn({ err: (err as Error).message }, 'LISTEN unavailable; relying on polling')
  return null
})
const ops = startOpsServer(config.workerPort, 'worker')
const slots = Array.from({ length: config.worker.concurrency }, () => slot())
const sweeper = setInterval(() => void sweepWaitingDecisions(httpHostReader).catch((err) => logger.warn({ err: (err as Error).message }, 'sweep failed')), config.worker.sweepMs)
const reconciler = setInterval(() => void reconcileOnce(httpHostReader).catch((err) => logger.warn({ err: (err as Error).message }, 'reconcile failed')), config.worker.reconcileMs)
logger.info({ instance: config.instanceId, slots: config.worker.concurrency, leaseMs: config.worker.leaseMs }, 'worker started')

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  clearInterval(sweeper)
  clearInterval(reconciler)
  wake?.()
  for (const a of inFlight.values()) a.abort()
  await Promise.race([Promise.allSettled(slots), new Promise((r) => setTimeout(r, 2000))])
  ops.close()
  await listener?.end().catch(() => undefined)
  await pool.end().catch(() => undefined)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
