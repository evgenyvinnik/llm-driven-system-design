/**
 * Typed API client. Every call goes through `request`, which turns error responses
 * into `ApiError` with the server's code.
 */
import type { AuditEntry, Evaluation, EvaluationCase, PrDetail, PrRow, QueueEscalation, Repo, RepoDetail, SystemView, User } from '@/types'

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
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  } catch {
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

const query = (params: Record<string, string | number | boolean | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) s.set(k, String(v))
  const text = s.toString()
  return text ? `?${text}` : ''
}

export interface VerifyResult {
  ok: boolean
  chains: { repoId: string; repo: string; ok: boolean; checked: number; problems: { seq: number; problem: string; detail: string }[] }[]
}

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  prs: (f: { repo?: string; outcome?: string; overruled?: boolean } = {}) => request<{ prs: PrRow[] }>(`/prs${query(f)}`),
  pr: (owner: string, repo: string, number: string | number) => request<PrDetail>(`/prs/${owner}/${repo}/${number}`),
  rerun: (owner: string, repo: string, number: number) => request<{ runId: string }>(`/prs/${owner}/${repo}/${number}/rerun`, { method: 'POST', body: {} }),
  reportFalseApproval: (decisionId: string, note: string) => request<{ demoted: boolean }>(`/decisions/${decisionId}/report-false-approval`, { method: 'POST', body: { note } }),

  escalations: (f: { status?: string; repo?: string } = {}) => request<{ escalations: QueueEscalation[] }>(`/escalations${query(f)}`),
  claim: (id: string) => request<unknown>(`/escalations/${id}/claim`, { method: 'POST', body: {} }),
  release: (id: string) => request<unknown>(`/escalations/${id}/release`, { method: 'POST', body: {} }),
  decide: (id: string, decision: 'approve' | 'reject', headSha: string, note: string) => request<unknown>(`/escalations/${id}/decide`, { method: 'POST', body: { decision, headSha, note: note || undefined } }),

  audit: (f: { repo?: string; kind?: string; actor?: string; pr?: string; sha?: string; limit?: number }) => request<{ entries: AuditEntry[]; kinds: { kind: string; n: number }[] }>(`/audit${query(f)}`),
  verify: (repoId?: string) => request<VerifyResult>('/audit/verify', { method: 'POST', body: repoId ? { repoId } : {} }),

  evaluations: () => request<{ evaluations: Evaluation[]; modelVersions: string[] }>('/evaluations'),
  evaluation: (id: string) => request<{ evaluation: Evaluation; cases: EvaluationCase[] }>(`/evaluations/${id}`),
  runEvaluation: (modelVersion: string) => request<{ evaluation: Evaluation }>('/evaluations', { method: 'POST', body: { modelVersion } }),

  repos: () => request<{ repos: Repo[]; policyVersion: string; modelVersions: string[] }>('/repos'),
  repo: (id: string) => request<RepoDetail>(`/repos/${id}`),
  updateRepo: (id: string, patch: Partial<Repo>) => request<{ repo: Repo }>(`/repos/${id}`, { method: 'PATCH', body: patch }),
  promote: (id: string) => request<{ repo: Repo }>(`/repos/${id}/promote`, { method: 'POST', body: {} }),
  demote: (id: string, reason: string) => request<{ repo: Repo }>(`/repos/${id}/demote`, { method: 'POST', body: { reason } }),
  killSwitch: (id: string, on: boolean) => request<{ repo: Repo }>(`/repos/${id}/kill-switch`, { method: 'POST', body: { on } }),

  catalog: () => request<{ fixtures: string[] }>('/fixtures/catalog'),
  openFixture: (fullName: string, fixture: string, ci: string) => request<{ number: number; headSha: string }>(`/fixtures/${fullName}/pulls`, { method: 'POST', body: { fixture, ci } }),
  pushCommit: (fullName: string, number: number, kind: string, ci: string) => request<{ headSha: string }>(`/fixtures/${fullName}/pulls/${number}/push`, { method: 'POST', body: { kind, ci } }),
  flipCi: (fullName: string, number: number, ci: string) => request<unknown>(`/fixtures/${fullName}/pulls/${number}/checks`, { method: 'POST', body: { ci } }),
  addComment: (fullName: string, number: number, user: string, body: string) => request<unknown>(`/fixtures/${fullName}/pulls/${number}/comments`, { method: 'POST', body: { user, body } }),
  system: () => request<SystemView>('/system'),
  patchModel: (patch: unknown) => request<unknown>('/system/model', { method: 'PATCH', body: patch }),
  patchHost: (patch: unknown) => request<unknown>('/system/host', { method: 'PATCH', body: patch }),
}
