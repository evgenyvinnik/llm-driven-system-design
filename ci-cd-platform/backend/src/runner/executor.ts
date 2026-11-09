/**
 * Executes one claimed job: a fresh workspace, checkout at the pinned commit, artifacts
 * from `needs`, then the steps in order. The order of operations in `runSteps` is the
 * safety argument: the start of a step is recorded BEFORE its process exists, and if that
 * write fails the step doesn't run.
 * @module runner/executor
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../shared/logger.js'
import type { ClaimedJob } from '../scheduling/claim.js'
import { LeaseLostError, type RunnerClient } from './client.js'
import { buildStepEnv, type ResourceLimits } from './env.js'
import { LogShipper } from './log-shipper.js'
import { runStepProcess, type StepRun } from './process.js'
import { confined, confinedReal, createAttemptDirs, removeAttemptDirs, writeTree, type AttemptDirs } from './workspace.js'

export interface ExecutorOptions {
  client: RunnerClient
  workspaceBase: string
  limits: ResourceLimits
}

export interface JobHandle {
  /** The run was cancelled: kill the current step and report. */
  cancel: () => void
  /** The lease is gone: kill the current step and stop writing. */
  loseLease: () => void
  done: Promise<void>
}

const RETRYABLE_DELAY_MS = 300

/** Retries a fenced write through transient failures; a lost lease stops immediately. */
async function retrying<T>(what: string, jobId: string, fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof LeaseLostError) throw err
      lastError = err
      logger.warn({ err: (err as Error).message, what, jobId, try: i + 1 }, 'runner write failed; retrying')
      await new Promise((resolve) => setTimeout(resolve, RETRYABLE_DELAY_MS * (i + 1)))
    }
  }
  throw lastError
}

export function executeJob(job: ClaimedJob, options: ExecutorOptions): JobHandle {
  const { client } = options
  let current: StepRun | null = null
  let cancelled = false
  let lost = false
  const killCurrent = () => current?.kill()

  const shipper = new LogShipper(client, job, () => {
    lost = true
    killCurrent()
  })

  async function prepare(dirs: AttemptDirs): Promise<void> {
    const { sha, tree } = await retrying('checkout', job.jobId, () => client.checkout(job))
    await writeTree(dirs.workspace, tree)
    shipper.note(0, `[runner] checked out ${sha.slice(0, 12)} into a fresh workspace (attempt ${job.attempt})`)
    if (job.secretsWithheld.length > 0) {
      for (const w of job.secretsWithheld) shipper.note(0, `[runner] secret ${w.name} withheld: ${w.reason}`)
    }
    const artifacts = await retrying('needs-artifacts', job.jobId, () => client.listNeedsArtifacts(job))
    for (const artifact of artifacts) {
      const bytes = await retrying('artifact', job.jobId, () => client.downloadArtifact(job, artifact.id))
      await writeFile(join(dirs.artifacts, artifact.name), bytes)
      shipper.note(0, `[runner] downloaded artifact ${artifact.name} from ${artifact.jobKey} (${bytes.length} bytes)`)
    }
  }

  /** Returns how the job ended. Step results that can't be reported leave the step `running`, which the server treats as unknown. */
  async function runSteps(dirs: AttemptDirs): Promise<{ conclusion: 'success' | 'failure' | 'cancelled'; reason: string | null; lastStep: string | null }> {
    let lastStep: string | null = null
    for (const [index, step] of job.steps.entries()) {
      if (lost) throw new LeaseLostError()
      if (cancelled) return { conclusion: 'cancelled', reason: 'Cancelled before this step started', lastStep }
      lastStep = step.name

      // Write-ahead intent: it commits, or this step does not run.
      await retrying('step-start', job.jobId, () => client.startStep(job, index))
      if (lost) throw new LeaseLostError()

      const scriptPath = join(dirs.scripts, `step-${index}.sh`)
      await writeFile(scriptPath, step.run, { mode: 0o700 })
      shipper.note(index, `[runner] ▶ ${step.name}${step.idempotent ? '' : ' (non-idempotent)'}`)
      const started = Date.now()
      current = runStepProcess({
        scriptPath,
        cwd: dirs.workspace,
        env: buildStepEnv(job, step.env, { workspace: dirs.workspace, artifacts: dirs.artifacts }),
        timeoutMs: step.timeoutSeconds * 1000,
        limits: { ...options.limits, cpuSeconds: Math.max(options.limits.cpuSeconds, step.timeoutSeconds + 5) },
        onOutput: (text) => shipper.write(index, text),
      })
      if (cancelled || lost) current.kill()
      const { outcome, exitCode } = await current.done
      current = null
      shipper.endStep(index)
      shipper.note(index, `[runner] ${step.name}: ${outcome}${exitCode !== null ? ` (exit ${exitCode})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      if (lost) {
        return { conclusion: outcome === 'success' ? 'success' : 'failure', reason: `Step "${step.name}" ended ${outcome} after this runner lost its lease`, lastStep }
      }
      await shipper.drain()
      await retrying('step-finish', job.jobId, () => client.finishStep(job, index, outcome, exitCode))

      if (outcome === 'killed') return { conclusion: 'cancelled', reason: `Step "${step.name}" was killed`, lastStep }
      if (outcome === 'timed_out') return { conclusion: 'failure', reason: `Step "${step.name}" exceeded its ${step.timeoutSeconds} s timeout`, lastStep }
      if (outcome === 'failure') return { conclusion: 'failure', reason: `Step "${step.name}" exited ${exitCode}`, lastStep }
    }
    for (const upload of job.uploads) {
      const path = await confinedReal(dirs.workspace, upload.path)
      if (!path) return { conclusion: 'failure', reason: `Artifact "${upload.name}": ${upload.path} does not exist, or is outside the workspace`, lastStep }
      const bytes = await readFile(path)
      await retrying('artifact-upload', job.jobId, () => client.uploadArtifact(job, upload.name, bytes, upload.retentionDays))
      shipper.note(job.steps.length - 1, `[runner] uploaded artifact ${upload.name} (${bytes.length} bytes, kept ${upload.retentionDays} days)`)
    }
    return { conclusion: 'success', reason: null, lastStep }
  }

  const done = (async () => {
    let dirs: AttemptDirs | null = null
    try {
      dirs = await createAttemptDirs(options.workspaceBase, `${job.jobKey}-a${job.attempt}`)
      await mkdir(join(dirs.workspace, '.tmp'), { recursive: true })
      if (!confined(dirs.root, 'workspace')) throw new Error('workspace escaped its root')
      await prepare(dirs)
      const result = await runSteps(dirs)
      await shipper.drain()
      if (lost) {
        // Rejected as truth, but the server keeps it as evidence for whoever is deciding.
        await client.complete(job, result.conclusion, result.reason).catch(() => undefined)
      } else {
        await retrying('complete', job.jobId, () => client.complete(job, result.conclusion, result.reason))
      }
    } catch (err) {
      if (err instanceof LeaseLostError) {
        logger.warn({ jobId: job.jobId, attempt: job.attempt }, 'lease lost; abandoning this attempt')
        killCurrent()
      } else {
        logger.error({ err: (err as Error).message, jobId: job.jobId }, 'job failed in the runner itself')
        shipper.note(0, `[runner] internal error: ${(err as Error).message}`)
        await shipper.drain().catch(() => undefined)
        await client.complete(job, 'failure', `Runner error: ${(err as Error).message}`).catch(() => undefined)
      }
    } finally {
      shipper.stop()
      if (dirs) await removeAttemptDirs(dirs).catch((err: Error) => logger.warn({ err: err.message }, 'workspace cleanup failed'))
    }
  })()

  return {
    done,
    cancel: () => {
      cancelled = true
      killCurrent()
    },
    loseLease: () => {
      lost = true
      killCurrent()
    },
  }
}
