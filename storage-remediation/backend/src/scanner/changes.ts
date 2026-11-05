/**
 * Incremental inventory from the resource change feed. Each event is a hint,
 * not data: we re-read the resource from ARM (consistent, unlike Resource
 * Graph) and store whatever is current. Processing is at-least-once; the
 * cursor advances only past events that were fully handled, and replaying an
 * event is harmless because the write is a guarded upsert of current state.
 * @module scanner/changes
 */
import type { BlobServiceProperties, DiagnosticsProperties } from '../domain/types.js'
import { changeEventsProcessed } from '../shared/metrics.js'
import { evaluateAndStore } from '../store/findings.js'
import { loadSubscriptionMeta, observationFromArm, upsertAccounts, upsertChildren } from '../store/inventory.js'
import { ownsSubscription, type ScanDeps } from './deps.js'

export interface ChangeResult {
  processed: number
  cursor: number
  /** The feed no longer covers our cursor: the caller must run a full scan. */
  resyncFrom?: number
}

export async function readCursor(deps: ScanDeps): Promise<number> {
  const { rows } = await deps.db.query<{ change_seq: number }>('SELECT change_seq FROM scanner_cursors WHERE shard = $1', [deps.shard.index])
  return rows[0]?.change_seq ?? 0
}

export async function saveCursor(deps: ScanDeps, seq: number, lastEventAt: string | null): Promise<void> {
  await deps.db.query(
    `INSERT INTO scanner_cursors (shard, change_seq, last_event_at, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (shard) DO UPDATE SET change_seq = EXCLUDED.change_seq, last_event_at = COALESCE(EXCLUDED.last_event_at, scanner_cursors.last_event_at), updated_at = now()`,
    [deps.shard.index, seq, lastEventAt],
  )
}

export async function processChanges(deps: ScanDeps, limit = 500): Promise<ChangeResult> {
  const cursor = await readCursor(deps)
  const page = await deps.arm.changes(cursor, limit)
  if (page.status === 410) {
    const latest = (page.body as unknown as { latest?: number }).latest ?? 0
    return { processed: 0, cursor, resyncFrom: latest }
  }
  if (page.status !== 200) throw new Error(`change feed read failed: ${page.status}`)
  const events = page.body.events
  if (events.length === 0) {
    await saveCursor(deps, cursor, null)
    return { processed: 0, cursor }
  }
  const subs = await loadSubscriptionMeta(deps.db)
  const handled = new Set<string>()
  const touched = new Set<string>()
  let advancedTo = cursor
  let lastAt: string | null = null
  for (const e of events) {
    const key = `${e.resourceId}|${e.kind}`
    if (!ownsSubscription(e.subscriptionId, deps.shard) || handled.has(key)) {
      changeEventsProcessed.inc({ outcome: handled.has(key) ? 'coalesced' : 'other_shard' })
      advancedTo = e.seq
      continue
    }
    const r = await deps.arm.get(e.resourceId, e.kind)
    if (r.status === 429 || r.status === 503) {
      // Stop here; the cursor stays before this event and we retry after the back-off.
      changeEventsProcessed.inc({ outcome: 'throttled' })
      await deps.sleep(r.retryAfterMs ?? 1000)
      break
    }
    if (r.status === 404) {
      await deps.db.query('UPDATE storage_accounts SET deleted_at = now() WHERE id = $1', [e.resourceId])
    } else if (r.status === 200) {
      if (e.kind === 'account') {
        if (!subs.has(e.subscriptionId)) subs.set(e.subscriptionId, { environment: r.body.tags?.env ?? 'unknown', ownerTeam: r.body.tags?.owner ?? null })
        await upsertAccounts(deps.db, [observationFromArm(r.body, 'event')], subs)
      } else {
        const modifiedAt = r.body.systemData?.lastModifiedAt ?? new Date().toISOString()
        await upsertChildren(deps.db, e.kind, [{ accountId: e.resourceId, props: r.body.properties as unknown as BlobServiceProperties | DiagnosticsProperties, modifiedAt }])
      }
      // A new account needs its child resources read once.
      if (e.changeType === 'Create') {
        for (const kind of ['blobService', 'diagnostics'] as const) {
          const child = await deps.arm.get(e.resourceId, kind)
          if (child.status === 200) await upsertChildren(deps.db, kind, [{ accountId: e.resourceId, props: child.body.properties as unknown as BlobServiceProperties, modifiedAt: child.body.systemData?.lastModifiedAt ?? new Date().toISOString() }])
        }
      }
    }
    changeEventsProcessed.inc({ outcome: 'applied' })
    handled.add(key)
    touched.add(e.resourceId)
    advancedTo = e.seq
    lastAt = e.at
  }
  if (touched.size > 0) await evaluateAndStore(deps.db, [...touched], deps.minEvidenceDays)
  await saveCursor(deps, advancedTo, lastAt)
  return { processed: touched.size, cursor: advancedTo }
}
