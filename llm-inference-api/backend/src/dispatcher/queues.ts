/**
 * Queue reads and atomic moves for the dispatcher: class state for the batch
 * policy, per-tenant heads for the fair picker, claim (queue → in flight) and
 * requeue (in flight → head of the tenant queue, original enqueue time kept).
 * @module dispatcher/queues
 */
import { keys, redis, runScript, type PriorityClass } from '../shared/cache.js'
import type { Job } from '../shared/requests.js'
import type { ClassQueueState } from './batch-policy.js'
import type { TenantQueueView } from './fairness.js'

export async function classState(cls: PriorityClass): Promise<ClassQueueState> {
  const res = await redis
    .multi()
    .zcard(keys.age(cls))
    .zrange(keys.age(cls), 0, 0, 'WITHSCORES')
    .zrange(keys.deadline(cls), 0, 0, 'WITHSCORES')
    .exec()
  const depth = Number(res?.[0]?.[1] ?? 0)
  const oldest = (res?.[1]?.[1] as string[]) ?? []
  const dl = (res?.[2]?.[1] as string[]) ?? []
  return {
    depth,
    oldestEnqueuedAt: oldest.length === 2 ? Number(oldest[1]) : null,
    earliestDeadline: dl.length === 2 ? Number(dl[1]) : null,
  }
}

/** The first `n` queued requests of every tenant in a class, with their jobs. */
export async function tenantViews(cls: PriorityClass, n: number): Promise<{ views: TenantQueueView[]; jobs: Map<string, Job> }> {
  const tenants = await redis.smembers(keys.tenants(cls))
  if (tenants.length === 0) return { views: [], jobs: new Map() }
  const lists = await Promise.all(tenants.map((t) => redis.lrange(keys.tenantQueue(cls, t), 0, n - 1)))
  const ids = lists.flat()
  const raws = ids.length > 0 ? await redis.mget(ids.map((id) => keys.job(id))) : []
  const jobs = new Map<string, Job>()
  ids.forEach((id, i) => {
    const raw = raws[i]
    if (raw) jobs.set(id, JSON.parse(raw) as Job)
  })
  const views = tenants.map((orgId, i) => ({
    orgId,
    weight: jobs.get(lists[i][0])?.weight ?? 1,
    heads: lists[i].map((id) => ({ id, cost: jobs.get(id)?.cost ?? 1 })),
  }))
  return { views, jobs }
}

export async function claim(cls: PriorityClass, picks: { id: string; orgId: string }[]): Promise<string[]> {
  if (picks.length === 0) return []
  return runScript<string[]>(
    'CLAIM',
    [keys.age(cls), keys.deadline(cls), keys.inflight, keys.tenants(cls)],
    [Date.now(), keys.tenantQueuePrefix(cls), ...picks.flatMap((p) => [p.id, p.orgId])],
  )
}

export async function requeue(jobs: Job[]): Promise<number> {
  let n = 0
  for (const cls of ['interactive', 'batch'] as PriorityClass[]) {
    const mine = jobs.filter((j) => j.cls === cls)
    if (mine.length === 0) continue
    n += await runScript<number>(
      'REQUEUE',
      [keys.age(cls), keys.deadline(cls), keys.inflight, keys.tenants(cls)],
      [keys.tenantQueuePrefix(cls), keys.jobPrefix, ...mine.flatMap((j) => [j.id, j.orgId, j.enqueuedAt, j.deadlineAt])],
    )
  }
  return n
}

/** Drops a request from in-flight tracking once it is finished. */
export async function release(id: string): Promise<void> {
  await redis.multi().zrem(keys.inflight, id).del(keys.job(id)).exec()
}
