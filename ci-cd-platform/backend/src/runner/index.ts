/**
 * A runner: registers with labels, claims jobs that match them, and runs up to RUNNER_SLOTS
 * at a time. It talks only to the API. If it can't renew a lease for a full lease period it
 * stops the step itself: the server has probably given the job away by then, and two
 * runners must not keep working on it.
 * @module runner/index
 */
process.env.SERVICE_NAME ??= process.env.RUNNER_NAME ?? `runner-${process.pid}`
const { config } = await import('../shared/config.js')
const { logger } = await import('../shared/logger.js')
const { startWorkerHttp } = await import('../shared/worker-http.js')
const { RunnerClient, UnauthorizedError } = await import('./client.js')
const { executeJob } = await import('./executor.js')
const { rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const name = process.env.RUNNER_NAME ?? `runner-${process.pid}`
const labels = (process.env.RUNNER_LABELS ?? 'linux,x64').split(',').map((l) => l.trim()).filter(Boolean)
const slots = Number(process.env.RUNNER_SLOTS ?? 2)
const pollMs = Number(process.env.RUNNER_POLL_MS ?? 400)
const baseUrls = (process.env.API_URLS ?? process.env.API_URL ?? `http://localhost:${config.apiPort}`).split(',').map((u) => u.trim()).filter(Boolean)
const workspaceBase = join(process.env.RUNNER_WORKSPACE_ROOT ?? join(tmpdir(), 'ci-cd-runner'), name)
const limits = { cpuSeconds: Number(process.env.RUNNER_CPU_SECONDS ?? 60), fileSizeMb: Number(process.env.RUNNER_FILE_SIZE_MB ?? 64), openFiles: Number(process.env.RUNNER_OPEN_FILES ?? 1024) }

const client = new RunnerClient(baseUrls)
let heartbeatMs = config.lease.heartbeatMs
let leaseMs = config.lease.ms

interface Active {
  attempt: number
  fencingToken: number
  lastRenewed: number
  cancel: () => void
  loseLease: () => void
}
const active = new Map<string, Active>()
let stopping = false

async function register(): Promise<void> {
  for (;;) {
    try {
      const reg = await client.register(config.runnerRegistrationToken, { name, labels, slots, pid: process.pid })
      client.setToken(reg.token)
      heartbeatMs = reg.heartbeatMs
      leaseMs = reg.leaseMs
      logger.info({ name, labels, slots, incarnation: reg.incarnation, api: client.currentUrl }, 'runner registered')
      return
    } catch (err) {
      logger.warn({ err: (err as Error).message, code: (err as { cause?: { code?: string } }).cause?.code }, 'cannot register yet; retrying')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

async function heartbeatLoop(): Promise<void> {
  while (!stopping) {
    const jobs = [...active.entries()].map(([jobId, a]) => ({ jobId, attempt: a.attempt, fencingToken: a.fencingToken }))
    try {
      const result = await client.heartbeat(jobs)
      if (result.die) {
        logger.warn('chaos: killing this runner with SIGKILL, as requested')
        process.kill(process.pid, 'SIGKILL')
      }
      for (const r of result.jobs) {
        const entry = active.get(r.jobId)
        if (!entry) continue
        if (!r.ok) {
          logger.warn({ jobId: r.jobId }, 'heartbeat rejected: the lease is gone, stopping the step')
          entry.loseLease()
          active.delete(r.jobId)
          continue
        }
        entry.lastRenewed = Date.now()
        if (r.cancel) entry.cancel()
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) await register()
      else logger.warn({ err: (err as Error).message, code: (err as { cause?: { code?: string } }).cause?.code }, 'heartbeat failed')
      for (const [jobId, entry] of active) {
        if (Date.now() - entry.lastRenewed > leaseMs) {
          logger.warn({ jobId }, 'could not renew for a whole lease period; fencing myself')
          entry.loseLease()
          active.delete(jobId)
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, heartbeatMs))
  }
}

async function claimLoop(): Promise<void> {
  while (!stopping) {
    if (active.size >= slots) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    try {
      const job = await client.claim()
      if (job) {
        logger.info({ job: job.jobKey, jobId: job.jobId, attempt: job.attempt, token: job.fencingToken }, 'claimed')
        const handle = executeJob(job, { client, workspaceBase, limits })
        active.set(job.jobId, { attempt: job.attempt, fencingToken: job.fencingToken, lastRenewed: Date.now(), cancel: handle.cancel, loseLease: handle.loseLease })
        void handle.done.finally(() => {
          if (active.get(job.jobId)?.fencingToken === job.fencingToken) active.delete(job.jobId)
        })
        continue
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) await register()
      else logger.warn({ err: (err as Error).message, code: (err as { cause?: { code?: string } }).cause?.code }, 'claim failed')
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs * (0.75 + Math.random() / 2)))
  }
}

// Workspaces of a previous incarnation that was killed: nobody else will clean them.
await rm(workspaceBase, { recursive: true, force: true }).catch(() => undefined)
const server = startWorkerHttp(Number(process.env.RUNNER_PORT ?? 3101), name, async () => undefined)
await register()
void heartbeatLoop()
void claimLoop()

function shutdown(signal: string) {
  logger.info({ signal }, 'runner shutting down; steps are killed and their leases will expire')
  stopping = true
  for (const entry of active.values()) entry.loseLease()
  server.close()
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
