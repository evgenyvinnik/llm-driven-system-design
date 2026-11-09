/**
 * The fixture Git host: commits are rows, a SHA is a hash of the commit's content.
 * Nothing here can add file content that isn't in the catalog.
 * @module fixtures/store
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Queryable } from '../shared/db.js'
import type { Scenario } from './catalog.js'

export interface FixtureCommit {
  sha: string
  parentSha: string | null
  branch: string
  message: string
  author: string
  tree: Record<string, string>
  sourceRepo: string | null
}

export function commitSha(parent: string | null, tree: Record<string, string>, message: string, nonce: string): string {
  return createHash('sha1').update(JSON.stringify({ parent, tree, message, nonce })).digest('hex')
}

export async function headOf(db: Queryable, repoId: string, branch: string): Promise<string | null> {
  const { rows } = await db.query<{ sha: string }>('SELECT sha FROM fixture_commits WHERE repo_id = $1 AND branch = $2 ORDER BY created_at DESC LIMIT 1', [repoId, branch])
  return rows[0]?.sha ?? null
}

/** A new commit from a scenario. A fork's head is stored with its source repository, like refs/pull/N/head. */
export async function createCommit(db: Queryable, repoId: string, scenario: Scenario, opts: { branch: string; author: string; sourceRepo?: string | null }): Promise<FixtureCommit> {
  const parent = await headOf(db, repoId, opts.branch)
  const nonce = randomBytes(8).toString('hex')
  const sha = commitSha(parent, scenario.files, scenario.message, nonce)
  await db.query(`INSERT INTO fixture_commits (repo_id, sha, parent_sha, branch, message, author, scenario, source_repo, tree) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    repoId,
    sha,
    parent,
    opts.branch,
    scenario.message,
    opts.author,
    scenario.name,
    opts.sourceRepo ?? null,
    JSON.stringify(scenario.files),
  ])
  return { sha, parentSha: parent, branch: opts.branch, message: scenario.message, author: opts.author, tree: scenario.files, sourceRepo: opts.sourceRepo ?? null }
}

export async function getCommit(db: Queryable, repoId: string, sha: string): Promise<FixtureCommit | null> {
  const { rows } = await db.query<{ sha: string; parent_sha: string | null; branch: string; message: string; author: string; tree: Record<string, string>; source_repo: string | null }>(
    'SELECT sha, parent_sha, branch, message, author, tree, source_repo FROM fixture_commits WHERE repo_id = $1 AND sha = $2',
    [repoId, sha],
  )
  const r = rows[0]
  return r ? { sha: r.sha, parentSha: r.parent_sha, branch: r.branch, message: r.message, author: r.author, tree: r.tree, sourceRepo: r.source_repo } : null
}
