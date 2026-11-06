/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into ApiError with the server's code. Quote submission keeps the
 * HTTP status, because 201 (firm) and 202 (indicative, firm to follow) mean
 * different things to the portal.
 */
import type {
  Analytics, DeadLetter, Delivery, Knobs, OpsOverview, Quote, Receipt, Reference, ReplayResult, Settings, StoredEvent, StreamsOverview, SubmitResult, User,
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

async function raw(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; data: unknown }> {
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
  const data = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: unknown } }
  if (!response.ok) {
    const error = data?.error ?? {}
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details)
  }
  return { status: response.status, data }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  return (await raw(path, opts)).data as T
}

const qs = (params: Record<string, string | number | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : ''
}

export interface QuoteForm {
  origin: string
  destination: string
  commodity: string
  equipment: string
  quantity: number
  shipWeek: string
  callback: boolean
}

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  reference: () => request<Reference>('/reference'),

  /** The idempotency key is created once per form submission and reused on any retry of it. */
  async submitQuote(form: QuoteForm, idempotencyKey: string): Promise<SubmitResult> {
    const { status, data } = await raw('/quotes', { method: 'POST', body: form, headers: { 'Idempotency-Key': idempotencyKey } })
    return { ...(data as Omit<SubmitResult, 'httpStatus'>), httpStatus: status }
  },
  quotes: (params: { limit?: number; status?: string } = {}) => request<{ quotes: Quote[] }>(`/quotes${qs(params)}`),
  quote: (id: string) => request<{ quote: Quote }>(`/quotes/${id}`),
  quoteEvents: (id: string) => request<{ events: StoredEvent[]; causes: StoredEvent[]; deliveries: Delivery[] }>(`/quotes/${id}/events`),
  book: (id: string, idempotencyKey: string) =>
    raw(`/quotes/${id}/book`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } }).then((r) => r.data as { quote: Quote }),

  overview: () => request<OpsOverview>('/ops/overview'),
  updateSettings: (patch: Partial<Settings> | Record<string, unknown>) => request<{ settings: Settings }>('/ops/settings', { method: 'PUT', body: patch }),
  resetSettings: () => request<{ settings: Settings }>('/ops/settings/reset', { method: 'POST' }),
  setKnobs: (dep: string, patch: Partial<Knobs>) => request<unknown>(`/ops/knobs/${dep}`, { method: 'PUT', body: patch }),
  resetKnobs: () => request<unknown>('/ops/knobs/reset', { method: 'POST' }),
  resetStats: () => request<unknown>('/ops/stats/reset', { method: 'POST' }),
  publishTariff: (body: { origin: string; destination: string; commodity: string; equipment: string }) => request<{ event: StoredEvent }>('/ops/pricing/tariffs', { method: 'POST', body }),
  publishFuel: (centsPerMile: number) => request<{ event: StoredEvent }>('/ops/pricing/fuel', { method: 'POST', body: { centsPerMile } }),

  events: (params: { type?: string; before?: number; limit?: number; correlation?: string; old?: '1' } = {}) =>
    request<{ events: StoredEvent[]; counts: { type: string; n: number }[] }>(`/events${qs(params)}`),

  streams: () => request<StreamsOverview>('/streams'),
  deadLetters: () => request<{ deadLetters: DeadLetter[] }>('/streams/dlq'),
  redrive: (id: string) => request<unknown>(`/streams/dlq/${encodeURIComponent(id)}/redrive`, { method: 'POST' }),
  discard: (id: string) => request<unknown>(`/streams/dlq/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
  poison: (kind: 'unknown_version' | 'malformed') => request<unknown>('/streams/poison', { method: 'POST', body: { kind } }),
  deliveries: () => request<{ deliveries: Delivery[]; receiver: { receipts: Receipt[]; rejected: unknown[]; knobs: { failNext: number; latencyMs: number } } | null }>('/streams/webhooks'),
  retryDelivery: (id: string) => request<unknown>(`/streams/webhooks/${id}/retry`, { method: 'POST' }),
  receiverKnobs: (patch: { failNext?: number; latencyMs?: number }) => request<unknown>('/streams/receiver/knobs', { method: 'PUT', body: patch }),
  verifyProjection: () => request<ReplayResult>('/streams/projections/analytics/verify', { method: 'POST' }),
  rebuildProjection: () => request<ReplayResult>('/streams/projections/analytics/rebuild', { method: 'POST' }),

  analytics: () => request<Analytics>('/analytics'),
}
