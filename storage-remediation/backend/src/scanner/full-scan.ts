/**
 * Full inventory pass for this shard's subscriptions: page through Resource
 * Graph, read child resources (soft delete, diagnostic settings) that Resource
 * Graph doesn't carry, mark vanished accounts deleted, then evaluate.
 *
 * Resource Graph lags ARM. The version guard in upsertAccounts keeps a fresher
 * ARM read (from the change feed) when a graph row is older, and an account
 * is only marked deleted if we last saw it well before this scan started.
 * @module scanner/full-scan
 */
import type { BlobServiceProperties, DiagnosticsProperties } from '../domain/types.js'
import { scanDuration } from '../shared/metrics.js'
import { evaluateAndStore } from '../store/findings.js'
import { observationFromGraph, upsertAccounts, upsertChildren, upsertSubscriptions, type ChildObservation } from '../store/inventory.js'
import { mapLimit, ownsSubscription, withBackoff, type ScanDeps } from './deps.js'

export interface FullScanStats {
  subscriptions: number
  graphPages: number
  accountsSeen: number
  staleSkipped: number
  childrenRead: number
  deleted: number
  open: number
  resolved: number
}

export async function refreshChildren(deps: ScanDeps, accountIds: string[]): Promise<number> {
  const blob: ChildObservation[] = []
  const diag: ChildObservation[] = []
  await mapLimit(accountIds, deps.readConcurrency, async (id) => {
    const b = await withBackoff(deps, () => deps.arm.get(id, 'blobService'))
    if (b.status === 200) blob.push({ accountId: id, props: b.body.properties as unknown as BlobServiceProperties, modifiedAt: b.body.systemData?.lastModifiedAt ?? new Date().toISOString() })
    const d = await withBackoff(deps, () => deps.arm.get(id, 'diagnostics'))
    if (d.status === 200) diag.push({ accountId: id, props: d.body.properties as unknown as DiagnosticsProperties, modifiedAt: d.body.systemData?.lastModifiedAt ?? new Date().toISOString() })
  })
  await upsertChildren(deps.db, 'blobService', blob)
  await upsertChildren(deps.db, 'diagnostics', diag)
  return blob.length + diag.length
}

export async function fullScan(deps: ScanDeps): Promise<FullScanStats> {
  const end = scanDuration.startTimer({ kind: 'full' })
  const startedAt = new Date()
  const { rows: run } = await deps.db.query<{ id: number }>(`INSERT INTO scan_runs (shard, kind, status) VALUES ($1, 'full', 'running') RETURNING id`, [deps.shard.index])
  const runId = run[0].id
  const stats: FullScanStats = { subscriptions: 0, graphPages: 0, accountsSeen: 0, staleSkipped: 0, childrenRead: 0, deleted: 0, open: 0, resolved: 0 }
  try {
    const allSubs = await deps.arm.listSubscriptions()
    const subMeta = await upsertSubscriptions(deps.db, allSubs)
    const mine = allSubs.filter((s) => ownsSubscription(s.subscriptionId, deps.shard)).map((s) => s.subscriptionId)
    stats.subscriptions = mine.length
    const seen: string[] = []
    let skipToken: string | undefined
    do {
      const page = await withBackoff(deps, () => deps.arm.queryGraph(mine, skipToken, 500), 10)
      if (page.status !== 200) throw new Error(`Resource Graph query failed with ${page.status}`)
      stats.graphPages++
      const result = await upsertAccounts(deps.db, page.body.data.map(observationFromGraph), subMeta)
      stats.staleSkipped += result.stale
      seen.push(...page.body.data.map((r) => r.id))
      skipToken = page.body.$skipToken
    } while (skipToken)
    stats.accountsSeen = seen.length

    const { rows: needChildren } = await deps.db.query<{ id: string }>(
      `SELECT id FROM storage_accounts WHERE subscription_id = ANY($1) AND deleted_at IS NULL
         AND (children_read_at IS NULL OR children_read_at < now() - make_interval(secs => $2))`,
      [mine, deps.childRefreshMs / 1000],
    )
    stats.childrenRead = await refreshChildren(deps, needChildren.map((r) => r.id))

    const { rowCount } = await deps.db.query(
      `UPDATE storage_accounts SET deleted_at = now()
        WHERE subscription_id = ANY($1) AND deleted_at IS NULL AND NOT (id = ANY($2)) AND observed_at < $3::timestamptz - interval '5 minutes'`,
      [mine, seen, startedAt],
    )
    stats.deleted = rowCount ?? 0

    const { rows: live } = await deps.db.query<{ id: string }>('SELECT id FROM storage_accounts WHERE subscription_id = ANY($1) AND deleted_at IS NULL', [mine])
    const evaluation = await evaluateAndStore(deps.db, live.map((r) => r.id), deps.minEvidenceDays)
    stats.open = evaluation.open
    stats.resolved = evaluation.resolved
    await deps.db.query(`UPDATE scan_runs SET status = 'completed', finished_at = now(), stats = $2 WHERE id = $1`, [runId, JSON.stringify(stats)])
    deps.log.info({ ...stats }, 'full scan completed')
    return stats
  } catch (err) {
    await deps.db.query(`UPDATE scan_runs SET status = 'failed', finished_at = now(), stats = $2 WHERE id = $1`, [runId, JSON.stringify({ ...stats, error: String(err) })])
    throw err
  } finally {
    end()
  }
}
