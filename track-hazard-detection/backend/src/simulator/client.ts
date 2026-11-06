/** Posts edge batches to the ingest API. */
import { config } from '../shared/config.js'

export interface EdgeEvent {
  eventId: string
  seq: number
  type: string
  version: number
  occurredAt: string
  payload: Record<string, unknown>
}

export interface BatchBody {
  sourceId: string
  batchId: string
  watermark?: string | null
  bufferedCount?: number
  events: EdgeEvent[]
}

export interface BatchReply {
  accepted: number
  duplicates: number
  critical: number
  late: number
}

export async function postBatch(body: BatchBody, apiUrl = config.apiUrl): Promise<BatchReply> {
  const res = await fetch(`${apiUrl}/api/v1/ingest/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': config.ingestToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`)
  return (await res.json()) as BatchReply
}
