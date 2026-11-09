/**
 * Picks up what no webhook will: decisions waiting on CI that has since finished
 * (the check_suite event may have arrived while a run was active, or been lost),
 * and waits that ran out, which fail closed. Deadlines use the database clock.
 * @module worker/sweeper
 */
import { config } from '../shared/config.js'
import { pool, withTransaction } from '../shared/db.js'
import type { HostReader } from '../shared/host-types.js'
import { logger } from '../shared/logger.js'
import { loadRepo } from '../shared/repos.js'
import { createRun } from '../shared/review-state.js'
import type { PrRow } from '../shared/rows.js'

export async function sweepWaitingDecisions(reader: HostReader): Promise<void> {
  const waiting = await pool.query<{ pr_id: string; repo_id: string; pr_number: number; head_sha: string; expired: boolean }>(
    `SELECT pr_id, repo_id, pr_number, head_sha, waiting_since < now() - ($1 || ' milliseconds')::interval AS expired
     FROM decisions WHERE state = 'active' AND outcome = 'waiting_ci' LIMIT 100`,
    [String(config.worker.ciWaitMs)],
  )
  for (const d of waiting.rows) {
    const repo = await loadRepo(pool, d.repo_id)
    if (!repo) continue
    let trigger: string | null = d.expired ? 'ci_deadline' : null
    if (!trigger) {
      const snapshot = await reader.getSnapshot(repo.full_name, d.pr_number).catch(() => null)
      const required = repo.required_checks
      const finished = snapshot?.checks && required.every((name) => snapshot.checks?.some((c) => c.name === name && c.status === 'completed' && c.head_sha === d.head_sha))
      if (finished && required.length > 0) trigger = 'ci_poll'
    }
    if (!trigger) continue
    await withTransaction(async (tx) => {
      const locked = await tx.query<PrRow>(`SELECT * FROM pull_requests WHERE id = $1 FOR UPDATE`, [d.pr_id])
      const pr = locked.rows[0]
      if (pr && pr.head_sha === d.head_sha) await createRun(tx, repo, pr, 'gate_only', trigger as string, 'sweeper')
    }).catch((err) => logger.warn({ err: (err as Error).message }, 'sweep failed'))
  }
}
