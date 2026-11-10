/**
 * Typed API client. Every call goes through `request`, which turns error responses into
 * `ApiError` with the server's code, so a screen can react to CONFIRM_REQUIRED and the like.
 */
import type { Delivery, Environment, JobDetail, OpsOverview, Repository, RepositoryDetail, RunDetail, Runner, RunListItem, Scenario, SecretMeta, SecretRelease, TriggerResult, User } from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response
  const hasBody = opts.body !== undefined
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : {},
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
    throw new ApiError(response.status, error?.code ?? 'ERROR', error?.message ?? `Request failed (${response.status})`, error?.details)
  }
  return parsed as T
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body })

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => post<{ user: User }>('/auth/login', { username, password }),
  logout: () => post<void>('/auth/logout'),

  repos: () => request<{ repositories: Repository[] }>('/repos').then((r) => r.repositories),
  repo: (id: string) => request<{ repository: RepositoryDetail }>(`/repos/${id}`).then((r) => r.repository),
  runs: (repoId: string, status?: string) => request<{ runs: RunListItem[] }>(`/repos/${repoId}/runs?limit=50${status ? `&status=${status}` : ''}`).then((r) => r.runs),
  environments: (repoId: string) => request<{ environments: Environment[] }>(`/repos/${repoId}/environments`).then((r) => r.environments),
  saveEnvironment: (repoId: string, name: string, body: { requiredApproval: boolean; allowedBranches: string[] }) => request<unknown>(`/repos/${repoId}/environments/${name}`, { method: 'PUT', body }),
  secrets: (repoId: string) => request<{ secrets: SecretMeta[] }>(`/repos/${repoId}/secrets`).then((r) => r.secrets),
  saveSecret: (repoId: string, body: { name: string; value: string; environment: string | null }) => request<unknown>(`/repos/${repoId}/secrets`, { method: 'PUT', body }),
  deleteSecret: (repoId: string, secretId: string) => request<void>(`/repos/${repoId}/secrets/${secretId}`, { method: 'DELETE' }),
  releases: (repoId: string) => request<{ releases: SecretRelease[] }>(`/repos/${repoId}/secret-releases`).then((r) => r.releases),

  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  workflow: (id: string) => request<{ path: string; sha: string; commitSha: string; content: string }>(`/runs/${id}/workflow`),
  cancelRun: (id: string) => post<{ status: string; signalled: number }>(`/runs/${id}/cancel`),
  rerunRun: (id: string, mode: 'failed' | 'all', confirmNonIdempotent = false) => post<unknown>(`/runs/${id}/rerun`, { mode, confirmNonIdempotent }),

  job: (id: string) => request<JobDetail>(`/jobs/${id}`),
  rerunJob: (id: string, confirmNonIdempotent = false) => post<unknown>(`/jobs/${id}/rerun`, { confirmNonIdempotent }),
  decide: (id: string, decision: 'approved' | 'rejected', comment: string | null) => post<unknown>(`/jobs/${id}/approval`, { decision, comment }),
  resolve: (id: string, decision: 'succeeded' | 'failed' | 'retry', note: string | null, confirmRetry = false) => post<unknown>(`/jobs/${id}/resolve`, { decision, note, confirmRetry }),

  runners: () => request<{ leaseMs: number; runners: Runner[] }>('/runners'),
  ops: () => request<OpsOverview>('/ops/overview'),

  scenarios: () => request<{ scenarios: Scenario[] }>('/fixtures/catalog').then((r) => r.scenarios),
  deliveries: () => request<{ deliveries: Delivery[] }>('/fixtures/deliveries').then((r) => r.deliveries),
  trigger: (repoId: string, scenario: string, killOnStep = false) => post<TriggerResult>('/fixtures/trigger', { repoId, scenario, killOnStep }),
  redeliver: (repoId: string, deliveryId: string) => post<TriggerResult>('/fixtures/redeliver', { repoId, deliveryId }),
  badSignature: (repoId: string) => post<{ httpStatus: number; deliveryId: string; response: { error?: { code: string } } }>('/fixtures/bad-signature', { repoId }),
  burst: (repoId: string, count: number, otherRepoId?: string, otherCount = 0) => post<{ accepted: number; otherAccepted: number }>('/fixtures/burst', { repoId, count, otherRepoId, otherCount }),
  killRunner: (runnerId: string) => post<unknown>('/fixtures/kill-runner', { runnerId }),
}
