/**
 * Typed API client. `request` is for user-level calls; `orgRequest` for
 * everything under /orgs/:orgId. The org variant binds the request to the
 * current org visit (aborted on switch), drops responses that arrive after
 * a switch, checks the echoed X-Org-Id, and reports X-Authz-Version so a
 * stale manifest is refetched even when the event stream is down.
 */
import { anySignal, assertStillActive, scopeSignal } from '@/lib/org-scope'
import type {
  Agent,
  Analytics,
  AuditEvent,
  Billing,
  ConversationDetail,
  ConversationFilters,
  ConversationPage,
  ExportJob,
  FeatureFlag,
  Invitation,
  InvitationView,
  KnowledgeDoc,
  Manifest,
  Member,
  OrgShareLink,
  OrgSummary,
  Overview,
  Permission,
  Prompt,
  PromptDetail,
  Role,
  SharedPrompt,
  User,
} from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Set once by the app shell; the client itself knows nothing about routing or stores. */
export const apiHooks: {
  onUnauthenticated?: () => void
  onForbidden?: (orgId: string, error: ApiError) => void
  onAuthzVersion?: (orgId: string, version: number) => void
} = {}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  try {
    return await fetch(`/api/v1${path}`, {
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
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = data?.error ?? {}
    const apiError = new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details)
    if (response.status === 401) apiHooks.onUnauthenticated?.()
    throw apiError
  }
  return data as T
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return parse<T>(await send(path, opts))
}

interface OrgRequestOptions extends RequestOptions {
  /** For calls that may legitimately target an org other than the active one (manifest refreshes). */
  allowInactive?: boolean
}

async function orgRequest<T>(orgId: string, path: string, opts: OrgRequestOptions = {}): Promise<T> {
  const fullPath = `/orgs/${orgId}${path}`
  const signal = opts.allowInactive ? opts.signal : anySignal([opts.signal, scopeSignal()])
  const response = await send(fullPath, { ...opts, signal })
  if (!opts.allowInactive) assertStillActive(orgId, path)
  const echoed = response.headers.get('X-Org-Id')
  if (echoed && echoed !== orgId) throw new ApiError(0, 'ORG_MISMATCH', 'Received data for a different organization')
  // The manifest response is the refresh itself; reporting its version would invalidate it mid-flight.
  const version = Number(response.headers.get('X-Authz-Version'))
  if (version && path !== '/manifest') apiHooks.onAuthzVersion?.(orgId, version)
  try {
    return await parse<T>(response)
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) apiHooks.onForbidden?.(orgId, err)
    throw err
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') search.set(k, String(v))
  const s = search.toString()
  return s ? `?${s}` : ''
}

export const api = {
  login: (email: string, password: string) =>
    request<{ user: User; orgs: OrgSummary[] }>('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User; orgs: OrgSummary[] }>('/auth/me'),

  invitation: (token: string) => request<{ invitation: InvitationView }>(`/invitations/${token}`),
  acceptInvitation: (token: string) =>
    request<{ orgId: string; orgName: string; role: Role }>(`/invitations/${token}/accept`, { method: 'POST' }),
  shared: (token: string) => request<{ prompt: SharedPrompt }>(`/shared/${token}`),

  manifest: (orgId: string, signal?: AbortSignal) =>
    orgRequest<{ manifest: Manifest }>(orgId, '/manifest', { signal, allowInactive: true }),
  setPreview: (orgId: string, role: Role | null) =>
    orgRequest<{ preview: unknown }>(orgId, '/preview', { method: 'POST', body: { role } }),
  requestAccess: (orgId: string, body: { permission?: Permission; page?: string; message?: string }) =>
    orgRequest<void>(orgId, '/access-requests', { method: 'POST', body }),
  overview: (orgId: string, signal?: AbortSignal) => orgRequest<Overview>(orgId, '/overview', { signal }),

  agents: (orgId: string, signal?: AbortSignal) => orgRequest<{ agents: Agent[] }>(orgId, '/agents', { signal }),
  createAgent: (orgId: string, body: { name: string; model: string; projectId: string; instructions?: string }) =>
    orgRequest<{ agent: { id: string } }>(orgId, '/agents', { method: 'POST', body }),
  updateAgent: (orgId: string, id: string, body: Partial<Pick<Agent, 'name' | 'model' | 'status' | 'instructions'>>) =>
    orgRequest<{ agent: Agent }>(orgId, `/agents/${id}`, { method: 'PATCH', body }),
  deleteAgent: (orgId: string, id: string) => orgRequest<void>(orgId, `/agents/${id}`, { method: 'DELETE' }),

  knowledge: (orgId: string, signal?: AbortSignal) => orgRequest<{ docs: KnowledgeDoc[] }>(orgId, '/knowledge', { signal }),
  createDoc: (orgId: string, body: { title: string; source: string; projectId: string }) =>
    orgRequest<{ doc: { id: string } }>(orgId, '/knowledge', { method: 'POST', body }),

  conversations: (orgId: string, filters: ConversationFilters, cursor: string | null, signal?: AbortSignal) =>
    orgRequest<ConversationPage>(orgId, `/conversations${qs({ ...filters, cursor, limit: 100 })}`, { signal }),
  conversation: (orgId: string, id: string, signal?: AbortSignal) =>
    orgRequest<{ conversation: ConversationDetail }>(orgId, `/conversations/${id}`, { signal }),
  analytics: (orgId: string, days: number, signal?: AbortSignal) =>
    orgRequest<Analytics>(orgId, `/analytics${qs({ days })}`, { signal }),

  prompts: (orgId: string, signal?: AbortSignal) => orgRequest<{ prompts: Prompt[] }>(orgId, '/prompts', { signal }),
  prompt: (orgId: string, id: string, signal?: AbortSignal) =>
    orgRequest<{ prompt: PromptDetail }>(orgId, `/prompts/${id}`, { signal }),
  createPrompt: (orgId: string, body: { title: string; body: string; projectId: string; sharedRoles: Role[] }) =>
    orgRequest<{ prompt: { id: string } }>(orgId, '/prompts', { method: 'POST', body }),
  updatePrompt: (orgId: string, id: string, body: { title?: string; body?: string; sharedRoles?: Role[] }) =>
    orgRequest<{ prompt: { id: string; sharedRoles: Role[] } }>(orgId, `/prompts/${id}`, { method: 'PATCH', body }),
  createLink: (orgId: string, promptId: string, expiresInDays: number | null) =>
    orgRequest<{ link: { id: string; token: string; url: string; expiresAt: string | null } }>(
      orgId,
      `/prompts/${promptId}/links`,
      { method: 'POST', body: { expiresInDays } },
    ),
  revokeLink: (orgId: string, linkId: string) => orgRequest<void>(orgId, `/links/${linkId}`, { method: 'DELETE' }),

  members: (orgId: string, signal?: AbortSignal) => orgRequest<{ members: Member[] }>(orgId, '/members', { signal }),
  changeRole: (orgId: string, userId: string, role: Role) =>
    orgRequest<{ member: { id: string; role: Role } }>(orgId, `/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (orgId: string, userId: string) =>
    orgRequest<{ invitationsRevoked: number; linksRevoked: number; exportsCancelled: number; sessionsEnded: number }>(
      orgId,
      `/members/${userId}`,
      { method: 'DELETE' },
    ),
  invitations: (orgId: string, signal?: AbortSignal) =>
    orgRequest<{ invitations: Invitation[] }>(orgId, '/invitations', { signal }),
  invite: (orgId: string, email: string, role: Role) =>
    orgRequest<{ invitation: Invitation & { acceptUrl: string } }>(orgId, '/invitations', {
      method: 'POST',
      body: { email, role },
    }),
  revokeInvitation: (orgId: string, id: string) => orgRequest<void>(orgId, `/invitations/${id}`, { method: 'DELETE' }),
  links: (orgId: string, signal?: AbortSignal) => orgRequest<{ links: OrgShareLink[] }>(orgId, '/links', { signal }),
  audit: (orgId: string, action: string, before: string | null, signal?: AbortSignal) =>
    orgRequest<{ events: AuditEvent[]; nextBefore: string | null; retentionDays: number }>(
      orgId,
      `/audit${qs({ action, before })}`,
      { signal },
    ),
  features: (orgId: string, signal?: AbortSignal) => orgRequest<{ flags: FeatureFlag[] }>(orgId, '/features', { signal }),
  setFeature: (orgId: string, key: string, rule: { enabled: boolean; roles: Role[] }) =>
    orgRequest<unknown>(orgId, `/features/${key}`, { method: 'PUT', body: rule }),
  billing: (orgId: string, signal?: AbortSignal) => orgRequest<Billing>(orgId, '/billing', { signal }),

  exports: (orgId: string, signal?: AbortSignal) => orgRequest<{ exports: ExportJob[] }>(orgId, '/exports', { signal }),
  createExport: (orgId: string, filters: ConversationFilters, idempotencyKey: string) =>
    orgRequest<{ export: ExportJob }>(orgId, '/exports', {
      method: 'POST',
      body: { kind: 'conversations', filters },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  cancelExport: (orgId: string, id: string) => orgRequest<unknown>(orgId, `/exports/${id}/cancel`, { method: 'POST' }),
  downloadUrl: (orgId: string, id: string) => `/api/v1/orgs/${orgId}/exports/${id}/download`,
}
