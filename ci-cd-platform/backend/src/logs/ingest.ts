/**
 * Log assembly. Runners upload numbered chunks: idempotent by (job, attempt, seq),
 * tolerant of retries and of arriving out of order. Assembly state lives in the
 * `log_streams` row, locked per request, so any API instance can take the next chunk.
 *
 * A chunk is stored encrypted until the gap before it is filled, then fed through the
 * masker into `log_lines`, where each line gets the next contiguous number. That number
 * is the offset a reader's Last-Event-ID carries, so "what you missed" is one query.
 * Plain text reaches storage only after masking, whichever runner sent it.
 * @module logs/ingest
 */
import type pg from 'pg'
import { decrypt, encrypt } from '../shared/crypto.js'
import { withTransaction } from '../shared/db.js'
import { HttpError, notFound } from '../shared/errors.js'
import { logChunks } from '../shared/metrics.js'
import { leaseLost } from '../scheduling/errors.js'
import { StreamMasker } from '../secrets/masking.js'
import { publishLogs } from './bus.js'

export const logAad = (jobId: string, attempt: number) => `logmask:${jobId}:${attempt}`
const partialAad = (jobId: string, attempt: number) => `logpartial:${jobId}:${attempt}`
const chunkAad = (jobId: string, attempt: number, seq: number) => `logchunk:${jobId}:${attempt}:${seq}`

export interface LogChunk {
  seq: number
  stepIndex: number
  text: string
}

export interface ClosedStream {
  jobId: string
  attempt: number
}

interface StreamRow {
  next_seq: number
  next_line: number
  partial_enc: string | null
  partial_step: number
  mask_enc: string | null
  closed_at: Date | null
  line_count: number
}

async function lockStream(client: pg.PoolClient, jobId: string, attempt: number): Promise<StreamRow | null> {
  const { rows } = await client.query<StreamRow>('SELECT next_seq, next_line, partial_enc, partial_step, mask_enc, closed_at, line_count FROM log_streams WHERE job_id = $1 AND attempt = $2 FOR UPDATE', [jobId, attempt])
  return rows[0] ?? null
}

function maskerFor(stream: StreamRow, jobId: string, attempt: number): StreamMasker {
  const values = stream.mask_enc ? (JSON.parse(decrypt(stream.mask_enc, logAad(jobId, attempt))) as string[]) : []
  const partial = stream.partial_enc ? decrypt(stream.partial_enc, partialAad(jobId, attempt)) : ''
  return new StreamMasker(values, partial)
}

async function appendLines(client: pg.PoolClient, jobId: string, attempt: number, firstLine: number, lines: { step: number; text: string }[]): Promise<void> {
  if (lines.length === 0) return
  await client.query(
    `INSERT INTO log_lines (job_id, attempt, line_no, step_index, text)
     SELECT $1, $2, $3::bigint + ord - 1, step, text FROM unnest($4::int[], $5::text[]) WITH ORDINALITY AS t(step, text, ord)`,
    [jobId, attempt, firstLine, lines.map((l) => l.step), lines.map((l) => l.text.replace(/\u0000/g, ''))],
  )
}

export interface IngestResult {
  accepted: number
  duplicates: number
  nextSeq: number
  lastLine: number
}

/**
 * @param fence checked against the job's current lease. A retry of a chunk that was already
 * stored is acknowledged even after the lease is gone: it changes nothing, and the runner
 * shouldn't treat its own earlier success as a failure.
 */
export async function ingestChunks(fence: { jobId: string; attempt: number; fencingToken: number; runnerId: string }, chunks: LogChunk[]): Promise<IngestResult> {
  const { jobId, attempt } = fence
  const result = await withTransaction(async (client) => {
    const stream = await lockStream(client, jobId, attempt)
    if (!stream) throw notFound('Log stream')
    const job = await client.query<{ status: string; fencing_token: number | null; attempt: number; runner_id: string | null }>('SELECT status, fencing_token, attempt, runner_id FROM jobs WHERE id = $1', [jobId])
    const current = job.rows[0]
    const valid = current && current.status === 'running' && current.fencing_token === fence.fencingToken && current.attempt === attempt && current.runner_id === fence.runnerId && !stream.closed_at
    if (!valid) {
      const known = await client.query<{ seq: number }>('SELECT seq FROM log_chunks WHERE job_id = $1 AND attempt = $2 AND seq = ANY($3::bigint[])', [jobId, attempt, chunks.map((c) => c.seq)])
      if (known.rows.length === chunks.length) return { accepted: 0, duplicates: chunks.length, nextSeq: stream.next_seq, lastLine: stream.next_line - 1 }
      logChunks.inc({ outcome: 'rejected' }, chunks.length)
      return { lost: true as const }
    }

    let accepted = 0
    for (const chunk of chunks) {
      if (chunk.seq < stream.next_seq) continue
      const { rowCount } = await client.query(`INSERT INTO log_chunks (job_id, attempt, seq, step_index, content_enc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [
        jobId,
        attempt,
        chunk.seq,
        chunk.stepIndex,
        encrypt(chunk.text, chunkAad(jobId, attempt, chunk.seq)),
      ])
      accepted += rowCount ?? 0
    }
    logChunks.inc({ outcome: 'duplicate' }, chunks.length - accepted)

    const pending = await client.query<{ seq: number; step_index: number; content_enc: string }>(
      'SELECT seq, step_index, content_enc FROM log_chunks WHERE job_id = $1 AND attempt = $2 AND seq >= $3 AND content_enc IS NOT NULL ORDER BY seq',
      [jobId, attempt, stream.next_seq],
    )
    let nextSeq = stream.next_seq
    let step = stream.partial_step
    const lines: { step: number; text: string }[] = []
    const masker = maskerFor(stream, jobId, attempt)
    for (const chunk of pending.rows) {
      if (chunk.seq !== nextSeq) break
      step = chunk.step_index
      for (const text of masker.feed(decrypt(chunk.content_enc, chunkAad(jobId, attempt, chunk.seq)))) lines.push({ step, text })
      nextSeq++
    }
    const assembled = nextSeq - stream.next_seq
    logChunks.inc({ outcome: 'assembled' }, assembled)
    logChunks.inc({ outcome: 'buffered' }, Math.max(0, accepted - assembled))
    if (assembled > 0) {
      await appendLines(client, jobId, attempt, stream.next_line, lines)
      await client.query(`UPDATE log_chunks SET content_enc = NULL WHERE job_id = $1 AND attempt = $2 AND seq >= $3 AND seq < $4`, [jobId, attempt, stream.next_seq, nextSeq])
      await client.query(`UPDATE log_streams SET next_seq = $3, next_line = next_line + $4, line_count = line_count + $4, partial_enc = $5, partial_step = $6 WHERE job_id = $1 AND attempt = $2`, [
        jobId,
        attempt,
        nextSeq,
        lines.length,
        masker.partial ? encrypt(masker.partial, partialAad(jobId, attempt)) : null,
        step,
      ])
    }
    return { accepted, duplicates: chunks.length - accepted, nextSeq, lastLine: stream.next_line + lines.length - 1 }
  })
  if ('lost' in result) throw leaseLost('logs')
  // Not awaited: the wake-up is a nudge, and a slow Valkey must not slow down log uploads.
  void publishLogs(jobId, attempt)
  return result
}

/**
 * Ends a stream, in the same transaction that ends the attempt. Chunks stranded behind a
 * gap are written with a marker that says so, the held-back partial line is flushed,
 * masked, and `trailer` lines (the platform's own notes) go last.
 */
export async function closeLogStream(client: pg.PoolClient, jobId: string, attempt: number, trailer: string[]): Promise<ClosedStream | null> {
  const stream = await lockStream(client, jobId, attempt)
  if (!stream || stream.closed_at) return null
  const masker = maskerFor(stream, jobId, attempt)
  const lines: { step: number; text: string }[] = []
  let step = stream.partial_step
  const stranded = await client.query<{ seq: number; step_index: number; content_enc: string }>('SELECT seq, step_index, content_enc FROM log_chunks WHERE job_id = $1 AND attempt = $2 AND content_enc IS NOT NULL ORDER BY seq', [
    jobId,
    attempt,
  ])
  let expected = stream.next_seq
  let gaps = 0
  for (const chunk of stranded.rows) {
    if (chunk.seq !== expected) {
      for (const text of masker.flush()) lines.push({ step, text })
      lines.push({ step, text: `[platform] ${chunk.seq - expected} log chunk(s) never arrived (seq ${expected}-${chunk.seq - 1})` })
      gaps += chunk.seq - expected
    }
    step = chunk.step_index
    for (const text of masker.feed(decrypt(chunk.content_enc, chunkAad(jobId, attempt, chunk.seq)))) lines.push({ step, text })
    expected = chunk.seq + 1
  }
  for (const text of masker.flush()) lines.push({ step, text })
  for (const text of trailer) lines.push({ step, text })
  await appendLines(client, jobId, attempt, stream.next_line, lines)
  await client.query(`UPDATE log_chunks SET content_enc = NULL WHERE job_id = $1 AND attempt = $2`, [jobId, attempt])
  await client.query(`UPDATE log_streams SET next_line = next_line + $3, line_count = line_count + $3, next_seq = $4, partial_enc = NULL, gap_chunks = $5, closed_at = now() WHERE job_id = $1 AND attempt = $2`, [
    jobId,
    attempt,
    lines.length,
    expected,
    gaps,
  ])
  return { jobId, attempt }
}

export function publishLogTick(closed: ClosedStream): void {
  void publishLogs(closed.jobId, closed.attempt)
}

export function validateChunks(chunks: LogChunk[], maxBytes: number): void {
  for (const chunk of chunks) {
    if (Buffer.byteLength(chunk.text, 'utf8') > maxBytes) throw new HttpError(413, 'CHUNK_TOO_LARGE', `Log chunk ${chunk.seq} is larger than ${maxBytes} bytes`)
  }
}
