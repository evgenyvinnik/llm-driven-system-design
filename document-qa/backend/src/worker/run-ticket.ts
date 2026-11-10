/**
 * Handles one pipeline ticket end to end: claim → run the stage with a
 * heartbeating lease → commit the result, the job completion and the next
 * job together → publish the next ticket. Failures go back to PostgreSQL as a
 * scheduled retry or a poisoned job; the RabbitMQ message is acked either way,
 * because the job row, not the message, is the record of what is left to do.
 * @module worker/run-ticket
 */
import type pg from 'pg'
import { withTransaction } from '../shared/db.js'
import { describeError } from '../shared/errors.js'
import { logger } from '../shared/logger.js'
import { jobDuration, jobOutcomes } from '../shared/metrics.js'
import type { TicketPublisher } from '../shared/queue.js'
import { cancelJob, claimJob, completeJob, deferJob, enqueueJob, failJob, markDispatched, PIPELINE_STAGES, type ClaimedJob } from '../pipeline/jobs.js'
import { handlers, LeaseLostError, makeContext } from '../pipeline/stages.js'
import { config } from '../shared/config.js'

class SupersededError extends Error {}

/** Marks the version (and, if nothing is being served yet, the document) failed with a reason. */
export function onPoisonFor(job: { stage: string; version_id: string | null; document_id: string; attempts: number }, error: string, permanent: boolean) {
  return async (client: pg.PoolClient) => {
    if (!PIPELINE_STAGES.includes(job.stage as never) || !job.version_id) return
    const reason = permanent ? `${job.stage}: ${error}` : `${job.stage} failed after ${job.attempts} attempts: ${error}`
    await client.query(`UPDATE document_versions SET status = 'failed', failure_reason = $2 WHERE id = $1`, [job.version_id, reason])
    await client.query(
      `UPDATE documents SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND current_version_id IS NULL AND deleted_at IS NULL`,
      [job.document_id, reason],
    )
    await client.query(`INSERT INTO document_events (document_id, kind, detail) VALUES ($1, 'processing_failed', $2)`, [job.document_id, { stage: job.stage, reason }])
  }
}

export async function runTicket(jobId: string, redelivered: boolean, workerId: string, publisher: TicketPublisher): Promise<string> {
  const job = await claimJob(jobId, workerId, redelivered)
  if (!job) return 'stale'
  if (job.tookOverFrom) logger.warn({ jobId, stage: job.stage, from: job.tookOverFrom, attempt: job.attempts }, 'took over a job from a worker that stopped')
  if (job.attempts > job.max_attempts) {
    const msg = 'a worker stopped on this job on every attempt'
    await failJob(job, msg, true, onPoisonFor(job, msg, false))
    jobOutcomes.inc({ stage: job.stage, outcome: 'poisoned' })
    return 'poisoned'
  }

  const timer = jobDuration.startTimer({ stage: job.stage })
  let lost = false
  const ctx = makeContext(job, workerId, () => (lost = true))
  const beat = setInterval(() => void ctx.keepAlive().catch(() => undefined), Math.max(1000, Math.floor(config.pipeline.leaseMs / 3)))
  try {
    const outcome = await handlers[job.stage](ctx)
    if (lost) throw new LeaseLostError('lease lost during the stage')
    if (outcome.kind === 'defer') {
      await deferJob(job, outcome.delayMs, outcome.reason)
      return 'deferred'
    }
    if (outcome.kind === 'cancelled') {
      await withTransaction(async (client) => {
        await cancelJob(client, job, outcome.reason)
        if (job.version_id && PIPELINE_STAGES.includes(job.stage)) {
          await client.query(`UPDATE document_versions SET status = 'cancelled' WHERE id = $1 AND status IN ('uploaded', 'processing')`, [job.version_id])
        }
      })
      jobOutcomes.inc({ stage: job.stage, outcome: 'cancelled' })
      return 'cancelled'
    }
    const toPublish = await withTransaction(async (client) => {
      const ids = ((await outcome.finalize?.(client)) ?? []).slice()
      if (!(await completeJob(client, job, outcome.detail))) throw new SupersededError('lease lost before commit')
      for (const spec of outcome.next ?? []) {
        const id = await enqueueJob(client, spec)
        if (id) ids.push(id)
      }
      return ids
    })
    if (await publisher.publish(toPublish)) await markDispatched(toPublish)
    jobOutcomes.inc({ stage: job.stage, outcome: 'succeeded' })
    return 'succeeded'
  } catch (err) {
    if (err instanceof SupersededError || err instanceof LeaseLostError) {
      jobOutcomes.inc({ stage: job.stage, outcome: 'superseded' })
      logger.warn({ jobId, stage: job.stage }, 'lease lost; another worker owns this job now')
      return 'superseded'
    }
    const message = describeError(err)
    const permanent = (err as { permanent?: boolean }).permanent === true
    const outcome = await failJob(job, message, permanent, onPoisonFor(job, message, permanent))
    jobOutcomes.inc({ stage: job.stage, outcome: outcome === 'poisoned' ? (permanent ? 'failed' : 'poisoned') : outcome })
    logger.warn({ jobId, stage: job.stage, attempt: job.attempts, outcome, err: message }, 'stage attempt failed')
    return outcome
  } finally {
    clearInterval(beat)
    timer()
  }
}

export type { ClaimedJob }
