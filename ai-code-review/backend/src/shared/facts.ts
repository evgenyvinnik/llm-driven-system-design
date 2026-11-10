/**
 * Turns a host snapshot into the gate's facts. Everything here comes from the
 * host, nothing from the model and nothing from the repository's own config.
 * @module shared/facts
 */
import type { GateFacts, GateFile } from './gate/types.js'
import type { HostFile, PullSnapshot } from './host-types.js'

export function toGateFile(f: HostFile): GateFile {
  return {
    path: f.filename,
    previousPath: f.previous_filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    binary: f.binary,
    mode: f.mode,
  }
}

const COAUTHOR = /^co-authored-by:\s*([^<\n]+?)\s*(?:<[^>]*>)?\s*$/gim

export function commitAuthors(commits: { author: string; message: string }[]): string[] {
  const names = new Set<string>()
  for (const c of commits) {
    names.add(c.author)
    for (const m of c.message.matchAll(COAUTHOR)) names.add(m[1].trim())
  }
  return [...names]
}

export function toGateFacts(s: PullSnapshot, boundSha: string, boundBaseRef: string): GateFacts {
  return {
    boundSha,
    boundBaseRef,
    pr: {
      state: s.pull.state,
      headSha: s.pull.head.sha,
      baseRef: s.pull.base.ref,
      author: s.pull.user.login,
      changedFiles: s.pull.changed_files,
      filesTruncated: s.filesTruncated,
      commitAuthors: commitAuthors(s.commits),
    },
    files: s.files.map(toGateFile),
    checks: s.checks?.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, headSha: c.head_sha })) ?? null,
    reviews: s.reviews?.map((r) => ({ user: r.user.login, state: r.state, commitId: r.commit_id, dismissed: r.dismissed, submittedAt: r.submitted_at })) ?? null,
  }
}
