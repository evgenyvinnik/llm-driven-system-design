/**
 * State of the fixture Git host. It behaves like a small GitHub: pull requests
 * with a moving head SHA, cumulative diffs, checks per SHA, reviews that carry
 * a commit id, protected branches and a webhook outbox written in the same
 * transaction as each change.
 *
 * postReview is the compare-and-swap that closes the check-to-act race: a
 * review locks the pull request row, the same lock a push takes, and is
 * refused when its commit id is not the current head.
 * @module githost/store
 */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool, withTransaction } from '../shared/db.js'
import type { HostCheck, HostComment, HostCommit, HostFile, HostPull, HostReview } from '../shared/host-types.js'
import { newId } from '../shared/ids.js'

/** The list endpoint caps out here, as real hosts do; the PR's changed_files still tells the truth. */
export const MAX_FILES_LISTED = 300
export const CHECK_NAMES = ['ci/build', 'ci/test']

export class HostError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export interface FileChange {
  path: string
  previousPath?: string | null
  status?: HostFile['status']
  /** Lines added to and removed from the file; a patch is built from them. */
  add?: string[]
  remove?: string[]
  /** Exact contents after this change, when it matters to a test. */
  content?: string
  /** Overrides the computed counts, for huge diffs that don't carry a patch. */
  additions?: number
  deletions?: number
  binary?: boolean
  mode?: string
}

export type CiSetting = 'success' | 'failure' | 'pending' | 'none'

export interface PullSpec {
  title: string
  body?: string
  author: string
  headRef?: string
  baseRef?: string
  message?: string
  commitAuthor?: string
  files: FileChange[]
  ci?: CiSetting
  comments?: { user: string; body: string }[]
}

interface RepoRow {
  id: number
  owner: string
  name: string
  default_branch: string
  tree: Record<string, string>
  required_approvals: number
  dismiss_stale_reviews: boolean
  required_checks: string[]
}

interface PullRow {
  id: number
  repo_id: number
  number: number
  title: string
  body: string
  author: string
  base_ref: string
  head_ref: string
  head_sha: string
  head_seq: number
  state: 'open' | 'closed' | 'merged'
  created_at: Date
  updated_at: Date
}

function buildPatch(change: FileChange): string | null {
  if (change.binary) return null
  const add = change.add ?? []
  const remove = change.remove ?? []
  if (add.length === 0 && remove.length === 0) return ''
  return [`@@ -1,${remove.length} +1,${add.length} @@`, ...remove.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join('\n')
}

export function toHostFile(change: FileChange): HostFile {
  const status = change.status ?? (change.previousPath ? 'renamed' : (change.remove?.length ?? 0) > 0 ? 'modified' : 'added')
  return {
    filename: change.path,
    previous_filename: change.previousPath ?? null,
    status,
    additions: change.additions ?? change.add?.length ?? 0,
    deletions: change.deletions ?? change.remove?.length ?? 0,
    patch: buildPatch(change),
    binary: change.binary ?? false,
    mode: change.mode ?? '100644',
  }
}

function applyToTree(tree: Record<string, string>, changes: FileChange[]): Record<string, string> {
  const next = { ...tree }
  for (const c of changes) {
    if (c.previousPath) {
      const moved = next[c.previousPath]
      delete next[c.previousPath]
      if (moved !== undefined && next[c.path] === undefined) next[c.path] = moved
    }
    const status = c.status ?? (c.previousPath ? 'renamed' : 'modified')
    if (status === 'removed') {
      delete next[c.path]
      continue
    }
    if (c.content !== undefined) next[c.path] = c.content
    else if (c.binary) next[c.path] = '<binary>'
    else {
      const removed = new Set(c.remove ?? [])
      const lines = (next[c.path] ?? '').split('\n').filter((l) => !removed.has(l))
      next[c.path] = [...lines.filter((l, i) => !(i === lines.length - 1 && l === '')), ...(c.add ?? [])].join('\n')
    }
  }
  return next
}

function mergeFiles(previous: HostFile[], incoming: HostFile[]): HostFile[] {
  const byPath = new Map(previous.map((f) => [f.filename, f]))
  for (const f of incoming) byPath.set(f.filename, f)
  return [...byPath.values()].sort((a, b) => a.filename.localeCompare(b.filename))
}

function shaOf(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex')
}

function pullDto(p: PullRow, files: HostFile[]): HostPull {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    user: { login: p.author },
    state: p.state,
    head: { sha: p.head_sha, ref: p.head_ref },
    base: { ref: p.base_ref },
    head_seq: p.head_seq,
    changed_files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    created_at: p.created_at.toISOString(),
    updated_at: p.updated_at.toISOString(),
  }
}

function pullEventPayload(repo: RepoRow, p: PullRow, files: HostFile[], action: string, sender: string, extra: Record<string, unknown> = {}) {
  return { action, number: p.number, sender: { login: sender }, repository: { full_name: `${repo.owner}/${repo.name}` }, pull_request: pullDto(p, files), ...extra }
}

async function enqueueDelivery(tx: PoolClient, event: string, action: string, payload: unknown): Promise<void> {
  await tx.query(`INSERT INTO githost.deliveries (id, event, action, payload) VALUES ($1,$2,$3,$4)`, [newId('dlv'), event, action, JSON.stringify(payload)])
}

async function repoOf(db: PoolClient | typeof pool, owner: string, name: string): Promise<RepoRow> {
  const res = await db.query<RepoRow>(`SELECT * FROM githost.repos WHERE owner = $1 AND name = $2`, [owner, name])
  if (!res.rows[0]) throw new HostError(404, 'REPO_NOT_FOUND', `No repository ${owner}/${name}`)
  return res.rows[0]
}

async function pullOf(db: PoolClient | typeof pool, repoId: number, number: number, lock = false): Promise<PullRow> {
  const res = await db.query<PullRow>(`SELECT * FROM githost.pull_requests WHERE repo_id = $1 AND number = $2${lock ? ' FOR UPDATE' : ''}`, [repoId, number])
  if (!res.rows[0]) throw new HostError(404, 'PR_NOT_FOUND', `No pull request #${number}`)
  return res.rows[0]
}

async function commitFiles(db: PoolClient | typeof pool, repoId: number, sha: string): Promise<HostFile[]> {
  const res = await db.query<{ files: HostFile[] }>(`SELECT files FROM githost.commits WHERE repo_id = $1 AND sha = $2`, [repoId, sha])
  return res.rows[0]?.files ?? []
}

async function writeChecks(tx: PoolClient, repo: RepoRow, p: PullRow, ci: CiSetting): Promise<void> {
  if (ci === 'none') return
  for (const name of repo.required_checks.length > 0 ? repo.required_checks : CHECK_NAMES) {
    const status = ci === 'pending' ? 'in_progress' : 'completed'
    const conclusion = ci === 'pending' ? null : ci
    await tx.query(
      `INSERT INTO githost.checks (repo_id, head_sha, name, status, conclusion) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (repo_id, head_sha, name) DO UPDATE SET status = EXCLUDED.status, conclusion = EXCLUDED.conclusion, updated_at = now()`,
      [repo.id, p.head_sha, name, status, conclusion],
    )
  }
  if (ci !== 'pending') {
    await enqueueDelivery(tx, 'check_suite', 'completed', {
      action: 'completed',
      repository: { full_name: `${repo.owner}/${repo.name}` },
      check_suite: { head_sha: p.head_sha, conclusion: ci, pull_requests: [{ number: p.number }] },
    })
  }
}

export async function ensureRepo(owner: string, name: string, tree: Record<string, string>): Promise<void> {
  await pool.query(`INSERT INTO githost.repos (owner, name, tree) VALUES ($1,$2,$3) ON CONFLICT (owner, name) DO NOTHING`, [owner, name, JSON.stringify(tree)])
}

export async function openPull(owner: string, name: string, spec: PullSpec): Promise<{ number: number; headSha: string }> {
  return withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    await tx.query(`SELECT pg_advisory_xact_lock($1)`, [repo.id])
    const next = await tx.query<{ n: number }>(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM githost.pull_requests WHERE repo_id = $1`, [repo.id])
    const number = next.rows[0].n
    const files = mergeFiles(
      [],
      spec.files.map((f) => toHostFile(f)),
    )
    const tree = applyToTree(repo.tree, spec.files)
    const message = spec.message ?? spec.title
    const author = spec.commitAuthor ?? spec.author
    const sha = shaOf([owner, name, number, 1, null, files, message, author])
    const res = await tx.query<PullRow>(
      `INSERT INTO githost.pull_requests (repo_id, number, title, body, author, base_ref, head_ref, head_sha, head_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) RETURNING *`,
      [repo.id, number, spec.title, spec.body ?? '', spec.author, spec.baseRef ?? repo.default_branch, spec.headRef ?? `feature/pr-${number}`, sha],
    )
    const pr = res.rows[0]
    await tx.query(`INSERT INTO githost.commits (repo_id, sha, pr_id, seq, parent_sha, author, message, files, tree) VALUES ($1,$2,$3,1,NULL,$4,$5,$6,$7)`, [
      repo.id,
      sha,
      pr.id,
      author,
      message,
      JSON.stringify(files),
      JSON.stringify(tree),
    ])
    for (const c of spec.comments ?? []) {
      await tx.query(`INSERT INTO githost.comments (pr_id, user_login, body) VALUES ($1,$2,$3)`, [pr.id, c.user, c.body])
    }
    await enqueueDelivery(tx, 'pull_request', 'opened', pullEventPayload(repo, pr, files, 'opened', spec.author))
    await writeChecks(tx, repo, pr, spec.ci ?? 'success')
    return { number, headSha: sha }
  })
}

export async function pushCommit(owner: string, name: string, number: number, args: { author?: string; message?: string; files: FileChange[]; ci?: CiSetting }): Promise<{ headSha: string; headSeq: number }> {
  return withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    if (pr.state !== 'open') throw new HostError(422, 'PR_NOT_OPEN', `Pull request #${number} is ${pr.state}`)
    const prev = await tx.query<{ files: HostFile[]; tree: Record<string, string> }>(`SELECT files, tree FROM githost.commits WHERE repo_id = $1 AND sha = $2`, [repo.id, pr.head_sha])
    const files = mergeFiles(
      prev.rows[0].files,
      args.files.map((f) => toHostFile(f)),
    )
    const tree = applyToTree(prev.rows[0].tree, args.files)
    const seq = pr.head_seq + 1
    const author = args.author ?? pr.author
    const message = args.message ?? `Update ${pr.head_ref}`
    const sha = shaOf([owner, name, number, seq, pr.head_sha, files, message, author])
    await tx.query(`INSERT INTO githost.commits (repo_id, sha, pr_id, seq, parent_sha, author, message, files, tree) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      repo.id,
      sha,
      pr.id,
      seq,
      pr.head_sha,
      author,
      message,
      JSON.stringify(files),
      JSON.stringify(tree),
    ])
    const updated = await tx.query<PullRow>(`UPDATE githost.pull_requests SET head_sha = $2, head_seq = $3, updated_at = now() WHERE id = $1 RETURNING *`, [pr.id, sha, seq])
    if (repo.dismiss_stale_reviews) {
      await tx.query(`UPDATE githost.reviews SET dismissed = TRUE, dismissed_at = now(), dismissal_message = 'stale' WHERE pr_id = $1 AND NOT dismissed`, [pr.id])
    }
    await enqueueDelivery(tx, 'pull_request', 'synchronize', pullEventPayload(repo, updated.rows[0], files, 'synchronize', author))
    await writeChecks(tx, repo, updated.rows[0], args.ci ?? 'success')
    return { headSha: sha, headSeq: seq }
  })
}

export async function setChecks(owner: string, name: string, number: number, ci: CiSetting): Promise<{ headSha: string }> {
  return withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    await writeChecks(tx, repo, pr, ci)
    return { headSha: pr.head_sha }
  })
}

export async function retargetBase(owner: string, name: string, number: number, baseRef: string): Promise<void> {
  await withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    const res = await tx.query<PullRow>(`UPDATE githost.pull_requests SET base_ref = $2, updated_at = now() WHERE id = $1 RETURNING *`, [pr.id, baseRef])
    const files = await commitFiles(tx, repo.id, pr.head_sha)
    await enqueueDelivery(tx, 'pull_request', 'edited', pullEventPayload(repo, res.rows[0], files, 'edited', pr.author, { changes: { base: { ref: { from: pr.base_ref } } } }))
  })
}

export async function closePull(owner: string, name: string, number: number): Promise<void> {
  await withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    const res = await tx.query<PullRow>(`UPDATE githost.pull_requests SET state = 'closed', updated_at = now() WHERE id = $1 RETURNING *`, [pr.id])
    const files = await commitFiles(tx, repo.id, pr.head_sha)
    await enqueueDelivery(tx, 'pull_request', 'closed', pullEventPayload(repo, res.rows[0], files, 'closed', pr.author))
  })
}

export async function addComment(owner: string, name: string, number: number, user: string, body: string): Promise<{ id: number }> {
  return withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number)
    const res = await tx.query<{ id: number }>(`INSERT INTO githost.comments (pr_id, user_login, body) VALUES ($1,$2,$3) RETURNING id`, [pr.id, user, body])
    return res.rows[0]
  })
}

const EVENT_STATE = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' } as const

export async function postReview(
  owner: string,
  name: string,
  number: number,
  args: { user: string; event: keyof typeof EVENT_STATE; commitId?: string; body?: string; idempotencyKey?: string },
): Promise<{ id: number; commit_id: string; state: string; replayed: boolean }> {
  return withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    // The same row lock a push takes, so a review and a push are strictly ordered.
    const pr = await pullOf(tx, repo.id, number, true)
    if (args.idempotencyKey) {
      const existing = await tx.query<{ id: number; commit_id: string; state: string }>(`SELECT id, commit_id, state FROM githost.reviews WHERE idempotency_key = $1`, [args.idempotencyKey])
      if (existing.rows[0]) return { ...existing.rows[0], replayed: true }
    }
    if (pr.state !== 'open') throw new HostError(422, 'PR_NOT_OPEN', `Pull request #${number} is ${pr.state}`)
    if (!args.commitId) throw new HostError(422, 'COMMIT_ID_REQUIRED', 'A review must name the commit it applies to')
    if (args.commitId !== pr.head_sha) {
      throw new HostError(409, 'STALE_COMMIT', `Review is for ${args.commitId.slice(0, 7)}, but the head is ${pr.head_sha.slice(0, 7)}`, { current_head: pr.head_sha })
    }
    if (args.event !== 'COMMENT' && args.user === pr.author) throw new HostError(422, 'SELF_REVIEW', 'Authors cannot review their own pull request')
    const state = EVENT_STATE[args.event]
    const res = await tx.query<{ id: number }>(`INSERT INTO githost.reviews (pr_id, user_login, state, commit_id, body, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
      pr.id,
      args.user,
      state,
      args.commitId,
      args.body ?? '',
      args.idempotencyKey ?? null,
    ])
    const files = await commitFiles(tx, repo.id, pr.head_sha)
    await enqueueDelivery(
      tx,
      'pull_request_review',
      'submitted',
      pullEventPayload(repo, pr, files, 'submitted', args.user, { review: { id: res.rows[0].id, user: { login: args.user }, state, commit_id: args.commitId } }),
    )
    return { id: res.rows[0].id, commit_id: args.commitId, state, replayed: false }
  })
}

export async function dismissReview(owner: string, name: string, number: number, reviewId: number, user: string, message: string): Promise<void> {
  await withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    const res = await tx.query<{ state: string; commit_id: string; user_login: string }>(
      `UPDATE githost.reviews SET dismissed = TRUE, dismissed_at = now(), dismissal_message = $3 WHERE id = $1 AND pr_id = $2 AND NOT dismissed RETURNING state, commit_id, user_login`,
      [reviewId, pr.id, message],
    )
    if (!res.rows[0]) return
    const files = await commitFiles(tx, repo.id, pr.head_sha)
    await enqueueDelivery(
      tx,
      'pull_request_review',
      'dismissed',
      pullEventPayload(repo, pr, files, 'dismissed', user, { review: { id: reviewId, user: { login: res.rows[0].user_login }, state: res.rows[0].state, commit_id: res.rows[0].commit_id } }),
    )
  })
}

/** Merge rules follow GitHub's default: a non-dismissed approval counts even after a push, unless dismiss_stale_reviews is on. */
export async function mergeBlockers(owner: string, name: string, number: number): Promise<string[]> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  const blockers: string[] = []
  if (pr.state !== 'open') blockers.push(`Pull request is ${pr.state}`)
  const reviews = await pool.query<{ state: string; commit_id: string; user_login: string }>(`SELECT state, commit_id, user_login FROM githost.reviews WHERE pr_id = $1 AND NOT dismissed AND state = 'APPROVED'`, [pr.id])
  const approvals = reviews.rows.filter((r) => !repo.dismiss_stale_reviews || r.commit_id === pr.head_sha).length
  if (approvals < repo.required_approvals) blockers.push(`${approvals} approval(s), ${repo.required_approvals} required`)
  const checks = await pool.query<{ name: string; conclusion: string | null }>(`SELECT name, conclusion FROM githost.checks WHERE repo_id = $1 AND head_sha = $2`, [repo.id, pr.head_sha])
  for (const required of repo.required_checks) {
    const c = checks.rows.find((x) => x.name === required)
    if (!c || c.conclusion !== 'success') blockers.push(`Required check ${required} has not passed at this head`)
  }
  return blockers
}

export async function mergePull(owner: string, name: string, number: number): Promise<void> {
  const blockers = await mergeBlockers(owner, name, number)
  if (blockers.length > 0) throw new HostError(405, 'NOT_MERGEABLE', blockers.join('; '), { blockers })
  await withTransaction(async (tx) => {
    const repo = await repoOf(tx, owner, name)
    const pr = await pullOf(tx, repo.id, number, true)
    const res = await tx.query<PullRow>(`UPDATE githost.pull_requests SET state = 'merged', merged_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [pr.id])
    const files = await commitFiles(tx, repo.id, pr.head_sha)
    await enqueueDelivery(tx, 'pull_request', 'closed', pullEventPayload(repo, res.rows[0], files, 'closed', pr.author))
  })
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getPull(owner: string, name: string, number: number): Promise<HostPull> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  return pullDto(pr, await commitFiles(pool, repo.id, pr.head_sha))
}

export async function listPulls(owner: string, name: string, state: string | undefined): Promise<HostPull[]> {
  const repo = await repoOf(pool, owner, name)
  const res = await pool.query<PullRow>(`SELECT * FROM githost.pull_requests WHERE repo_id = $1 ${state ? 'AND state = $2' : ''} ORDER BY number`, state ? [repo.id, state] : [repo.id])
  const out: HostPull[] = []
  for (const pr of res.rows) out.push(pullDto(pr, await commitFiles(pool, repo.id, pr.head_sha)))
  return out
}

export async function listFiles(owner: string, name: string, number: number, ref?: string): Promise<{ files: HostFile[]; truncated: boolean; total: number }> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  const files = await commitFiles(pool, repo.id, ref ?? pr.head_sha)
  return { files: files.slice(0, MAX_FILES_LISTED), truncated: files.length > MAX_FILES_LISTED, total: files.length }
}

export async function listCommits(owner: string, name: string, number: number): Promise<HostCommit[]> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  const res = await pool.query<HostCommit>(`SELECT sha, author, message, seq FROM githost.commits WHERE repo_id = $1 AND pr_id = $2 ORDER BY seq`, [repo.id, pr.id])
  return res.rows
}

export async function listComments(owner: string, name: string, number: number): Promise<HostComment[]> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  const res = await pool.query<{ id: number; user_login: string; body: string; created_at: Date }>(`SELECT id, user_login, body, created_at FROM githost.comments WHERE pr_id = $1 ORDER BY id`, [pr.id])
  return res.rows.map((r) => ({ id: r.id, user: { login: r.user_login }, body: r.body, created_at: r.created_at.toISOString() }))
}

export async function listReviews(owner: string, name: string, number: number): Promise<HostReview[]> {
  const repo = await repoOf(pool, owner, name)
  const pr = await pullOf(pool, repo.id, number)
  const res = await pool.query<{ id: number; user_login: string; state: HostReview['state']; commit_id: string; body: string; dismissed: boolean; submitted_at: Date }>(
    `SELECT id, user_login, state, commit_id, body, dismissed, submitted_at FROM githost.reviews WHERE pr_id = $1 ORDER BY id`,
    [pr.id],
  )
  return res.rows.map((r) => ({ id: r.id, user: { login: r.user_login }, state: r.state, commit_id: r.commit_id, body: r.body, dismissed: r.dismissed, submitted_at: r.submitted_at.toISOString() }))
}

export async function listChecks(owner: string, name: string, sha: string): Promise<HostCheck[]> {
  const repo = await repoOf(pool, owner, name)
  const res = await pool.query<{ name: string; status: HostCheck['status']; conclusion: HostCheck['conclusion']; head_sha: string }>(`SELECT name, status, conclusion, head_sha FROM githost.checks WHERE repo_id = $1 AND head_sha = $2 ORDER BY name`, [repo.id, sha])
  return res.rows
}

/** `ref` is required: no read can mean "whatever is latest". */
export async function readContent(owner: string, name: string, path: string, ref: string): Promise<string | null> {
  const repo = await repoOf(pool, owner, name)
  const res = await pool.query<{ tree: Record<string, string> }>(`SELECT tree FROM githost.commits WHERE repo_id = $1 AND sha = $2`, [repo.id, ref])
  if (!res.rows[0]) return null
  return res.rows[0].tree[path] ?? null
}
