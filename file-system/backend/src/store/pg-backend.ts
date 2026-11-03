/**
 * FsBackend on PostgreSQL. The same rules as the worked answer, made safe for
 * concurrent requests from any number of API instances.
 *
 * - **Placement rules are enforced by the primary key.** Files and directories
 *   are rows of one table keyed by path. Creating `/a/b/c` upserts directory rows
 *   `/a` and `/a/b` (refusing if either is a file) and inserts the file row
 *   (refusing if the path exists). Two racing writers can't both succeed: the
 *   loser blocks on the winner's row and then sees it.
 * - **Quotas are reserved first.** A write by a user starts with a conditional
 *   update of the user's `used` counter, so an over-capacity write fails before
 *   touching the namespace. The CHECK constraint backs it up.
 * - **One lock order: user rows, then namespace rows top-down.** Every write
 *   locks the owning user first (merges lock both users, sorted by id), then
 *   ancestor directories from the root down, then the file. Holding a directory
 *   blocks anyone from reaching below it, so namespace locks can't form a cycle.
 *   The cost is that one user's writes run one at a time.
 *   `withTransaction` still retries a deadlock if PostgreSQL ever reports one.
 * @module store/pg-backend
 */
import type pg from 'pg'
import { withTransaction } from '../shared/db.js'
import { ancestors } from '../fs/file-store.js'
import {
  FsError,
  nameOf,
  overCapacity,
  parentOf,
  type DirListing,
  type FsBackend,
  type RestoreResult,
  type UserSummary,
} from './backend.js'

type Client = pg.PoolClient | pg.Pool

export class PgBackend implements FsBackend {
  readonly kind = 'postgres' as const

  constructor(private readonly pool: pg.Pool) {}

  // ── Writes ─────────────────────────────────────────────────────────────────

  async addFile(path: string, size: number, owner: string | null) {
    return withTransaction(this.pool, 'add_file', async (client) => {
      const remaining = owner === null ? null : await charge(client, owner, size)
      await this.insertNode(client, path, size, owner)
      return { remaining }
    })
  }

  async updateFile(path: string, size: number) {
    return withTransaction(this.pool, 'update_file', async (client) => {
      const owner = await lockOwnerOf(client, path)
      const dirs = ancestors(path)
      await lockDirs(client, dirs)
      const { rows } = await client.query<{ size: number; owner_id: string | null }>(
        `SELECT size, owner_id FROM fs_nodes WHERE path = $1 AND kind = 'file' FOR UPDATE`,
        [path],
      )
      if (rows.length === 0) throw fileNotFound(path)
      if (rows[0].owner_id !== owner) throw new RetryTransaction()
      const previous = rows[0].size
      const delta = size - previous
      if (owner !== null) await charge(client, owner, delta)
      await client.query(`UPDATE fs_nodes SET size = $2, updated_at = now() WHERE path = $1`, [path, size])
      if (dirs.length > 0 && delta !== 0) {
        await client.query(`UPDATE fs_nodes SET size = size + $2, updated_at = now() WHERE path = ANY($1)`, [dirs, delta])
      }
      return { previous }
    })
  }

  async deleteFile(path: string) {
    return withTransaction(this.pool, 'delete_file', async (client) => {
      const owner = await lockOwnerOf(client, path)
      const { size } = await this.removeFile(client, path, owner)
      return { size }
    })
  }

  async addUser(id: string, capacity: number) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO fs_users (id, capacity) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [id, capacity],
    )
    if (rowCount === 0) throw new FsError('USER_EXISTS', `User ${id} already exists`)
  }

  async mergeUsers(targetId: string, sourceId: string) {
    if (targetId === sourceId) throw new FsError('SAME_USER', 'Cannot merge a user into itself')
    return withTransaction(this.pool, 'merge_users', async (client) => {
      const { rows: users } = await client.query<{ id: string; capacity: number; used: number }>(
        `SELECT id, capacity, used FROM fs_users WHERE id = ANY($1) ORDER BY id FOR UPDATE`,
        [[targetId, sourceId]],
      )
      const source = users.find((u) => u.id === sourceId)
      if (!users.some((u) => u.id === targetId)) throw userNotFound(targetId)
      if (!source) throw userNotFound(sourceId)

      await client.query(`UPDATE fs_nodes SET owner_id = $1, updated_at = now() WHERE owner_id = $2 AND kind = 'file'`, [
        targetId,
        sourceId,
      ])
      const { rows } = await client.query<{ remaining: number }>(
        `UPDATE fs_users SET capacity = capacity + $2, used = used + $3 WHERE id = $1 RETURNING capacity - used AS remaining`,
        [targetId, source.capacity, source.used],
      )
      // Cascades to the source's backup, which a merge discards.
      await client.query(`DELETE FROM fs_users WHERE id = $1`, [sourceId])
      return { remaining: rows[0].remaining }
    })
  }

  async backupUser(id: string) {
    return withTransaction(this.pool, 'backup_user', async (client) => {
      await lockUser(client, id)
      await client.query(`DELETE FROM fs_backups WHERE user_id = $1`, [id])
      await client.query(`INSERT INTO fs_backups (user_id) VALUES ($1)`, [id])
      // One statement copies the files, so the backup is a single consistent snapshot.
      await client.query(
        `INSERT INTO fs_backup_files (user_id, path, size)
         SELECT $1, path, size FROM fs_nodes WHERE owner_id = $1 AND kind = 'file'`,
        [id],
      )
      const { rows } = await client.query<{ file_count: number }>(
        `UPDATE fs_backups b SET file_count = s.n, bytes = s.bytes
         FROM (SELECT count(*)::int AS n, COALESCE(sum(size), 0) AS bytes FROM fs_backup_files WHERE user_id = $1) s
         WHERE b.user_id = $1 RETURNING b.file_count`,
        [id],
      )
      return { fileCount: rows[0].file_count }
    })
  }

  async restoreUser(id: string): Promise<RestoreResult> {
    return withTransaction(this.pool, 'restore_user', async (client) => {
      // With the user locked, neither their files nor their backup can change under us.
      await lockUser(client, id)
      const owned = await client.query<{ path: string }>(
        `SELECT path FROM fs_nodes WHERE owner_id = $1 AND kind = 'file' ORDER BY path`,
        [id],
      )
      const backup = await client.query<{ path: string; size: number }>(
        `SELECT path, size FROM fs_backup_files WHERE user_id = $1 ORDER BY path`,
        [id],
      )
      // Lock every existing directory this restore will touch, in one global order,
      // before changing anything: deletes and inserts below interleave paths.
      const dirs = new Set([...owned.rows, ...backup.rows].flatMap(({ path }) => ancestors(path)))
      await lockDirs(client, [...dirs])
      for (const { path } of owned.rows) await this.removeFile(client, path, id)

      const skipped: string[] = []
      for (const { path, size } of backup.rows) {
        // A savepoint per file: an unavailable path rolls back only its own partial work.
        await client.query('SAVEPOINT restore_file')
        try {
          await charge(client, id, size)
          await this.insertNode(client, path, size, id)
          await client.query('RELEASE SAVEPOINT restore_file')
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT restore_file')
          if (!(err instanceof FsError)) throw err
          skipped.push(path)
        }
      }
      return { restored: backup.rows.length - skipped.length, skipped }
    })
  }

  async clear() {
    await this.pool.query('TRUNCATE fs_backup_files, fs_backups, fs_nodes, fs_users')
  }

  async close() {
    await this.pool.end()
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listDir(path: string): Promise<DirListing> {
    let bytes = 0
    let fileCount = 0
    if (path !== '/') {
      const { rows } = await this.pool.query<{ size: number; file_count: number }>(
        `SELECT size, file_count FROM fs_nodes WHERE path = $1 AND kind = 'dir'`,
        [path],
      )
      if (rows.length === 0) throw new FsError('NOT_A_DIRECTORY', `${path} is not a directory`)
      ;({ size: bytes, file_count: fileCount } = rows[0])
    }
    const { rows } = await this.pool.query<{ name: string; kind: 'file' | 'dir'; size: number; owner_id: string | null; file_count: number }>(
      `SELECT name, kind, size, owner_id, file_count FROM fs_nodes WHERE parent = $1 ORDER BY name`,
      [path],
    )
    const entries = rows.map((r) => ({ name: r.name, kind: r.kind, size: r.size, owner: r.owner_id, fileCount: r.file_count }))
    if (path === '/') {
      // The root has no row, so it can't become a hot spot every write touches.
      bytes = entries.reduce((sum, e) => sum + e.size, 0)
      fileCount = entries.reduce((sum, e) => sum + e.fileCount, 0)
    }
    return { path, bytes, fileCount, entries }
  }

  async largest(prefix: string, n: number) {
    if (n <= 0) return []
    const { rows } = await this.pool.query<{ path: string; size: number }>(
      `SELECT path, size FROM fs_nodes WHERE kind = 'file' AND path LIKE $1 ESCAPE '\\'
       ORDER BY size DESC, path LIMIT $2`,
      [`${escapeLike(prefix)}%`, n],
    )
    return rows
  }

  async listUsers(): Promise<UserSummary[]> {
    const { rows } = await this.pool.query<{
      id: string
      capacity: number
      used: number
      file_count: number
      backup_files: number | null
      backup_bytes: number | null
      taken_at: Date | null
    }>(
      `SELECT u.id, u.capacity, u.used,
              (SELECT count(*) FROM fs_nodes n WHERE n.owner_id = u.id AND n.kind = 'file') AS file_count,
              b.file_count AS backup_files, b.bytes AS backup_bytes, b.taken_at
       FROM fs_users u LEFT JOIN fs_backups b ON b.user_id = u.id
       ORDER BY u.id`,
    )
    return rows.map((r) => ({
      id: r.id,
      capacity: r.capacity,
      used: r.used,
      fileCount: r.file_count,
      backup: r.taken_at ? { fileCount: r.backup_files!, bytes: r.backup_bytes!, takenAt: r.taken_at.toISOString() } : null,
    }))
  }

  /** Spec reads used by the conformance adapter (PgSpecStore). */
  async getFileSize(path: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ size: number }>(`SELECT size FROM fs_nodes WHERE path = $1 AND kind = 'file'`, [path])
    return rows[0]?.size ?? null
  }

  async getRemaining(id: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ remaining: number }>(`SELECT capacity - used AS remaining FROM fs_users WHERE id = $1`, [id])
    return rows[0]?.remaining ?? null
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Inserts a file row and its directories inside the caller's transaction. Quota is the caller's job. */
  private async insertNode(client: pg.PoolClient, path: string, size: number, owner: string | null): Promise<void> {
    const dirs = ancestors(path)
    if (dirs.length > 0) {
      // Upsert every ancestor as a directory, top-down. The WHERE refuses to touch
      // a row that is a file, so a short row count means an ancestor is a file.
      const { rowCount } = await client.query(
        `INSERT INTO fs_nodes (path, parent, name, kind, size, file_count)
         SELECT d.path, d.parent, d.name, 'dir', $4, 1
         FROM unnest($1::text[], $2::text[], $3::text[]) AS d (path, parent, name)
         ON CONFLICT (path) DO UPDATE
           SET size = fs_nodes.size + EXCLUDED.size, file_count = fs_nodes.file_count + 1, updated_at = now()
           WHERE fs_nodes.kind = 'dir'`,
        [dirs, dirs.map(parentOf), dirs.map(nameOf), size],
      )
      if (rowCount !== dirs.length) {
        const { rows } = await client.query<{ path: string }>(
          `SELECT path FROM fs_nodes WHERE path = ANY($1) AND kind = 'file' ORDER BY path LIMIT 1`,
          [dirs],
        )
        throw new FsError('PARENT_IS_FILE', `${rows[0]?.path ?? 'An ancestor'} is a file`)
      }
    }

    const { rowCount } = await client.query(
      `INSERT INTO fs_nodes (path, parent, name, kind, size, file_count, owner_id)
       VALUES ($1, $2, $3, 'file', $4, 1, $5) ON CONFLICT (path) DO NOTHING`,
      [path, parentOf(path), nameOf(path), size, owner],
    )
    if (rowCount === 0) {
      const { rows } = await client.query<{ kind: string }>(`SELECT kind FROM fs_nodes WHERE path = $1`, [path])
      throw rows[0]?.kind === 'dir'
        ? new FsError('PATH_IS_DIRECTORY', `${path} is a directory`)
        : new FsError('PATH_EXISTS', `${path} already exists`)
    }
  }

  /**
   * Deletes a file inside the caller's transaction, keeping directories and quotas
   * in step. The caller has locked `expectedOwner`; a different owner means a
   * merge moved the file in between, so the transaction starts over.
   */
  private async removeFile(client: pg.PoolClient, path: string, expectedOwner: string | null): Promise<{ size: number }> {
    const dirs = ancestors(path)
    await lockDirs(client, dirs)
    const { rows } = await client.query<{ size: number; owner_id: string | null }>(
      `DELETE FROM fs_nodes WHERE path = $1 AND kind = 'file' RETURNING size, owner_id`,
      [path],
    )
    if (rows.length === 0) throw fileNotFound(path)
    const { size, owner_id: owner } = rows[0]
    if (owner !== expectedOwner) throw new RetryTransaction()
    if (dirs.length > 0) {
      await client.query(
        `UPDATE fs_nodes SET size = size - $2, file_count = file_count - 1, updated_at = now() WHERE path = ANY($1)`,
        [dirs, size],
      )
      await client.query(`DELETE FROM fs_nodes WHERE path = ANY($1) AND kind = 'dir' AND file_count = 0`, [dirs])
    }
    if (owner !== null) await client.query(`UPDATE fs_users SET used = used - $2 WHERE id = $1`, [owner, size])
    return { size }
  }
}

/** Thrown when a lock-then-verify step finds the row changed; withTransaction reruns the transaction. */
class RetryTransaction extends Error {
  readonly code = '40001'
}

/**
 * Reads a file's owner without locking, then locks that user before any
 * namespace row. Callers re-check the owner once the file row is locked.
 */
async function lockOwnerOf(client: pg.PoolClient, path: string): Promise<string | null> {
  const { rows } = await client.query<{ owner_id: string | null }>(
    `SELECT owner_id FROM fs_nodes WHERE path = $1 AND kind = 'file'`,
    [path],
  )
  if (rows.length === 0) throw fileNotFound(path)
  const owner = rows[0].owner_id
  if (owner !== null) {
    const locked = await client.query(`SELECT 1 FROM fs_users WHERE id = $1 FOR UPDATE`, [owner])
    if (locked.rowCount === 0) throw new RetryTransaction() // merged away since the read
  }
  return owner
}

/** Reserves `delta` bytes of the owner's capacity (negative releases). Returns what's left. */
async function charge(client: Client, owner: string, delta: number): Promise<number> {
  const { rows } = await client.query<{ remaining: number }>(
    `UPDATE fs_users SET used = used + $2 WHERE id = $1 AND used + $2 <= capacity RETURNING capacity - used AS remaining`,
    [owner, delta],
  )
  if (rows.length > 0) return rows[0].remaining
  const { rows: user } = await client.query<{ remaining: number }>(`SELECT capacity - used AS remaining FROM fs_users WHERE id = $1`, [owner])
  if (user.length === 0) throw userNotFound(owner)
  throw overCapacity(owner, delta, user[0].remaining)
}

/** Locks existing directories in path order, which is top-down for ancestors. */
async function lockDirs(client: pg.PoolClient, dirs: string[]): Promise<void> {
  if (dirs.length === 0) return
  await client.query(`SELECT 1 FROM fs_nodes WHERE path = ANY($1) ORDER BY path FOR UPDATE`, [dirs])
}

async function lockUser(client: pg.PoolClient, id: string): Promise<void> {
  const { rowCount } = await client.query(`SELECT 1 FROM fs_users WHERE id = $1 FOR UPDATE`, [id])
  if (rowCount === 0) throw userNotFound(id)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function userNotFound(id: string) {
  return new FsError('USER_NOT_FOUND', `User ${id} not found`)
}

function fileNotFound(path: string) {
  return new FsError('FILE_NOT_FOUND', `No file at ${path}`)
}
