/**
 * Usage evidence: for accounts with open findings, query the last N days of
 * access logs and record who still uses each insecure path. Accounts without
 * logs get a row too (has_logs = false), so they show as "insufficient
 * evidence" instead of looking unused.
 * @module scanner/evidence
 */
import type { LogRecord } from '../arm/control-plane.js'
import { evidenceWindow, summarizeUsage, trafficPerMinute } from '../domain/evidence.js'
import type { DiagnosticsProperties } from '../domain/types.js'
import { scanDuration } from '../shared/metrics.js'
import { evaluateAndStore } from '../store/findings.js'
import { ownsSubscription, withBackoff, type ScanDeps } from './deps.js'

export async function refreshEvidence(deps: ScanDeps, opts: { limit: number; force?: boolean } = { limit: 300 }): Promise<number> {
  const end = scanDuration.startTimer({ kind: 'evidence' })
  try {
    const { rows } = await deps.db.query<{ id: string; subscription_id: string; diagnostics: DiagnosticsProperties | null }>(
      `SELECT a.id, a.subscription_id, a.diagnostics
         FROM storage_accounts a LEFT JOIN usage_evidence e ON e.account_id = a.id
        WHERE a.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM findings f WHERE f.account_id = a.id AND f.status IN ('open', 'exempt'))
          AND ($1::boolean OR e.account_id IS NULL OR e.stale OR e.computed_at < now() - make_interval(secs => $2))
        ORDER BY e.stale DESC NULLS FIRST, e.computed_at NULLS FIRST
        LIMIT $3`,
      [opts.force ?? false, deps.evidenceTtlMs / 1000, opts.limit],
    )
    const mine = rows.filter((r) => ownsSubscription(r.subscription_id, deps.shard))
    const now = Date.now()
    for (let i = 0; i < mine.length; i += 50) {
      const batch = mine.slice(i, i + 50)
      const withLogs = batch.filter((r) => r.diagnostics?.enabled)
      // Log Analytics is throttled separately from ARM; back off on its own Retry-After.
      const logs = withLogs.length > 0 ? await withBackoff(deps, () => deps.arm.queryLogs(withLogs.map((r) => r.id), deps.lookbackDays), 8) : { status: 200, body: [] }
      if (logs.status !== 200) throw new Error(`Log Analytics query failed with ${logs.status}; will retry next pass`)
      const records = logs.body
      const byAccount = new Map<string, LogRecord[]>()
      for (const rec of records) byAccount.set(rec.resourceId, [...(byAccount.get(rec.resourceId) ?? []), rec])
      const evidenceRows = batch.map((r) => {
        const usage = summarizeUsage(byAccount.get(r.id) ?? [], evidenceWindow(r.diagnostics, deps.lookbackDays, now))
        return { account_id: r.id, lookback_days: deps.lookbackDays, window_days: usage.windowDays, has_logs: usage.hasLogs, counts: usage.counts, callers: usage.callers, traffic: trafficPerMinute(usage) }
      })
      await deps.db.query(
        `INSERT INTO usage_evidence (account_id, computed_at, lookback_days, window_days, has_logs, counts, callers, stale)
         SELECT r.account_id, now(), r.lookback_days, r.window_days, r.has_logs, r.counts, r.callers, false
           FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, lookback_days int, window_days int, has_logs boolean, counts jsonb, callers jsonb)
         ON CONFLICT (account_id) DO UPDATE SET computed_at = now(), lookback_days = EXCLUDED.lookback_days, window_days = EXCLUDED.window_days,
           has_logs = EXCLUDED.has_logs, counts = EXCLUDED.counts, callers = EXCLUDED.callers, stale = false`,
        [JSON.stringify(evidenceRows)],
      )
      await deps.db.query(
        `UPDATE storage_accounts a SET traffic_per_min = r.traffic FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, traffic numeric) WHERE a.id = r.account_id`,
        [JSON.stringify(evidenceRows.map((e) => ({ account_id: e.account_id, traffic: e.traffic })))],
      )
      await evaluateAndStore(deps.db, batch.map((r) => r.id), deps.minEvidenceDays)
    }
    return mine.length
  } finally {
    end()
  }
}
