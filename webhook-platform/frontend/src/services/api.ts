/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code.
 */
import type { Attempt, Delivery, Endpoint, EventItem, NotificationItem, OpsOverview, ReceiverMode, ReceiverView, User } from '@/types'

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

export interface EmitBody {
  type: string
  data: Record<string, unknown>
  orderingKey?: string
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  endpoints: () => request<{ endpoints: Endpoint[] }>('/endpoints'),
  endpoint: (id: string) => request<{ endpoint: Endpoint }>(`/endpoints/${id}`),
  createEndpoint: (body: { url: string; description: string; eventTypes: string[]; maxConcurrency: number }) =>
    request<{ endpoint: Endpoint; secret: string; warning: string | null }>('/endpoints', { method: 'POST', body }),
  updateEndpoint: (id: string, body: Partial<{ url: string; description: string; eventTypes: string[]; maxConcurrency: number }>) =>
    request<{ endpoint: Endpoint; warning: string | null }>(`/endpoints/${id}`, { method: 'PATCH', body }),
  enableEndpoint: (id: string) => request<{ endpoint: Endpoint }>(`/endpoints/${id}/enable`, { method: 'POST' }),
  disableEndpoint: (id: string) => request<{ endpoint: Endpoint }>(`/endpoints/${id}/disable`, { method: 'POST' }),
  rotateSecret: (id: string, overlapSeconds: number) =>
    request<{ secret: string; previousExpiresAt: string; overlapSeconds: number }>(`/endpoints/${id}/rotate-secret`, { method: 'POST', body: { overlapSeconds } }),
  secret: (id: string) => request<{ current: string; previous: string | null; previousExpiresAt: string | null }>(`/endpoints/${id}/secret`),
  endpointDeliveries: (id: string, state?: string) => request<{ deliveries: Delivery[] }>(`/endpoints/${id}/deliveries?limit=60${state ? `&state=${state}` : ''}`),
  replayFailed: (id: string, since: string) => request<{ replayed: number }>(`/endpoints/${id}/replay`, { method: 'POST', body: { since } }),

  delivery: (id: string) => request<{ delivery: Delivery; event: EventItem; attempts: Attempt[] }>(`/deliveries/${id}`),
  replayDelivery: (id: string) => request<{ deliveryId: string; state: string }>(`/deliveries/${id}/replay`, { method: 'POST' }),

  events: (type?: string) => request<{ events: EventItem[] }>(`/events?limit=60${type ? `&type=${type}` : ''}`),
  event: (id: string) => request<{ event: EventItem; deliveries: Delivery[] }>(`/events/${id}`),
  emit: (body: EmitBody, idempotencyKey: string) =>
    request<{ event: EventItem; deliveries: { id: string; endpointId: string }[]; replayed: boolean }>('/events', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  notifications: () => request<{ unread: number; notifications: NotificationItem[] }>('/notifications'),
  readAllNotifications: () => request<{ marked: number }>('/notifications/read-all', { method: 'POST' }),
  apiKeys: () => request<{ apiKeys: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }[] }>('/api-keys'),

  receiver: () => request<ReceiverView>('/receiver?limit=120'),
  setReceiverPath: (name: string, body: Partial<{ mode: ReceiverMode; remaining: number | null; slowMs: number; retryAfterSeconds: number }>) =>
    request<unknown>(`/receiver/paths/${name}`, { method: 'PUT', body }),
  clearReceiver: () => request<void>('/receiver/received', { method: 'DELETE' }),

  ops: () => request<OpsOverview>('/ops/overview'),
}
