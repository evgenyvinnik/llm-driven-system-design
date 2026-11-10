/**
 * The API's ticket publisher. Publishing happens after the transaction that
 * created the job commits; if the broker is down or the confirm fails, the
 * job keeps `dispatched_at = NULL` and a worker's sweeper publishes it within
 * a second of the broker coming back. Nothing is lost, only delayed.
 * @module api/services/publish
 */
import { config } from '../../shared/config.js'
import { TicketPublisher } from '../../shared/queue.js'
import { markDispatched } from '../../pipeline/jobs.js'

let publisher: TicketPublisher | null = null

export function getPublisher(): TicketPublisher {
  if (!publisher) publisher = new TicketPublisher(`api-${config.apiPort}`)
  return publisher
}

export async function publishJobs(jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return
  if (await getPublisher().publish(jobIds)) await markDispatched(jobIds)
}
