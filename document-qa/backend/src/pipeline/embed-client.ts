/**
 * Embedder client used by the embed stage.
 *
 * 429 and 503 are retried inside the attempt: Retry-After is honoured when
 * present (capped), otherwise exponential backoff with jitter. These are
 * "slow down", not "broken", so they shouldn't burn a job attempt. A 500 or a
 * network error fails the attempt, and the job-level retry (with its own
 * backoff and attempt cap) takes over.
 * @module pipeline/embed-client
 */
import { config } from '../shared/config.js'
import { embedCalls } from '../shared/metrics.js'
import { backoffMs } from './jobs.js'

export class EmbedError extends Error {
  constructor(
    message: string,
    public status: number | null,
  ) {
    super(message)
  }
}

export interface EmbedResult {
  vectors: number[][]
  model: string
  rateLimitedRetries: number
}

export interface EmbedClientOptions {
  url?: string
  retries?: number
  sleep?: (ms: number) => Promise<void>
  /** Called while waiting out a 429, so the caller can heartbeat its lease. */
  onWait?: (ms: number, attempt: number) => Promise<void> | void
  fetchImpl?: typeof fetch
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function embedBatch(inputs: string[], opts: EmbedClientOptions = {}): Promise<EmbedResult> {
  const url = opts.url ?? config.embedderUrl
  const retries = opts.retries ?? config.pipeline.embedRetries
  const sleep = opts.sleep ?? defaultSleep
  const doFetch = opts.fetchImpl ?? fetch
  let rateLimitedRetries = 0
  for (let attempt = 1; ; attempt++) {
    let res: Response
    try {
      res = await doFetch(`${url}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      embedCalls.inc({ result: 'error' })
      throw new EmbedError(`Embedder unreachable: ${(err as Error).message}`, null)
    }
    if (res.ok) {
      const body = (await res.json()) as { vectors: number[][]; model: string }
      if (!Array.isArray(body.vectors) || body.vectors.length !== inputs.length) throw new EmbedError('Embedder returned the wrong number of vectors', res.status)
      embedCalls.inc({ result: 'ok' })
      return { vectors: body.vectors, model: body.model, rateLimitedRetries }
    }
    if ((res.status === 429 || res.status === 503) && attempt <= retries) {
      embedCalls.inc({ result: res.status === 429 ? 'rate_limited' : 'retryable_error' })
      rateLimitedRetries += 1
      const retryAfter = Number(res.headers.get('retry-after'))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoffMs(attempt, 250, 8000)
      await res.body?.cancel().catch(() => undefined)
      await opts.onWait?.(wait, attempt)
      await sleep(wait)
      continue
    }
    embedCalls.inc({ result: 'error' })
    const text = await res.text().catch(() => '')
    throw new EmbedError(`Embedder returned ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`, res.status)
  }
}
