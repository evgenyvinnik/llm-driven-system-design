import type { BackendView, Org, Overview, RequestRecord, RoutingView, RuntimeConfig, User } from '@/types'

/** API error in the gateway's shape: { type: 'error', error: { type, message } }. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
    public retryAfter: string | null = null,
  ) {
    super(message)
  }
}

export async function toApiError(r: Response): Promise<ApiError> {
  const text = await r.text().catch(() => '')
  let body: { error?: { type?: string; message?: string } } | null = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  // Vite's proxy answers 500 with an empty body when the gateway is down.
  if (!body?.error && r.status >= 500) return new ApiError(r.status, 'unreachable', 'The gateway is unreachable. Is the backend running?')
  return new ApiError(r.status, body?.error?.type ?? 'api_error', body?.error?.message ?? `HTTP ${r.status}`, r.headers.get('retry-after'))
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'unreachable', 'The gateway is unreachable. Is the backend running?')
  }
  if (!r.ok) throw await toApiError(r)
  return (await r.json()) as T
}

export interface SubmitBody {
  keyId: string
  mode: 'sync' | 'stream' | 'async'
  model: string
  max_tokens: number
  system?: string
  priority?: 'interactive' | 'batch'
  messages: { role: 'user'; content: string }[]
  metadata?: { mock_output_tokens?: number; deadline_ms?: number }
}

export const api = {
  login: (username: string, password: string) => call<{ user: User }>('POST', '/api/v1/auth/login', { username, password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/v1/auth/logout'),
  me: () => call<{ user: User }>('GET', '/api/v1/auth/me'),

  orgs: () => call<{ orgs: Org[] }>('GET', '/api/v1/console/orgs'),
  requests: (params: { orgId?: string; keyId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    return call<{ requests: RequestRecord[] }>('GET', `/api/v1/console/requests?${q}`)
  },
  request: (id: string) => call<{ request: RequestRecord }>('GET', `/api/v1/console/requests/${id}`),
  cancel: (id: string) => call<{ cancelled: boolean; request: RequestRecord }>('POST', `/api/v1/console/requests/${id}/cancel`),
  /** Raw submit: the caller handles JSON (sync/async) or SSE (stream). */
  submit: (body: SubmitBody, signal?: AbortSignal) =>
    fetch('/api/v1/console/messages', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }),
  attach: (id: string, signal?: AbortSignal) => fetch(`/api/v1/console/requests/${id}/events`, { credentials: 'same-origin', signal }),

  overview: () => call<Overview>('GET', '/api/v1/admin/overview'),
  routing: () => call<RoutingView>('GET', '/api/v1/admin/routing'),
  setConfig: (patch: Partial<RuntimeConfig>) => call<{ config: RuntimeConfig }>('PUT', '/api/v1/admin/config', patch),
  resetConfig: () => call<{ config: RuntimeConfig }>('POST', '/api/v1/admin/config/reset'),
  drain: (id: string, draining: boolean) => call<{ backend: BackendView }>('POST', `/api/v1/admin/backends/${id}/drain`, { draining }),
  upgrade: (id: string, version: string) => call<{ backend: BackendView }>('POST', `/api/v1/admin/backends/${id}/upgrade`, { version }),
  backendSettings: (id: string, settings: Record<string, unknown>) => call<{ backend: BackendView }>('PUT', `/api/v1/admin/backends/${id}/settings`, settings),
}
