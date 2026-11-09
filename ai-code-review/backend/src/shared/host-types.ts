/**
 * The Git host's wire format (snake_case, modelled on GitHub's REST API) and the
 * read-side interface the review system uses. Workers and the API get a
 * HostReader; only the poster ever holds a HostWriter.
 * @module shared/host-types
 */

export interface HostPull {
  number: number
  title: string
  body: string
  user: { login: string }
  state: 'open' | 'closed' | 'merged'
  head: { sha: string; ref: string }
  base: { ref: string }
  /** Increases with every push: an out-of-order delivery can be recognized. */
  head_seq: number
  changed_files: number
  additions: number
  deletions: number
  created_at: string
  updated_at: string
}

export interface HostFile {
  filename: string
  previous_filename: string | null
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  patch: string | null
  binary: boolean
  mode: string
}

export interface HostCommit {
  sha: string
  author: string
  message: string
  seq: number
}

export interface HostComment {
  id: number
  user: { login: string }
  body: string
  created_at: string
}

export interface HostReview {
  id: number
  user: { login: string }
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  commit_id: string
  body: string
  dismissed: boolean
  submitted_at: string
}

export interface HostCheck {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | null
  head_sha: string
}

/** Everything the system knows about a pull request at one moment. */
export interface PullSnapshot {
  pull: HostPull
  files: HostFile[]
  filesTruncated: boolean
  commits: HostCommit[]
  comments: HostComment[]
  /** null: these reads failed, which the gate treats as unknown rather than as a pass. */
  reviews: HostReview[] | null
  checks: HostCheck[] | null
}

export interface HostReader {
  getSnapshot(fullName: string, number: number): Promise<PullSnapshot>
  getPull(fullName: string, number: number): Promise<HostPull>
  listOpenPulls(fullName: string): Promise<HostPull[]>
  /** Always at a pinned SHA. There is no way to read "the latest". */
  readFile(fullName: string, path: string, sha: string): Promise<string | null>
  listReviews(fullName: string, number: number): Promise<HostReview[]>
  mergeBlockers(fullName: string, number: number): Promise<string[]>
}

export interface PostedReview {
  id: number
  commit_id: string
  state: HostReview['state']
  replayed: boolean
}

export type PostReviewResult = { ok: true; review: PostedReview } | { ok: false; code: 'STALE_COMMIT'; currentHead: string } | { ok: false; code: 'PR_NOT_OPEN' | 'SELF_REVIEW'; message: string }

export interface HostWriter {
  postReview(fullName: string, number: number, args: { commitId: string; event: 'APPROVE' | 'COMMENT'; body: string; idempotencyKey: string }): Promise<PostReviewResult>
  dismissReview(fullName: string, number: number, reviewId: number, message: string): Promise<void>
}

export class HostUnavailable extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message)
  }
}
