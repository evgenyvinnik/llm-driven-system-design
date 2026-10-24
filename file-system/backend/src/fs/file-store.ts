/**
 * Worked answer to levels.md: an in-memory file store covering all four levels,
 * including both level-4 tracks (backup and time).
 *
 * The data model was picked for level 4 on day one, so later levels add methods
 * rather than rewrites:
 * - `files` holds each live file once, keyed by its full path.
 * - `dirFiles` counts the live files below each directory. That makes "is this
 *   path a directory?" O(1) and the placement rules O(depth), not a scan.
 * - `users` holds capacity and used bytes.
 * - `history` keeps every version of every path, for `getSizeAt`.
 *
 * Those four structures are only changed inside `link`, `unlink` and `resize`.
 * Keeping every mutation behind those three methods is what stops them drifting
 * apart, which is where hidden tests usually catch an answer out.
 *
 * Methods that fail check everything first and mutate last, so a failure never
 * leaves a partial change behind.
 * @module fs/file-store
 */

interface FileRecord {
  size: number
  /** `null` for files created with `addFile`: they count against no one. */
  owner: string | null
  /** Absolute time the file expires, or `null` if it never does. */
  expiresAt: number | null
}

interface UserRecord {
  capacity: number
  used: number
}

/** A version is live for `from <= t < to`. The current version has `to = Infinity`. */
interface Version {
  size: number
  from: number
  to: number
}

export interface BackupEntry {
  path: string
  size: number
}

export class FileStore {
  private readonly files = new Map<string, FileRecord>()
  private readonly dirFiles = new Map<string, number>()
  private readonly users = new Map<string, UserRecord>()
  private readonly backups = new Map<string, BackupEntry[]>()
  private readonly history = new Map<string, Version[]>()
  private now = 0

  // ── Level 1: files ─────────────────────────────────────────────────────────

  addFile(path: string, size: number, ttl?: number): boolean {
    if (!this.isAvailable(path)) return false
    this.link(path, size, null, ttl)
    return true
  }

  getSize(path: string): number | null {
    return this.files.get(path)?.size ?? null
  }

  updateFile(path: string, size: number): number | null {
    const file = this.files.get(path)
    if (!file) return null
    // Level 3 rule: growing an owned file must fit the owner's capacity.
    if (file.owner !== null && !this.fits(file.owner, size - file.size)) return null
    const previous = file.size
    this.resize(path, file, size)
    return previous
  }

  deleteFile(path: string): number | null {
    const file = this.files.get(path)
    if (!file) return null
    this.unlink(path, file, this.now)
    return file.size
  }

  // ── Level 2: queries ───────────────────────────────────────────────────────

  listDir(path: string): string[] | null {
    if (!this.isDir(path)) return null
    const base = path === '/' ? '/' : `${path}/`
    const isDirByName = new Map<string, boolean>()
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(base)) continue
      const rest = filePath.slice(base.length)
      const slash = rest.indexOf('/')
      if (slash === -1) isDirByName.set(rest, false)
      else isDirByName.set(rest.slice(0, slash), true)
    }
    // Sort by the bare name, then add the slash: "b/" sorts before "b.txt".
    return [...isDirByName.keys()].sort().map((name) => (isDirByName.get(name) ? `${name}/` : name))
  }

  dirSize(path: string): number | null {
    if (!this.isDir(path)) return null
    const base = path === '/' ? '/' : `${path}/`
    let total = 0
    for (const [filePath, file] of this.files) {
      if (filePath.startsWith(base)) total += file.size
    }
    return total
  }

  largest(prefix: string, n: number): string[] {
    if (n <= 0) return []
    return [...this.files]
      .filter(([path]) => path.startsWith(prefix))
      .sort(([pathA, a], [pathB, b]) => b.size - a.size || compare(pathA, pathB))
      .slice(0, n)
      .map(([path, file]) => `${path}(${file.size})`)
  }

  // ── Level 3: users and quotas ──────────────────────────────────────────────

  addUser(userId: string, capacity: number): boolean {
    if (this.users.has(userId)) return false
    this.users.set(userId, { capacity, used: 0 })
    return true
  }

  addFileAs(userId: string, path: string, size: number, ttl?: number): number | null {
    const user = this.users.get(userId)
    if (!user || !this.isAvailable(path) || !this.fits(userId, size)) return null
    this.link(path, size, userId, ttl)
    return user.capacity - user.used
  }

  getRemaining(userId: string): number | null {
    const user = this.users.get(userId)
    return user ? user.capacity - user.used : null
  }

  mergeUsers(targetId: string, sourceId: string): number | null {
    const target = this.users.get(targetId)
    const source = this.users.get(sourceId)
    if (!target || !source || targetId === sourceId) return null
    // O(files). A per-user index of paths would make this O(source's files).
    for (const file of this.files.values()) {
      if (file.owner === sourceId) file.owner = targetId
    }
    target.capacity += source.capacity
    target.used += source.used
    this.users.delete(sourceId)
    this.backups.delete(sourceId)
    return target.capacity - target.used
  }

  // ── Level 4, backup track ──────────────────────────────────────────────────

  backupUser(userId: string): number | null {
    if (!this.users.has(userId)) return null
    const snapshot = [...this.files]
      .filter(([, file]) => file.owner === userId)
      .map(([path, file]) => ({ path, size: file.size }))
    this.backups.set(userId, snapshot)
    return snapshot.length
  }

  restoreUser(userId: string): number | null {
    if (!this.users.has(userId)) return null
    // Collect first, then delete: never mutate a Map's entries while deciding what to remove.
    const owned = [...this.files].filter(([, file]) => file.owner === userId)
    for (const [path, file] of owned) this.unlink(path, file, this.now)

    let restored = 0
    for (const { path, size } of this.backups.get(userId) ?? []) {
      // No capacity check needed: the backup fit when it was taken, and capacity never shrinks.
      if (!this.isAvailable(path)) continue
      this.link(path, size, userId)
      restored += 1
    }
    return restored
  }

  // ── Level 4, time track ────────────────────────────────────────────────────

  setTime(t: number): boolean {
    if (t < this.now) return false
    this.now = t
    // O(files) per call. A min-heap keyed by expiresAt makes each expiry O(log n).
    for (const [path, file] of this.files) {
      if (file.expiresAt !== null && file.expiresAt <= t) this.unlink(path, file, file.expiresAt)
    }
    return true
  }

  getSizeAt(path: string, t: number): number | null {
    const version = this.history.get(path)?.find((v) => v.from <= t && t < v.to)
    return version?.size ?? null
  }

  // ── Not part of the spec: read helpers for the API's memory backend ────────

  /** The owner of the file at `path`: a user id, `null` if unowned, `undefined` if no file. */
  ownerOf(path: string): string | null | undefined {
    return this.files.get(path)?.owner
  }

  listUsers(): Array<{ id: string; capacity: number; used: number }> {
    return [...this.users].map(([id, user]) => ({ id, ...user }))
  }

  backupOf(userId: string): BackupEntry[] | null {
    return this.backups.get(userId) ?? null
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private isDir(path: string): boolean {
    return path === '/' || this.dirFiles.has(path)
  }

  /** A file can go at `path` if nothing is there and no ancestor is a file. */
  private isAvailable(path: string): boolean {
    if (this.files.has(path) || this.isDir(path)) return false
    return ancestors(path).every((dir) => !this.files.has(dir))
  }

  private fits(userId: string, extraBytes: number): boolean {
    const user = this.users.get(userId)
    return user !== undefined && user.used + extraBytes <= user.capacity
  }

  private link(path: string, size: number, owner: string | null, ttl?: number): void {
    this.files.set(path, { size, owner, expiresAt: ttl === undefined ? null : this.now + ttl })
    for (const dir of ancestors(path)) this.dirFiles.set(dir, (this.dirFiles.get(dir) ?? 0) + 1)
    if (owner !== null) this.users.get(owner)!.used += size
    this.openVersion(path, size)
  }

  private unlink(path: string, file: FileRecord, at: number): void {
    this.files.delete(path)
    for (const dir of ancestors(path)) {
      const count = this.dirFiles.get(dir)! - 1
      if (count === 0) this.dirFiles.delete(dir)
      else this.dirFiles.set(dir, count)
    }
    if (file.owner !== null) this.users.get(file.owner)!.used -= file.size
    this.closeVersion(path, at)
  }

  private resize(path: string, file: FileRecord, size: number): void {
    if (file.owner !== null) this.users.get(file.owner)!.used += size - file.size
    file.size = size
    this.closeVersion(path, this.now)
    this.openVersion(path, size)
  }

  private openVersion(path: string, size: number): void {
    const versions = this.history.get(path) ?? []
    versions.push({ size, from: this.now, to: Infinity })
    this.history.set(path, versions)
  }

  private closeVersion(path: string, at: number): void {
    const versions = this.history.get(path)
    if (versions) versions[versions.length - 1].to = at
  }
}

/** `/a/b/c` → `["/a", "/a/b"]`. The root is not included. */
export function ancestors(path: string): string[] {
  const result: string[] = []
  for (let i = path.indexOf('/', 1); i !== -1; i = path.indexOf('/', i + 1)) {
    result.push(path.slice(0, i))
  }
  return result
}

/** Plain code-unit order, the same as the default `Array.prototype.sort`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
