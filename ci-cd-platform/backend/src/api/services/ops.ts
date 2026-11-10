/**
 * The numbers the ops view and the load script share: queue depth per label, per
 * repository concurrency, and how a burst behaved. Scoped to what the viewer can read.
 * @module api/services/ops
 */
import { pool } from '../../shared/db.js'

export interface Interval {
  repoId: string
  start: number
  end: number
}

/** Peak number of overlapping intervals, by sweeping start and end events. Ends sort first at a tie. */
export function peakConcurrency(intervals: Pick<Interval, 'start' | 'end'>[]): number {
  const events = intervals.flatMap((i) => [{ at: i.start, delta: 1 }, { at: i.end, delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta)
  let current = 0
  let peak = 0
  for (const e of events) {
    current += e.delta
    peak = Math.max(peak, current)
  }
  return peak
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export interface BurstRow {
  repoId: string
  fullName: string
  limit: number
  jobs: number
  finished: number
  peakConcurrent: number
  waitP50Ms: number
  waitMaxMs: number
  firstStartMs: number | null
}

/** Attempts started since `since`: concurrency from the lease intervals, wait from queued to started. */
export async function burstReport(repoIds: string[], since: Date): Promise<BurstRow[]> {
  const { rows } = await pool.query<{ repo_id: string; full_name: string; limit: number; queued_at: Date | null; started_at: Date; finished_at: Date | null; created_at: Date }>(
    `SELECT j.repo_id, r.full_name, r.max_concurrent_jobs AS limit, a.queued_at, a.started_at, a.finished_at, a.created_at
       FROM job_attempts a JOIN jobs j ON j.id = a.job_id JOIN repositories r ON r.id = j.repo_id
      WHERE a.started_at IS NOT NULL AND a.started_at >= $1 AND j.repo_id = ANY($2::text[])`,
    [since, repoIds],
  )
  const byRepo = new Map<string, typeof rows>()
  for (const row of rows) byRepo.set(row.repo_id, [...(byRepo.get(row.repo_id) ?? []), row])
  const now = Date.now()
  return [...byRepo.entries()]
    .map(([repoId, list]) => {
      const waits = list.map((r) => Math.max(0, r.started_at.getTime() - (r.queued_at ?? r.created_at).getTime())).sort((a, b) => a - b)
      return {
        repoId,
        fullName: list[0].full_name,
        limit: list[0].limit,
        jobs: list.length,
        finished: list.filter((r) => r.finished_at !== null).length,
        peakConcurrent: peakConcurrency(list.map((r) => ({ start: r.started_at.getTime(), end: (r.finished_at ?? new Date(now)).getTime() }))),
        waitP50Ms: percentile(waits, 0.5),
        waitMaxMs: waits[waits.length - 1],
        firstStartMs: Math.min(...list.map((r) => r.started_at.getTime())) - since.getTime(),
      }
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
}

export interface TimelineBucket {
  at: string
  starts: Record<string, number>
}

export async function startsTimeline(repoIds: string[], seconds: number, bucketSeconds: number): Promise<TimelineBucket[]> {
  const { rows } = await pool.query<{ bucket: Date; full_name: string; n: number }>(
    `SELECT date_bin(make_interval(secs => $3::int), a.started_at, TIMESTAMPTZ '2000-01-01') AS bucket, r.full_name, count(*)::int AS n
       FROM job_attempts a JOIN jobs j ON j.id = a.job_id JOIN repositories r ON r.id = j.repo_id
      WHERE a.started_at >= now() - make_interval(secs => $2::int) AND j.repo_id = ANY($1::text[])
      GROUP BY 1, 2 ORDER BY 1`,
    [repoIds, seconds, bucketSeconds],
  )
  const buckets = new Map<string, TimelineBucket>()
  for (const r of rows) {
    const at = r.bucket.toISOString()
    const bucket = buckets.get(at) ?? { at, starts: {} }
    bucket.starts[r.full_name] = r.n
    buckets.set(at, bucket)
  }
  return [...buckets.values()]
}
