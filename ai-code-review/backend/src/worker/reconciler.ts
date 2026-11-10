/**
 * Webhooks are best-effort. The reconciler compares each repository's open pull
 * requests at the host with what we believe, and repairs any difference through
 * syncPullRequest, the same transaction a webhook runs. A lost `synchronize`
 * therefore delays an invalidation by one interval rather than losing it.
 * @module worker/reconciler
 */
import { pool, withTransaction } from '../shared/db.js'
import type { HostReader } from '../shared/host-types.js'
import { logger } from '../shared/logger.js'
import { reconcilerRepairs } from '../shared/metrics.js'
import type { RepoRow } from '../shared/repos.js'
import { syncPullRequest } from '../shared/review-state.js'

export async function reconcileOnce(reader: HostReader): Promise<number> {
  const repos = await pool.query<RepoRow>(`SELECT * FROM repositories`)
  let repairs = 0
  for (const repo of repos.rows) {
    let open
    try {
      open = await reader.listOpenPulls(repo.full_name)
    } catch (err) {
      logger.debug({ repo: repo.full_name, err: (err as Error).message }, 'reconcile skipped')
      continue
    }
    const local = await pool.query<{ number: number; head_sha: string; head_seq: number; base_ref: string; state: string }>(`SELECT number, head_sha, head_seq, base_ref, state FROM pull_requests WHERE repo_id = $1`, [repo.id])
    const byNumber = new Map(local.rows.map((r) => [r.number, r]))
    const hostOpen = new Set<number>()
    for (const pull of open) {
      hostOpen.add(pull.number)
      const known = byNumber.get(pull.number)
      if (known && known.head_sha === pull.head.sha && known.base_ref === pull.base.ref && known.state === 'open') continue
      const outcome = await withTransaction((tx) => syncPullRequest(tx, repo, pull, 'reconciler'))
      if (outcome !== 'unchanged' && outcome !== 'stale') {
        repairs++
        reconcilerRepairs.inc()
        logger.info({ repo: repo.full_name, number: pull.number, outcome }, 'reconciler repaired a pull request')
      }
    }
    for (const row of local.rows) {
      if (row.state !== 'open' || hostOpen.has(row.number)) continue
      const pull = await reader.getPull(repo.full_name, row.number).catch(() => null)
      if (!pull) continue
      const outcome = await withTransaction((tx) => syncPullRequest(tx, repo, pull, 'reconciler'))
      if (outcome === 'closed') repairs++
    }
  }
  return repairs
}
