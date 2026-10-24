/**
 * The service-side contract the API talks to. Two implementations:
 * - `MemoryBackend` wraps the worked-answer FileStore (no infrastructure needed).
 * - `PgBackend` stores the namespace in PostgreSQL and enforces the same rules
 *   with row locks, so it stays correct with concurrent requests and several API
 *   instances.
 *
 * Unlike the practice spec, whose methods return `null` or `false` on failure,
 * backend methods throw `FsError` with a reason code, so the API can say *why* a
 * write was refused.
 * @module store/backend
 */

export type FsErrorCode =
  | 'PATH_EXISTS'
  | 'PATH_IS_DIRECTORY'
  | 'PARENT_IS_FILE'
  | 'FILE_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'USER_NOT_FOUND'
  | 'USER_EXISTS'
  | 'SAME_USER'
  | 'OVER_CAPACITY'

export class FsError extends Error {
  constructor(
    public readonly code: FsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FsError'
  }
}

export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
  /** A file's size, or the total bytes below a directory. */
  size: number
  /** A file's owner (`null` if unowned). Always `null` for directories. */
  owner: string | null
  /** Files anywhere below a directory; 1 for a file. */
  fileCount: number
}

export interface DirListing {
  path: string
  bytes: number
  fileCount: number
  entries: DirEntry[]
}

export interface BackupSummary {
  fileCount: number
  bytes: number
  takenAt: string
}

export interface UserSummary {
  id: string
  capacity: number
  used: number
  fileCount: number
  backup: BackupSummary | null
}

export interface RestoreResult {
  restored: number
  /** Backed-up paths that were unavailable and left alone. */
  skipped: string[]
}

export interface FsBackend {
  readonly kind: 'memory' | 'postgres'

  /** Creates a file. Returns the owner's remaining capacity, or `null` for an unowned file. */
  addFile(path: string, size: number, owner: string | null): Promise<{ remaining: number | null }>
  /** Returns the previous size. */
  updateFile(path: string, size: number): Promise<{ previous: number }>
  /** Returns the deleted file's size. */
  deleteFile(path: string): Promise<{ size: number }>

  listDir(path: string): Promise<DirListing>
  largest(prefix: string, n: number): Promise<Array<{ path: string; size: number }>>

  addUser(id: string, capacity: number): Promise<void>
  listUsers(): Promise<UserSummary[]>
  /** Moves the source's files and capacity to the target. Returns the target's remaining capacity. */
  mergeUsers(targetId: string, sourceId: string): Promise<{ remaining: number }>

  backupUser(id: string): Promise<{ fileCount: number }>
  restoreUser(id: string): Promise<RestoreResult>

  /** Deletes everything (used by the seed and the demo reset). */
  clear(): Promise<void>
  close(): Promise<void>
}

/** `/a/b/c` → `/a/b`; a top-level entry's parent is `/`. */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === 0 ? '/' : path.slice(0, i)
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const SEGMENT = /^[^/\0]{1,255}$/

/** Well-formed per levels.md, plus the limits a real service needs. */
export function isValidPath(path: string): boolean {
  if (path.length > 1024 || !path.startsWith('/') || path === '/') return false
  return path
    .slice(1)
    .split('/')
    .every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/** Human-readable bytes for error messages: 1047376 → "1023 KB". */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${bytes < 0 ? '-' : ''}${text} ${units[unit]}`
}

export function overCapacity(owner: string, extraBytes: number, remaining: number): FsError {
  return new FsError('OVER_CAPACITY', `${owner} needs ${formatBytes(extraBytes)} more but has ${formatBytes(remaining)} left`)
}
