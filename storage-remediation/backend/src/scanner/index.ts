/**
 * Scanner worker (health and metrics on SCANNER_PORT, default 3200). Runs, for
 * its shard of subscriptions (SHARD_INDEX of SHARD_COUNT):
 * - full scans on an interval and on request (Valkey channel scanner:commands)
 * - change-feed polling for near-real-time inventory
 * - usage-evidence refresh for accounts with open findings
 * - the owner workflow and posture snapshots (one scanner at a time)
 */
process.env.SERVICE_NAME ??= 'scanner'
const express = (await import('express')).default
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { pool } = await import('../shared/db.js')
const { redis, createRedisConnection } = await import('../shared/cache.js')
const { metricsHandler, findingsGauge } = await import('../shared/metrics.js')
const { HttpControlPlane } = await import('../arm/http-client.js')
const { fullScan } = await import('./full-scan.js')
const { processChanges, saveCursor } = await import('./changes.js')
const { refreshEvidence } = await import('./evidence.js')
const { runWorkflow } = await import('./workflow.js')
const { snapshotPosture } = await import('../store/posture.js')

const deps = {
  db: pool,
  arm: new HttpControlPlane(config.simUrl, `scanner-${config.scanner.shardIndex}`),
  shard: { index: config.scanner.shardIndex, count: config.scanner.shardCount },
  lookbackDays: config.scanner.lookbackDays,
  minEvidenceDays: config.scanner.minEvidenceDays,
  readConcurrency: config.scanner.readConcurrency,
  childRefreshMs: config.scanner.childRefreshMs,
  evidenceTtlMs: config.scanner.evidenceTtlMs,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  log: logger,
}

let stopping = false
let fullScanRunning: Promise<unknown> | null = null
const timers: NodeJS.Timeout[] = []

function runFullScan(reason: string): Promise<unknown> {
  if (fullScanRunning) return fullScanRunning
  logger.info({ reason, shard: deps.shard }, 'full scan starting')
  fullScanRunning = fullScan(deps)
    .catch((err) => logger.error({ err }, 'full scan failed'))
    .finally(() => {
      fullScanRunning = null
    })
  return fullScanRunning
}

/** Runs `fn` every `ms`, never overlapping itself. */
function loop(name: string, ms: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return
    try {
      await fn()
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, loop: name }, 'loop iteration failed')
    }
    if (!stopping) timers.push(setTimeout(tick, ms))
  }
  timers.push(setTimeout(tick, 0))
}

async function lastFullScanAgeMs(): Promise<number> {
  const { rows } = await pool.query<{ finished_at: Date | null }>(
    `SELECT max(finished_at) AS finished_at FROM scan_runs WHERE kind = 'full' AND status = 'completed' AND shard = $1`,
    [deps.shard.index],
  )
  return rows[0]?.finished_at ? Date.now() - rows[0].finished_at.getTime() : Infinity
}

loop('full-scan', 15_000, async () => {
  if ((await lastFullScanAgeMs()) >= config.scanner.fullScanIntervalMs) await runFullScan('interval')
})

loop('changes', config.scanner.changePollMs, async () => {
  const result = await processChanges(deps)
  if (result.resyncFrom !== undefined) {
    logger.warn({ cursor: result.cursor, latest: result.resyncFrom }, 'change feed cursor expired; resyncing with a full scan')
    await runFullScan('cursor expired')
    await saveCursor(deps, result.resyncFrom, null)
  }
})

loop('evidence', config.scanner.evidenceIntervalMs, async () => {
  const n = await refreshEvidence(deps, { limit: 300 })
  if (n > 0) logger.info({ accounts: n }, 'usage evidence refreshed')
})

loop('workflow', config.scanner.workflowIntervalMs, async () => {
  const stats = await runWorkflow()
  if (stats && (stats.expired || stats.expiring || stats.digests || stats.escalations)) logger.info(stats, 'owner workflow')
})

if (deps.shard.index === 0) {
  loop('posture', config.scanner.postureIntervalMs, async () => {
    const posture = await snapshotPosture(pool)
    for (const p of posture) findingsGauge.set({ control: p.controlId }, p.open)
  })
}

const commands = createRedisConnection('scanner-commands')
await commands.subscribe('scanner:commands')
commands.on('message', (_channel, message) => {
  if (message === 'full-scan') void runFullScan('requested')
  if (message === 'evidence') void refreshEvidence(deps, { limit: 5000, force: true }).catch((err) => logger.warn({ err }, 'forced evidence refresh failed'))
})

const app = express()
app.get('/health', (_req, res) => res.json({ status: 'ok', shard: deps.shard, fullScanRunning: Boolean(fullScanRunning) }))
app.get('/metrics', metricsHandler)
const server = app.listen(config.scannerPort, () => logger.info({ port: config.scannerPort, shard: deps.shard, sim: config.simUrl }, 'scanner listening'))

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  stopping = true
  timers.forEach(clearTimeout)
  server.close()
  await Promise.allSettled([commands.quit(), redis.quit(), pool.end()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
