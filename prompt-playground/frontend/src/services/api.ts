/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code and details.
 */
import type {
  AdminOverview,
  ModelConfig,
  ModelInfo,
  ModelSettings,
  Preset,
  PromptDetail,
  PromptListItem,
  Run,
  Share,
  SharedView,
  User,
  VersionDetail,
} from '@/types'

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

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError(0, 'NETWORK', 'Could not reach the server')
  }
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details)
  }
  return data as T
}

export interface CreateRunInput {
  promptId: string
  system: string
  template: string
  variables: Record<string, string>
  config: ModelConfig
  comparisonId?: string
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  models: () => request<{ models: ModelInfo[] }>('/models'),

  listPrompts: (q?: string) => request<{ prompts: PromptListItem[] }>(`/prompts${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  createPrompt: (body: { title: string; description?: string }) =>
    request<PromptDetail>('/prompts', { method: 'POST', body }),
  getPrompt: (id: string) => request<PromptDetail>(`/prompts/${id}`),
  updatePrompt: (id: string, body: { title?: string; description?: string }) =>
    request<PromptDetail>(`/prompts/${id}`, { method: 'PATCH', body }),
  getVersion: (id: string, version: number) => request<{ version: VersionDetail }>(`/prompts/${id}/versions/${version}`),
  saveVersion: (id: string, body: { system: string; template: string; message: string; baseVersion: number }) =>
    request<{ created: boolean; version: VersionDetail }>(`/prompts/${id}/versions`, { method: 'POST', body }),
  listRuns: (promptId: string, before?: string) =>
    request<{ runs: Run[]; nextBefore: string | null }>(
      `/prompts/${promptId}/runs?limit=25${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),

  /** The key makes a retried click return the same run instead of starting another. */
  createRun: (input: CreateRunInput, idempotencyKey: string) =>
    request<{ run: Run }>('/runs', { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
  getRun: (id: string) => request<{ run: Run }>(`/runs/${id}`),
  activeRuns: () => request<{ runs: Run[] }>('/runs/active'),
  cancelRun: (id: string) => request<{ run: Run }>(`/runs/${id}/cancel`, { method: 'POST' }),
  comparison: (id: string) => request<{ runs: Run[] }>(`/comparisons/${id}`),

  listPresets: () => request<{ presets: Preset[] }>('/presets'),
  createPreset: (body: { name: string; config: ModelConfig }) =>
    request<{ preset: Preset }>('/presets', { method: 'POST', body }),
  updatePreset: (id: string, revision: number, body: { name?: string; config?: ModelConfig }) =>
    request<{ preset: Preset }>(`/presets/${id}`, { method: 'PATCH', body, headers: { 'If-Match': `"${revision}"` } }),
  deletePreset: (id: string, revision: number) =>
    request<void>(`/presets/${id}`, { method: 'DELETE', headers: { 'If-Match': `"${revision}"` } }),

  createShare: (promptId: string, body: { kind: 'run'; runId: string } | { kind: 'version'; version: number }) =>
    request<{ share: Share }>(`/prompts/${promptId}/shares`, { method: 'POST', body }),
  listShares: (promptId: string) => request<{ shares: Share[] }>(`/prompts/${promptId}/shares`),
  revokeShare: (token: string) => request<void>(`/shares/${token}`, { method: 'DELETE' }),
  getShared: (token: string) => request<SharedView>(`/shared/${token}`),
  forkShared: (token: string) => request<{ promptId: string }>(`/shared/${token}/fork`, { method: 'POST' }),

  adminOverview: () => request<AdminOverview>('/admin/overview'),
  modelSettings: () => request<{ settings: ModelSettings; active: number }>('/admin/model-settings'),
  updateModelSettings: (body: Partial<ModelSettings>) =>
    request<{ settings: ModelSettings; active: number }>('/admin/model-settings', { method: 'PUT', body }),
}
