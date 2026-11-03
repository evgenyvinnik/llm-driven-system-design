/**
 * The practice spec's API (levels 1-3 and backup) over PgBackend, so the
 * PostgreSQL implementation runs the same level tests as the worked answer.
 * Every FsError becomes the spec's `null` or `false`.
 * @module store/pg-spec-store
 */
import { FsError } from './backend.js'
import type { PgBackend } from './pg-backend.js'

export class PgSpecStore {
  constructor(private readonly backend: PgBackend) {}

  async addFile(path: string, size: number): Promise<boolean> {
    return (await attempt(() => this.backend.addFile(path, size, null))) !== null
  }

  async getSize(path: string): Promise<number | null> {
    return this.backend.getFileSize(path)
  }

  async updateFile(path: string, size: number): Promise<number | null> {
    return (await attempt(() => this.backend.updateFile(path, size)))?.previous ?? null
  }

  async deleteFile(path: string): Promise<number | null> {
    return (await attempt(() => this.backend.deleteFile(path)))?.size ?? null
  }

  async listDir(path: string): Promise<string[] | null> {
    const listing = await attempt(() => this.backend.listDir(path))
    return listing?.entries.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name)) ?? null
  }

  async dirSize(path: string): Promise<number | null> {
    return (await attempt(() => this.backend.listDir(path)))?.bytes ?? null
  }

  async largest(prefix: string, n: number): Promise<string[]> {
    return (await this.backend.largest(prefix, n)).map((f) => `${f.path}(${f.size})`)
  }

  async addUser(userId: string, capacity: number): Promise<boolean> {
    return (await attempt(() => this.backend.addUser(userId, capacity).then(() => true))) ?? false
  }

  async addFileAs(userId: string, path: string, size: number): Promise<number | null> {
    return (await attempt(() => this.backend.addFile(path, size, userId)))?.remaining ?? null
  }

  async getRemaining(userId: string): Promise<number | null> {
    return this.backend.getRemaining(userId)
  }

  async mergeUsers(targetId: string, sourceId: string): Promise<number | null> {
    return (await attempt(() => this.backend.mergeUsers(targetId, sourceId)))?.remaining ?? null
  }

  async backupUser(userId: string): Promise<number | null> {
    return (await attempt(() => this.backend.backupUser(userId)))?.fileCount ?? null
  }

  async restoreUser(userId: string): Promise<number | null> {
    return (await attempt(() => this.backend.restoreUser(userId)))?.restored ?? null
  }
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FsError) return null
    throw err
  }
}
