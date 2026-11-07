/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code.
 */
import type {
  AnnotationQueue,
  Attempt,
  CaseDiff,
  CaseView,
  Comparison,
  DatasetCase,
  DatasetDetail,
  DatasetSummary,
  ModelConfig,
  PromptDetail,
  PromptSummary,
  RunDetail,
  RunHeader,
  RunListItem,
  Scorer,
  SystemView,
  User,
} from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers ?? {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText)
  }
  return data as T
}

export interface CreateRunBody {
  name?: string
  datasetVersionId: string
  promptVersionId: string
  modelConfigId: string
  scorerVersionIds: string[]
  samplesPerCase: number
  concurrencyLimit?: number
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  runs: () => request<{ runs: RunListItem[] }>('/runs'),
  run: (id: string) => request<RunDetail>(`/runs/${id}`),
  runCases: (id: string) => request<{ cases: CaseView[] }>(`/runs/${id}/cases`),
  attempts: (runId: string, crId: string) => request<{ attempts: Attempt[] }>(`/runs/${runId}/case-results/${crId}/attempts`),
  createRun: (body: CreateRunBody, idempotencyKey: string) => request<{ run: RunHeader; replayed: boolean }>('/runs', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } }),
  cancelRun: (id: string) => request<{ status: string; cancelledTasks: number; alreadyFinished: boolean }>(`/runs/${id}/cancel`, { method: 'POST' }),
  retryErrored: (id: string) => request<{ requeued: number; scoresRequeued: number; retryRound: number }>(`/runs/${id}/retry-errored`, { method: 'POST' }),
  rescore: (id: string, scorerVersionId: string) => request<{ queued: number; alreadyScored: number }>(`/runs/${id}/rescore`, { method: 'POST', body: { scorerVersionId } }),
  annotations: (id: string) => request<AnnotationQueue>(`/runs/${id}/annotations`),
  annotate: (runId: string, crId: string, label: 'pass' | 'fail', note: string) => request<unknown>(`/runs/${runId}/annotations/${crId}`, { method: 'PUT', body: { label, note } }),
  compare: (a: string, b: string, scorer: string) => request<Comparison>(`/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&scorer=${encodeURIComponent(scorer)}`),

  datasets: () => request<{ datasets: DatasetSummary[] }>('/datasets'),
  dataset: (id: string) => request<{ dataset: DatasetDetail }>(`/datasets/${id}`),
  datasetCases: (id: string, version: number) => request<{ cases: DatasetCase[] }>(`/datasets/${id}/versions/${version}`),
  datasetDiff: (id: string, from: number, to: number) => request<{ diff: CaseDiff }>(`/datasets/${id}/diff?from=${from}&to=${to}`),
  createDatasetVersion: (id: string, body: { baseVersion: number; message: string; cases: { caseKey?: string; input: Record<string, string>; reference: string; tags: string[] }[] }) =>
    request<{ versionId: string; version: number; diff: CaseDiff }>(`/datasets/${id}/versions`, { method: 'POST', body }),

  prompts: () => request<{ prompts: PromptSummary[] }>('/prompts'),
  prompt: (id: string) => request<{ prompt: PromptDetail }>(`/prompts/${id}`),
  createPromptVersion: (id: string, body: { baseVersion: number; system: string; template: string; message: string }) => request<{ id: string; version: number }>(`/prompts/${id}/versions`, { method: 'POST', body }),
  modelConfigs: () => request<{ modelConfigs: ModelConfig[] }>('/model-configs'),

  scorers: () => request<{ scorers: Scorer[] }>('/scorers'),
  createScorerVersion: (id: string, body: { baseVersion: number; config: Record<string, unknown>; message: string }) => request<{ id: string; version: number }>(`/scorers/${id}/versions`, { method: 'POST', body }),

  system: () => request<SystemView>('/system'),
  armChaos: (target: 'model' | 'judge', armed: Record<string, number>) => request<unknown>(`/system/${target}/chaos`, { method: 'PUT', body: { armed } }),
  resetChaos: (target: 'model' | 'judge') => request<unknown>(`/system/${target}/chaos/reset`, { method: 'POST' }),
}
