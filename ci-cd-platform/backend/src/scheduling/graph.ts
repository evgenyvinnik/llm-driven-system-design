/**
 * The dependency graph, as pure decisions. Everything here takes a snapshot of a
 * run's jobs and says what should change. The engine takes that snapshot while
 * holding the run's row lock, which is what makes the answer correct.
 * @module scheduling/graph
 */

export type JobStatus = 'blocked' | 'queued' | 'waiting' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'needs_attention'
export type RunStatus = 'queued' | 'running' | 'waiting' | 'needs_attention' | 'success' | 'failure' | 'cancelled'

export interface GraphJob {
  key: string
  name?: string
  status: JobStatus
  needs: string[]
}

const FAILED_OUTCOMES: JobStatus[] = ['failure', 'cancelled', 'skipped']
export const TERMINAL_JOB: JobStatus[] = ['success', 'failure', 'cancelled', 'skipped']

export interface Readiness {
  /** Every prerequisite succeeded: ready to enter its environment gate and the queue. */
  ready: string[]
  /** A prerequisite will never succeed. The reason names which one, and how it ended. */
  skip: { key: string; reason: string }[]
}

/**
 * One pass over the blocked jobs. A skip can make another job skippable, so the
 * engine applies the result and calls this again until nothing changes; a job
 * waiting on a `needs_attention` prerequisite stays blocked, because that outcome
 * isn't known yet.
 */
export function computeReadiness(jobs: GraphJob[]): Readiness {
  const byKey = new Map(jobs.map((j) => [j.key, j]))
  const ready: string[] = []
  const skip: Readiness['skip'] = []
  for (const job of jobs) {
    if (job.status !== 'blocked') continue
    const needs = job.needs.map((k) => byKey.get(k)).filter((j): j is GraphJob => j !== undefined)
    const broken = needs.find((n) => FAILED_OUTCOMES.includes(n.status))
    if (broken) {
      const how = broken.status === 'failure' ? 'failed' : broken.status === 'cancelled' ? 'was cancelled' : 'was skipped'
      skip.push({ key: job.key, reason: `Needs "${broken.name ?? broken.key}", which ${how}` })
    } else if (needs.every((n) => n.status === 'success')) {
      ready.push(job.key)
    }
  }
  return { ready, skip }
}

/**
 * A run's status is derived from its jobs and never set by hand, so it can't
 * disagree with them. A job needing a human outranks everything: otherwise a
 * long-running sibling would hide that a deploy's outcome is unknown.
 */
export function deriveRunStatus(jobs: Pick<GraphJob, 'status'>[], everStarted: boolean): RunStatus {
  const has = (s: JobStatus) => jobs.some((j) => j.status === s)
  if (has('needs_attention')) return 'needs_attention'
  if (has('running')) return 'running'
  if (has('queued')) return everStarted ? 'running' : 'queued'
  if (has('waiting')) return 'waiting'
  if (has('blocked')) return everStarted ? 'running' : 'queued'
  if (has('failure')) return 'failure'
  if (has('cancelled')) return 'cancelled'
  if (has('skipped')) return 'failure'
  return 'success'
}

/** Keys of everything downstream of `roots`, not including the roots. */
export function transitiveDependents(jobs: Pick<GraphJob, 'key' | 'needs'>[], roots: string[]): string[] {
  const out = new Set<string>()
  const seen = new Set(roots)
  const frontier = [...roots]
  while (frontier.length > 0) {
    const current = frontier.pop() as string
    for (const job of jobs) {
      if (job.needs.includes(current) && !seen.has(job.key)) {
        seen.add(job.key)
        out.add(job.key)
        frontier.push(job.key)
      }
    }
  }
  return [...out]
}

export type RerunMode = 'job' | 'failed' | 'all'

/** Which jobs a re-run resets. Dependents are included because their inputs are about to change. */
export function rerunSet(jobs: GraphJob[], mode: RerunMode, target?: string): string[] {
  if (mode === 'all') return jobs.map((j) => j.key)
  const roots = mode === 'job' ? (target ? [target] : []) : jobs.filter((j) => FAILED_OUTCOMES.includes(j.status)).map((j) => j.key)
  return [...new Set([...roots, ...transitiveDependents(jobs, roots)])]
}

/** Longest-path layering for the DAG view: a job sits one column right of its deepest prerequisite. */
export function layerOf(jobs: Pick<GraphJob, 'key' | 'needs'>[]): Map<string, number> {
  const needsOf = new Map(jobs.map((j) => [j.key, j.needs]))
  const memo = new Map<string, number>()
  const depth = (key: string): number => {
    const known = memo.get(key)
    if (known !== undefined) return known
    const value = (needsOf.get(key) ?? []).reduce((max, dep) => Math.max(max, depth(dep) + 1), 0)
    memo.set(key, value)
    return value
  }
  for (const job of jobs) depth(job.key)
  return memo
}
