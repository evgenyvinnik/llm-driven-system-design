/**
 * Reading a log by offset, from wherever it currently lives: PostgreSQL while the
 * attempt runs, MinIO after archival. Readers don't need to know which.
 * @module logs/read
 */
import { pool } from '../shared/db.js'
import { getBlob } from '../shared/storage.js'

export interface LogLine {
  n: number
  step: number
  text: string
  at: string
}

export interface ReadResult {
  lines: LogLine[]
  /** No further line can ever appear after these. */
  complete: boolean
  source: 'database' | 'archive' | 'none'
  lastLine: number
}

interface StreamState {
  next_line: number
  closed_at: Date | null
  archived_key: string | null
}

async function loadStream(jobId: string, attempt: number): Promise<StreamState | null> {
  const { rows } = await pool.query<StreamState>('SELECT next_line, closed_at, archived_key FROM log_streams WHERE job_id = $1 AND attempt = $2', [jobId, attempt])
  return rows[0] ?? null
}

/** A small per-process cache: a finished log is immutable, and viewers reconnect to it repeatedly. */
const archiveCache = new Map<string, LogLine[]>()
const ARCHIVE_CACHE_ENTRIES = 32

async function readArchive(key: string): Promise<LogLine[]> {
  const cached = archiveCache.get(key)
  if (cached) return cached
  const body = (await getBlob(key)).toString('utf8')
  const lines = body
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogLine)
  if (archiveCache.size >= ARCHIVE_CACHE_ENTRIES) archiveCache.delete(archiveCache.keys().next().value as string)
  archiveCache.set(key, lines)
  return lines
}

async function fromArchive(key: string, after: number, limit: number, lastLine: number): Promise<ReadResult> {
  const all = await readArchive(key)
  const lines = all.filter((l) => l.n > after).slice(0, limit)
  return { lines, complete: lines.length === 0 || lines[lines.length - 1].n >= lastLine, source: 'archive', lastLine }
}

/** Lines after `after`, oldest first. */
export async function readLines(jobId: string, attempt: number, after: number, limit = 500): Promise<ReadResult> {
  const stream = await loadStream(jobId, attempt)
  if (!stream) {
    // The attempt never produced a stream: it hasn't started, or it finished without running (skipped, denied).
    const { rows } = await pool.query<{ finished_at: Date | null }>('SELECT finished_at FROM job_attempts WHERE job_id = $1 AND attempt = $2', [jobId, attempt])
    return { lines: [], complete: rows[0]?.finished_at != null, source: 'none', lastLine: 0 }
  }
  const lastLine = stream.next_line - 1
  if (stream.archived_key) return fromArchive(stream.archived_key, after, limit, lastLine)

  const { rows } = await pool.query<{ line_no: number; step_index: number; text: string; at: Date }>(
    'SELECT line_no, step_index, text, at FROM log_lines WHERE job_id = $1 AND attempt = $2 AND line_no > $3 ORDER BY line_no LIMIT $4',
    [jobId, attempt, after, limit],
  )
  if (rows.length === 0 && lastLine > after) {
    // Archived between the two reads: the rows are gone, the object is there.
    const fresh = await loadStream(jobId, attempt)
    if (fresh?.archived_key) return fromArchive(fresh.archived_key, after, limit, fresh.next_line - 1)
  }
  const lines = rows.map((r) => ({ n: r.line_no, step: r.step_index, text: r.text, at: r.at.toISOString() }))
  const cursor = lines.length > 0 ? lines[lines.length - 1].n : after
  return { lines, complete: stream.closed_at !== null && cursor >= lastLine, source: 'database', lastLine }
}
