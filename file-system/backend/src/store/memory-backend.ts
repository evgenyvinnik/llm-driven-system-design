/**
 * FsBackend over the worked-answer FileStore. State lives in this process, so it
 * suits one API instance and needs no infrastructure (`npm run dev:memory`).
 *
 * The spec methods only say *that* a write failed. Because FileStore is
 * synchronous and a failed call changes nothing, asking the store right after a
 * failure explains it exactly: nothing can run in between.
 * @module store/memory-backend
 */
import { ancestors, FileStore } from '../fs/file-store.js'
import {
  FsError,
  overCapacity,
  type BackupSummary,
  type DirEntry,
  type DirListing,
  type FsBackend,
  type RestoreResult,
  type UserSummary,
} from './backend.js'

export class MemoryBackend implements FsBackend {
  readonly kind = 'memory' as const
  private store = new FileStore()
  private readonly backupTimes = new Map<string, string>()

  async addFile(path: string, size: number, owner: string | null) {
    if (owner === null) {
      if (!this.store.addFile(path, size)) throw this.placementError(path)
      return { remaining: null }
    }
    const remaining = this.store.addFileAs(owner, path, size)
    if (remaining !== null) return { remaining }
    if (this.store.getRemaining(owner) === null) throw userNotFound(owner)
    throw this.placementErrorOrNull(path) ?? overCapacity(owner, size, this.store.getRemaining(owner)!)
  }

  async updateFile(path: string, size: number) {
    const previous = this.store.updateFile(path, size)
    if (previous !== null) return { previous }
    if (this.store.getSize(path) === null) throw fileNotFound(path)
    const owner = this.store.ownerOf(path)!
    throw overCapacity(owner, size - this.store.getSize(path)!, this.store.getRemaining(owner)!)
  }

  async deleteFile(path: string) {
    const size = this.store.deleteFile(path)
    if (size === null) throw fileNotFound(path)
    return { size }
  }

  async listDir(path: string): Promise<DirListing> {
    const names = this.store.listDir(path)
    if (names === null) throw new FsError('NOT_A_DIRECTORY', `${path} is not a directory`)
    const base = path === '/' ? '' : path
    const entries: DirEntry[] = names.map((name) => {
      if (name.endsWith('/')) {
        const dirPath = `${base}/${name.slice(0, -1)}`
        return { name: name.slice(0, -1), kind: 'dir', size: this.store.dirSize(dirPath)!, owner: null, fileCount: this.countFiles(dirPath) }
      }
      const filePath = `${base}/${name}`
      return { name, kind: 'file', size: this.store.getSize(filePath)!, owner: this.store.ownerOf(filePath) ?? null, fileCount: 1 }
    })
    return { path, bytes: this.store.dirSize(path)!, fileCount: entries.reduce((n, e) => n + e.fileCount, 0), entries }
  }

  async largest(prefix: string, n: number) {
    return this.store.largest(prefix, n).map(parseLargest)
  }

  async addUser(id: string, capacity: number) {
    if (!this.store.addUser(id, capacity)) throw new FsError('USER_EXISTS', `User ${id} already exists`)
  }

  async listUsers(): Promise<UserSummary[]> {
    const fileCounts = new Map<string, number>()
    for (const entry of this.store.largest('/', Number.MAX_SAFE_INTEGER).map(parseLargest)) {
      const owner = this.store.ownerOf(entry.path)
      if (owner) fileCounts.set(owner, (fileCounts.get(owner) ?? 0) + 1)
    }
    return this.store
      .listUsers()
      .map((user) => ({ ...user, fileCount: fileCounts.get(user.id) ?? 0, backup: this.backupSummary(user.id) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  async mergeUsers(targetId: string, sourceId: string) {
    const remaining = this.store.mergeUsers(targetId, sourceId)
    if (remaining !== null) {
      this.backupTimes.delete(sourceId)
      return { remaining }
    }
    if (targetId === sourceId) throw new FsError('SAME_USER', 'Cannot merge a user into itself')
    throw userNotFound(this.store.getRemaining(targetId) === null ? targetId : sourceId)
  }

  async backupUser(id: string) {
    const fileCount = this.store.backupUser(id)
    if (fileCount === null) throw userNotFound(id)
    this.backupTimes.set(id, new Date().toISOString())
    return { fileCount }
  }

  async restoreUser(id: string): Promise<RestoreResult> {
    const backup = this.store.backupOf(id) ?? []
    const restored = this.store.restoreUser(id)
    if (restored === null) throw userNotFound(id)
    // A backed-up path that isn't the user's file now is one the restore skipped.
    const skipped = backup.filter((entry) => this.store.ownerOf(entry.path) !== id).map((entry) => entry.path)
    return { restored, skipped }
  }

  async clear() {
    this.store = new FileStore()
    this.backupTimes.clear()
  }

  async close() {}

  private backupSummary(id: string): BackupSummary | null {
    const backup = this.store.backupOf(id)
    if (!backup) return null
    return {
      fileCount: backup.length,
      bytes: backup.reduce((sum, entry) => sum + entry.size, 0),
      takenAt: this.backupTimes.get(id) ?? new Date(0).toISOString(),
    }
  }

  private countFiles(dirPath: string): number {
    return this.store.largest(`${dirPath}/`, Number.MAX_SAFE_INTEGER).length
  }

  private placementError(path: string): FsError {
    return this.placementErrorOrNull(path) ?? new FsError('PATH_EXISTS', `${path} is unavailable`)
  }

  private placementErrorOrNull(path: string): FsError | null {
    if (this.store.getSize(path) !== null) return new FsError('PATH_EXISTS', `${path} already exists`)
    if (this.store.listDir(path) !== null) return new FsError('PATH_IS_DIRECTORY', `${path} is a directory`)
    const fileAncestor = ancestors(path).find((dir) => this.store.getSize(dir) !== null)
    if (fileAncestor) return new FsError('PARENT_IS_FILE', `${fileAncestor} is a file`)
    return null
  }
}

function parseLargest(formatted: string): { path: string; size: number } {
  const open = formatted.lastIndexOf('(')
  return { path: formatted.slice(0, open), size: Number(formatted.slice(open + 1, -1)) }
}

function userNotFound(id: string) {
  return new FsError('USER_NOT_FOUND', `User ${id} not found`)
}

function fileNotFound(path: string) {
  return new FsError('FILE_NOT_FOUND', `No file at ${path}`)
}
