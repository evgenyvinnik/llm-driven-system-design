/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into ApiError with the server's code, message and details.
 */
import type {
  AccountDetail,
  AuditEntry,
  Campaign,
  CampaignConfig,
  CampaignSnapshot,
  ControlPolicy,
  ExceptionRecord,
  Facets,
  Finding,
  Notification,
  PlanSummary,
  Posture,
  User,
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
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
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

export type FindingQuery = Partial<Record<'control' | 'subscription' | 'owner' | 'severity' | 'evidence' | 'environment' | 'status' | 'q' | 'sort', string>> & { page?: number }

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : ''
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  posture: () => request<Posture>('/posture'),
  findings: (q: FindingQuery) => request<{ findings: Finding[]; total: number; page: number; pageSize: number }>(`/findings${qs(q)}`),
  facets: () => request<Facets>('/findings/facets'),
  account: (name: string) => request<AccountDetail>(`/accounts/${encodeURIComponent(name)}`),
  fixNow: (name: string, controlId: string, idempotencyKey: string) =>
    request<{ campaignId: string }>(`/accounts/${encodeURIComponent(name)}/fix`, { method: 'POST', body: { controlId }, headers: { 'Idempotency-Key': idempotencyKey } }),

  campaigns: () => request<{ campaigns: Campaign[] }>('/campaigns'),
  campaign: (id: string) => request<CampaignSnapshot>(`/campaigns/${id}`),
  previewCampaign: (config: CampaignConfig) => request<{ plan: PlanSummary }>('/campaigns/preview', { method: 'POST', body: config }),
  /** The key makes a double-click or a retried submit return the same campaign. */
  createCampaign: (config: CampaignConfig, idempotencyKey: string) =>
    request<{ campaignId: string; plan: PlanSummary; replayed: boolean }>('/campaigns', { method: 'POST', body: config, headers: { 'Idempotency-Key': idempotencyKey } }),
  transition: (id: string, action: 'start' | 'pause' | 'resume' | 'kill') => request<{ status: string; changed: boolean }>(`/campaigns/${id}/${action}`, { method: 'POST' }),

  exceptions: (status = 'all') => request<{ exceptions: ExceptionRecord[] }>(`/exceptions?status=${status}`),
  requestException: (body: { accountName: string; controlId: string; justification: string; days: number }) => request<{ id: string }>('/exceptions', { method: 'POST', body }),
  decideException: (id: string, decision: 'approve' | 'reject', note?: string) => request<unknown>(`/exceptions/${id}/${decision}`, { method: 'POST', body: note ? { note } : {} }),
  revokeException: (id: string) => request<unknown>(`/exceptions/${id}/revoke`, { method: 'POST' }),

  controls: () => request<{ controls: ControlPolicy[] }>('/controls'),
  setPolicy: (id: string, effect: string, force = false) => request<unknown>(`/controls/${id}/policy`, { method: 'PUT', body: force ? { effect, force } : { effect } }),
  audit: (q: { account?: string; campaign?: string; action?: string; before?: number }) => request<{ entries: AuditEntry[]; nextBefore: number | null }>(`/audit${qs(q)}`),
  notifications: () => request<{ notifications: Notification[] }>('/notifications'),
  requestScan: (kind: 'full-scan' | 'evidence') => request<{ requested: string }>('/admin/scan', { method: 'POST', body: { kind } }),
}
