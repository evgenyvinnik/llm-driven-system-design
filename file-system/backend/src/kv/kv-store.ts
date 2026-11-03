/**
 * Worked answer to levels-db.md: an in-memory key-value store covering all four
 * levels, including both level-4 tracks (history and backup).
 *
 * The data model was picked for level 4 on day one, so later levels add methods
 * rather than rewrites:
 * - `records` maps each key to its fields. A field stores its value and its
 *   expiry time, and is live while the clock is before that time. Expiry is
 *   lazy: nothing sweeps, and every read goes through `liveCell` or `liveFields`.
 * - `history` keeps every version of every field, for the point-in-time reads.
 *   A version's `to` is its expiry when written, pulled earlier by an overwrite
 *   or delete, so expiring needs no event of its own.
 * - `backups` holds snapshots in timestamp order, which is call order.
 *
 * `records` and `history` are only changed inside `write` and `remove`, so the
 * two can't drift apart.
 *
 * Every untimestamped method is its `At` twin at the current time, so each rule
 * is written once.
 * @module kv/kv-store
 */

interface Cell {
  value: string
  /** Absolute time the value expires, or `Infinity` if it never does. */
  expiresAt: number
}

/** A version is readable for `from <= t < to`. */
interface Version {
  value: string
  from: number
  to: number
}

interface BackupEntry {
  key: string
  field: string
  value: string
  /** Lifetime left when the backup was taken, or `null` if the field never expires. */
  remaining: number | null
}

interface Backup {
  at: number
  entries: BackupEntry[]
}

export class KvStore {
  private readonly records = new Map<string, Map<string, Cell>>()
  private readonly history = new Map<string, Map<string, Version[]>>()
  private readonly backups: Backup[] = []
  private now = 0

  // ── Level 1: records ───────────────────────────────────────────────────────

  setField(key: string, field: string, value: string): string | null {
    return this.setFieldAt(this.now, key, field, value)
  }

  getField(key: string, field: string): string | null {
    return this.getFieldAt(this.now, key, field)
  }

  deleteField(key: string, field: string): string | null {
    return this.deleteFieldAt(this.now, key, field)
  }

  deleteRecord(key: string): number | null {
    return this.deleteRecordAt(this.now, key)
  }

  // ── Level 2: scans ─────────────────────────────────────────────────────────

  scanRecord(key: string): string[] {
    return this.scanRecordAt(this.now, key)
  }

  scanPrefix(key: string, prefix: string): string[] {
    return this.scanPrefixAt(this.now, key, prefix)
  }

  topRecords(prefix: string, n: number): string[] {
    return this.topRecordsAt(this.now, prefix, n)
  }

  // ── Level 3: timestamps and expiry ─────────────────────────────────────────

  setFieldAt(t: number, key: string, field: string, value: string, ttl?: number): string | null {
    this.advance(t)
    const previous = this.liveCell(key, field)?.value ?? null
    this.write(key, field, value, ttl === undefined ? Infinity : t + ttl)
    return previous
  }

  getFieldAt(t: number, key: string, field: string): string | null {
    this.advance(t)
    return this.liveCell(key, field)?.value ?? null
  }

  deleteFieldAt(t: number, key: string, field: string): string | null {
    this.advance(t)
    const cell = this.liveCell(key, field)
    if (!cell) return null
    this.remove(key, field)
    return cell.value
  }

  deleteRecordAt(t: number, key: string): number | null {
    this.advance(t)
    const live = this.liveFields(key)
    if (live.length === 0) return null
    // Expired fields go too, so the record doesn't linger. Their versions already ended.
    for (const field of [...this.records.get(key)!.keys()]) this.remove(key, field)
    return live.length
  }

  scanRecordAt(t: number, key: string): string[] {
    return this.scanPrefixAt(t, key, '')
  }

  scanPrefixAt(t: number, key: string, prefix: string): string[] {
    this.advance(t)
    return format(
      this.liveFields(key)
        .filter(([field]) => field.startsWith(prefix))
        .map(([field, cell]) => [field, cell.value]),
    )
  }

  topRecordsAt(t: number, prefix: string, n: number): string[] {
    this.advance(t)
    if (n <= 0) return []
    const counts: Array<[string, number]> = []
    for (const key of this.records.keys()) {
      if (!key.startsWith(prefix)) continue
      const count = this.liveFields(key).length
      if (count > 0) counts.push([key, count])
    }
    return counts
      .sort(([keyA, a], [keyB, b]) => b - a || compare(keyA, keyB))
      .slice(0, n)
      .map(([key, count]) => `${key}(${count})`)
  }

  // ── Level 4, history track ─────────────────────────────────────────────────

  getFieldAsOf(key: string, field: string, asOf: number): string | null {
    return versionAt(this.history.get(key)?.get(field), asOf)?.value ?? null
  }

  scanRecordAsOf(key: string, asOf: number): string[] {
    const fields: Array<[string, string]> = []
    for (const [field, versions] of this.history.get(key) ?? []) {
      const version = versionAt(versions, asOf)
      if (version) fields.push([field, version.value])
    }
    return format(fields)
  }

  // ── Level 4, backup track ──────────────────────────────────────────────────

  backupAt(t: number): number {
    this.advance(t)
    const entries: BackupEntry[] = []
    for (const key of this.records.keys()) {
      for (const [field, { value, expiresAt }] of this.liveFields(key)) {
        entries.push({ key, field, value, remaining: expiresAt === Infinity ? null : expiresAt - t })
      }
    }
    // Timestamps never decrease, so a backup at the same time can only be the last one.
    if (this.backups.at(-1)?.at === t) this.backups.pop()
    this.backups.push({ at: t, entries })
    return entries.length
  }

  restoreAt(t: number, backupTime: number): number | null {
    this.advance(t)
    // Backups are in timestamp order, so the latest one at or before backupTime is the last match.
    const backup = this.backups.filter((b) => b.at <= backupTime).at(-1)
    if (!backup) return null
    for (const [key, fields] of [...this.records]) {
      for (const field of [...fields.keys()]) this.remove(key, field)
    }
    // A saved lifetime restarts from the restore: time in the backup doesn't count.
    for (const { key, field, value, remaining } of backup.entries) {
      this.write(key, field, value, remaining === null ? Infinity : t + remaining)
    }
    return backup.entries.length
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Timestamps never decrease (the spec guarantees it), so this only records the latest. */
  private advance(t: number): void {
    this.now = t
  }

  private liveCell(key: string, field: string): Cell | undefined {
    const cell = this.records.get(key)?.get(field)
    return cell && this.now < cell.expiresAt ? cell : undefined
  }

  private liveFields(key: string): Array<[string, Cell]> {
    return [...(this.records.get(key) ?? [])].filter(([, cell]) => this.now < cell.expiresAt)
  }

  private write(key: string, field: string, value: string, expiresAt: number): void {
    let fields = this.records.get(key)
    if (!fields) this.records.set(key, (fields = new Map()))
    fields.set(field, { value, expiresAt })

    let byField = this.history.get(key)
    if (!byField) this.history.set(key, (byField = new Map()))
    const versions = byField.get(field) ?? []
    endVersion(versions, this.now)
    versions.push({ value, from: this.now, to: expiresAt })
    byField.set(field, versions)
  }

  private remove(key: string, field: string): void {
    const fields = this.records.get(key)!
    fields.delete(field)
    if (fields.size === 0) this.records.delete(key)
    endVersion(this.history.get(key)!.get(field)!, this.now)
  }
}

/** Ends the latest version at `at`, unless it already ended (expired) sooner. */
function endVersion(versions: Version[], at: number): void {
  const last = versions.at(-1)
  if (last) last.to = Math.min(last.to, at)
}

function versionAt(versions: Version[] | undefined, t: number): Version | undefined {
  return versions?.find((v) => v.from <= t && t < v.to)
}

/** `[field, value]` pairs → `"field=value"`, sorted by field name. */
function format(fields: Array<[string, string]>): string[] {
  return fields.sort(([a], [b]) => compare(a, b)).map(([field, value]) => `${field}=${value}`)
}

/** Plain code-unit order, the same as the default `Array.prototype.sort`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
