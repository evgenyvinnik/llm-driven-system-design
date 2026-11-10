/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code.
 */
import type { MoveSummary, TargetingRule } from '@exp/core'
import type { AuditEntry, ClientsView, Environment, Flag, Results, SystemView, User, VersionEntry } from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
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
    const { code, message, ...extra } = data?.error ?? {}
    throw new ApiError(response.status, code ?? 'HTTP_ERROR', message ?? response.statusText, extra)
  }
  return data as T
}

export interface ConfigChange {
  weights?: Record<string, number>
  rules?: TargetingRule[]
  fallthrough?: 'enroll' | 'exclude'
}

export interface NewFlag {
  key: string
  kind: 'flag' | 'experiment'
  name: string
  description: string
  unitType: 'user' | 'org' | 'anonymous'
  primaryMetric: string
  surface: string
}

const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` })

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  environments: () => request<{ environments: Environment[] }>('/environments'),
  system: () => request<SystemView>('/system'),

  flags: () => request<{ flags: Flag[] }>('/flags'),
  flag: (key: string) => request<{ flag: Flag }>(`/flags/${key}`),
  createFlag: (body: NewFlag) => request<{ flag: Flag }>('/flags', { method: 'POST', body }),
  updateConfig: (key: string, env: string, version: number, body: ConfigChange) =>
    request<{ flag: Flag; move: MoveSummary; snapshotVersion: number }>(`/flags/${key}/environments/${env}`, { method: 'PUT', body, headers: ifMatch(version) }),
  setStatus: (key: string, env: string, version: number, to: string) =>
    request<{ flag: Flag; snapshotVersion: number }>(`/flags/${key}/environments/${env}/status`, { method: 'POST', body: { to }, headers: ifMatch(version) }),
  kill: (key: string, env: string, reason: string) =>
    request<{ flag: Flag; snapshotVersion: number; publishedAt: number }>(`/flags/${key}/environments/${env}/kill`, { method: 'POST', body: { reason } }),
  versions: (key: string, env: string) => request<{ versions: VersionEntry[] }>(`/flags/${key}/environments/${env}/versions`),
  results: (key: string, env: string) => request<Results>(`/flags/${key}/results?env=${env}`),

  audit: (params: { flag?: string; env?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.flag) q.set('flag', params.flag)
    if (params.env) q.set('env', params.env)
    q.set('limit', String(params.limit ?? 100))
    return request<{ entries: AuditEntry[] }>(`/audit?${q}`)
  },
  clients: (env: string) => request<ClientsView>(`/clients?env=${env}`),
}
