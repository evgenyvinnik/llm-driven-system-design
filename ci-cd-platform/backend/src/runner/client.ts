/**
 * HTTP client to the control plane. Every call has a timeout. A connection failure
 * rotates to the next API instance, because runners don't care which one answers:
 * all the state is in PostgreSQL.
 * @module runner/client
 */
import type { ClaimedJob } from '../scheduling/claim.js'

export class LeaseLostError extends Error {
  constructor() {
    super('lease lost')
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('runner token rejected')
  }
}

export class RunnerClient {
  private index = 0
  private token = ''

  constructor(private readonly baseUrls: string[]) {}

  get currentUrl(): string {
    return this.baseUrls[this.index % this.baseUrls.length]
  }

  setToken(token: string): void {
    this.token = token
  }

  private async send(path: string, init: RequestInit & { timeoutMs?: number; bearer?: string }): Promise<Response> {
    try {
      const res = await fetch(`${this.currentUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${init.bearer ?? this.token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
      })
      if (res.status === 401) throw new UnauthorizedError()
      return res
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) this.index++
      throw err
    }
  }

  async json<T>(path: string, body: unknown, bearer?: string): Promise<T> {
    const res = await this.send(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), bearer })
    if (res.status === 409) {
      const parsed = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
      if (parsed.error?.code === 'LEASE_LOST') throw new LeaseLostError()
      throw new Error(`409 ${parsed.error?.code ?? ''}`)
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return (await res.json()) as T
  }

  async register(token: string, body: { name: string; labels: string[]; slots: number; pid: number }): Promise<{ runnerId: string; incarnation: number; token: string; leaseMs: number; heartbeatMs: number }> {
    return this.json('/api/v1/runner/register', body, token)
  }

  async claim(): Promise<ClaimedJob | null> {
    const res = await this.send('/api/v1/runner/claim', { method: 'POST' })
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`claim: HTTP ${res.status}`)
    return ((await res.json()) as { job: ClaimedJob }).job
  }

  async heartbeat(jobs: { jobId: string; attempt: number; fencingToken: number }[]): Promise<{ die: boolean; jobs: { jobId: string; ok: boolean; cancel: boolean }[] }> {
    return this.json('/api/v1/runner/heartbeat', { jobs })
  }

  private fenceHeaders(job: ClaimedJob): Record<string, string> {
    return { 'X-Attempt': String(job.attempt), 'X-Fencing-Token': String(job.fencingToken) }
  }

  private async fencedGet(path: string, job: ClaimedJob): Promise<Response> {
    const res = await this.send(path, { method: 'GET', headers: this.fenceHeaders(job), timeoutMs: 30_000 })
    if (res.status === 409) throw new LeaseLostError()
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return res
  }

  async checkout(job: ClaimedJob): Promise<{ sha: string; tree: Record<string, string> }> {
    return (await (await this.fencedGet(`/api/v1/runner/jobs/${job.jobId}/checkout`, job)).json()) as { sha: string; tree: Record<string, string> }
  }

  async listNeedsArtifacts(job: ClaimedJob): Promise<{ id: string; name: string; jobKey: string; sizeBytes: number }[]> {
    const res = await this.fencedGet(`/api/v1/runner/jobs/${job.jobId}/needs-artifacts`, job)
    return ((await res.json()) as { artifacts: { id: string; name: string; jobKey: string; sizeBytes: number }[] }).artifacts
  }

  async downloadArtifact(job: ClaimedJob, artifactId: string): Promise<Buffer> {
    const res = await this.fencedGet(`/api/v1/runner/jobs/${job.jobId}/needs-artifacts/${artifactId}`, job)
    return Buffer.from(await res.arrayBuffer())
  }

  async uploadArtifact(job: ClaimedJob, name: string, bytes: Buffer, retentionDays: number): Promise<void> {
    const res = await this.send(`/api/v1/runner/jobs/${job.jobId}/artifacts/${name}?retentionDays=${retentionDays}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', ...this.fenceHeaders(job) },
      body: new Uint8Array(bytes),
      timeoutMs: 30_000,
    })
    if (res.status === 409) throw new LeaseLostError()
    if (!res.ok) throw new Error(`artifact ${name}: HTTP ${res.status}`)
  }

  private fence(job: ClaimedJob) {
    return { attempt: job.attempt, fencingToken: job.fencingToken }
  }

  async startStep(job: ClaimedJob, index: number): Promise<void> {
    await this.json(`/api/v1/runner/jobs/${job.jobId}/steps/${index}/start`, this.fence(job))
  }

  async finishStep(job: ClaimedJob, index: number, status: string, exitCode: number | null): Promise<void> {
    await this.json(`/api/v1/runner/jobs/${job.jobId}/steps/${index}/finish`, { ...this.fence(job), status, exitCode })
  }

  async uploadLogs(job: ClaimedJob, chunks: { seq: number; stepIndex: number; text: string }[]): Promise<void> {
    await this.json(`/api/v1/runner/jobs/${job.jobId}/logs`, { ...this.fence(job), chunks })
  }

  async complete(job: ClaimedJob, conclusion: 'success' | 'failure' | 'cancelled', reason: string | null): Promise<void> {
    await this.json(`/api/v1/runner/jobs/${job.jobId}/complete`, { ...this.fence(job), conclusion, reason })
  }
}
