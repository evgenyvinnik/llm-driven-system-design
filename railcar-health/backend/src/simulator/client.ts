/**
 * HTTP client for the ingest API. Retries network errors and 5xx with backoff;
 * every body is idempotent, so a retry is always safe.
 */
import { config } from '../shared/config.js'

export interface PostResult {
  status: number
  body: unknown
}

export async function post(baseUrl: string, path: string, body: unknown, attempts = 4): Promise<PostResult> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/ingest${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Token': config.ingestToken },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status < 500) return { status: res.status, body: json }
      lastError = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt))
  }
  throw lastError
}
