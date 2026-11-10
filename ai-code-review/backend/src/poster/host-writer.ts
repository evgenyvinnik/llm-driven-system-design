/**
 * The only code that holds a write credential for the host. Nothing outside
 * poster/ imports this module, and a test enforces that.
 * @module poster/host-writer
 */
import { config } from '../shared/config.js'
import { HostUnavailable, type HostWriter, type PostReviewResult } from '../shared/host-types.js'

const TOKEN = process.env.GITHOST_POSTER_TOKEN || 'dev-poster-token'

async function send(path: string, method: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(`${config.gitHostUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...extra },
      body: JSON.stringify(body),
      // Generous, because fixture latency (reviewDelayMs) is the point of some tests.
      signal: AbortSignal.timeout(35_000),
    })
  } catch (err) {
    throw new HostUnavailable(`Host unreachable: ${(err as Error).message}`)
  }
}

export const httpHostWriter: HostWriter = {
  async postReview(fullName, number, args): Promise<PostReviewResult> {
    const res = await send(`/repos/${fullName}/pulls/${number}/reviews`, 'POST', { commit_id: args.commitId, event: args.event, body: args.body }, { 'Idempotency-Key': args.idempotencyKey })
    const data = (await res.json().catch(() => ({}))) as { id?: number; commit_id?: string; state?: string; replayed?: boolean; error?: { code?: string; message?: string; current_head?: string } }
    if (res.ok) return { ok: true, review: { id: data.id as number, commit_id: data.commit_id as string, state: data.state as 'APPROVED', replayed: Boolean(data.replayed) } }
    if (res.status === 409 && data.error?.code === 'STALE_COMMIT') return { ok: false, code: 'STALE_COMMIT', currentHead: data.error.current_head ?? '' }
    if (data.error?.code === 'PR_NOT_OPEN' || data.error?.code === 'SELF_REVIEW') return { ok: false, code: data.error.code, message: data.error.message ?? '' }
    throw new HostUnavailable(`Host returned ${res.status}`, res.status)
  },

  async dismissReview(fullName, number, reviewId, message) {
    const res = await send(`/repos/${fullName}/pulls/${number}/reviews/${reviewId}/dismissals`, 'PUT', { message })
    if (!res.ok && res.status !== 404) throw new HostUnavailable(`Host returned ${res.status}`, res.status)
  },
}
