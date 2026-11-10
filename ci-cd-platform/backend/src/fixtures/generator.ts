/**
 * Builds GitHub-shaped webhook payloads for fixture commits, signs them, and sends
 * them over real HTTP, so the fixture panel and the load script go through the same
 * intake path a Git host would.
 * @module fixtures/generator
 */
import { randomUUID } from 'node:crypto'
import { signBody } from '../intake/signature.js'
import type { FixtureCommit } from './store.js'

export function pushPayload(fullName: string, commit: FixtureCommit, sender: string): Record<string, unknown> {
  return {
    ref: `refs/heads/${commit.branch}`,
    before: commit.parentSha ?? '0'.repeat(40),
    after: commit.sha,
    repository: { full_name: fullName },
    pusher: { name: sender },
    sender: { login: sender },
    head_commit: { id: commit.sha, message: commit.message, author: { name: commit.author } },
  }
}

export function pullRequestPayload(fullName: string, commit: FixtureCommit, sender: string, number: number, base: string, headRepo: string): Record<string, unknown> {
  return {
    action: 'opened',
    number,
    repository: { full_name: fullName },
    sender: { login: sender },
    pull_request: {
      number,
      title: commit.message,
      head: { sha: commit.sha, ref: commit.branch, repo: { full_name: headRepo, fork: headRepo !== fullName } },
      base: { ref: base, repo: { full_name: fullName } },
    },
  }
}

export interface SendResult {
  status: number
  body: Record<string, unknown>
  deliveryId: string
}

export async function sendWebhook(baseUrl: string, fullName: string, secret: string, event: string, payload: unknown, options: { deliveryId?: string; badSignature?: boolean } = {}): Promise<SendResult> {
  const deliveryId = options.deliveryId ?? randomUUID()
  const body = JSON.stringify(payload)
  const signature = options.badSignature ? signBody(`${secret}-wrong`, body) : signBody(secret, body)
  const res = await fetch(`${baseUrl}/api/v1/webhooks/${fullName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': deliveryId, 'X-Hub-Signature-256': signature },
    body,
    signal: AbortSignal.timeout(15_000),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, deliveryId }
}
