/**
 * API client. Every call goes through `request`, which sorts outcomes into
 * three kinds (see lib/sync-rules `classifyOutcome`):
 * - success (2xx),
 * - a definite answer from the server (4xx with the error envelope) → ApiError,
 * - anything else (network error, timeout, 5xx, a proxy page) → OutcomeUnknownError.
 * For a write, "unknown" means it may or may not have committed; the caller refetches.
 * @module services/api
 */
import { classifyOutcome } from '@/lib/sync-rules'
import type { ChangeLogEntry, Definition, EffectiveDoc, OrgPolicy, PatchResult, SettingValue, User } from '@/types'

export interface ErrorBody {
  code: string
  message: string
  [extra: string]: unknown
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ErrorBody,
  ) {
    super(body.message)
  }
}

export class OutcomeUnknownError extends Error {
  constructor(public status: number | null) {
    super(status === null ? 'No response from the server' : `Unexpected ${status} response`)
  }
}

export interface ClientIdentity {
  clientId: string
  clientLabel: string
}

const TIMEOUT_MS = 10_000

async function request<T>(base: string, path: string, init: RequestInit & { json?: unknown; identity?: ClientIdentity } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  if (init.identity) {
    headers.set('X-Client-Id', init.identity.clientId)
    headers.set('X-Client-Label', init.identity.clientLabel)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers,
      credentials: 'include',
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      signal: controller.signal,
    })
  } catch {
    throw new OutcomeUnknownError(null)
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 204) return undefined as T
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const envelope = body && typeof body === 'object' && 'error' in body ? ((body as { error: ErrorBody }).error ?? null) : null
  const kind = classifyOutcome(res.status, envelope !== null && typeof envelope.code === 'string')
  if (kind === 'success') return body as T
  if (kind === 'rejected') throw new ApiError(res.status, envelope!)
  throw new OutcomeUnknownError(res.status)
}

export function createApi(base: string) {
  return {
    me: () => request<{ user: User }>(base, '/v1/auth/me'),
    login: (username: string, password: string) => request<{ user: User }>(base, '/v1/auth/login', { method: 'POST', json: { username, password } }),
    logout: () => request<void>(base, '/v1/auth/logout', { method: 'POST' }),

    definitions: (includeRetired = false) =>
      request<{ catalogRevision: number; definitions: Definition[] }>(base, `/v1/definitions${includeRetired ? '?includeRetired=1' : ''}`),
    settings: () => request<EffectiveDoc>(base, '/v1/me/settings'),
    patchSettings: (patch: Record<string, SettingValue | null>, baseRevision: number | '*', identity: ClientIdentity) =>
      request<PatchResult>(base, '/v1/me/settings', {
        method: 'PATCH',
        json: patch,
        identity,
        headers: { 'If-Match': baseRevision === '*' ? '*' : `"${baseRevision}"` },
      }),
    history: () => request<{ changes: ChangeLogEntry[] }>(base, '/v1/me/history'),

    orgPolicy: () => request<OrgPolicy>(base, '/v1/admin/org'),
    setPolicy: (key: string, value: SettingValue, enforced: boolean, orgRevision: number) =>
      request<{ orgRevision: number; changed: boolean }>(base, `/v1/admin/org/policy/${encodeURIComponent(key)}`, {
        method: 'PUT',
        json: { value, enforced },
        headers: { 'If-Match': `"${orgRevision}"` },
      }),
    clearPolicy: (key: string, orgRevision: number) =>
      request<{ orgRevision: number; changed: boolean }>(base, `/v1/admin/org/policy/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${orgRevision}"` },
      }),
    orgHistory: () => request<{ changes: ChangeLogEntry[] }>(base, '/v1/admin/org/history'),
    createDefinition: (input: Record<string, unknown>) => request<{ definition: Definition }>(base, '/v1/admin/definitions', { method: 'POST', json: input }),
    deprecate: (key: string, graceDays: number, replacedBy: string | null) =>
      request<{ definition: Definition }>(base, `/v1/admin/definitions/${encodeURIComponent(key)}/deprecate`, {
        method: 'POST',
        json: { graceDays, replacedBy },
      }),

    getChaos: () => request<{ dropNextPatchResponses: number }>(base, '/v1/dev/chaos'),
    setChaos: (n: number) => request<{ dropNextPatchResponses: number }>(base, '/v1/dev/chaos', { method: 'PUT', json: { dropNextPatchResponses: n } }),
  }
}

export type Api = ReturnType<typeof createApi>

/** Instance A (the default). The two-devices view also uses `/api-b`. */
export const api = createApi('/api')
