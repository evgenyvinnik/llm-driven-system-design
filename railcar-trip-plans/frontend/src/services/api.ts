/**
 * Typed API client. Every call goes through `request`, which turns error responses into ApiError with the
 * server's code and details.
 */
import type { CarDetail, CarRow, Chain, Clock, Digest, DlqEntry, ExceptionRow, SagaRow, StreamsOverview, TimelineEvent, User } from '@/types'

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

const qs = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? `?${new URLSearchParams(entries as Array<[string, string]>).toString()}` : ''
}

export interface CarQuery {
  shipper?: string
  status?: string
  planStatus?: string
  q?: string
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),
  clock: () => request<Clock>('/clock'),

  cars: (q: CarQuery) =>
    request<{ cars: CarRow[]; counts: Record<string, number>; planCounts: Record<string, number>; shippers: Array<{ shipper_id: string; name: string }> }>(`/cars${qs({ ...q })}`),
  car: (id: string) => request<CarDetail>(`/cars/${encodeURIComponent(id)}`),
  timeline: (id: string) => request<{ carId: string; events: TimelineEvent[] }>(`/cars/${encodeURIComponent(id)}/timeline`),
  chain: (eventId: string, carId: string) => request<Chain>(`/events/${eventId}/chain${qs({ car: carId })}`),

  exceptions: (status: string, type?: string) => request<{ exceptions: ExceptionRow[]; counts: Array<{ type: string; status: string; n: number }> }>(`/exceptions${qs({ status, type })}`),
  resolveException: (id: string, version: number, note: string) => request<{ eventId: string }>(`/exceptions/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { version, note } }),

  replans: (state?: string) => request<{ sagas: SagaRow[]; counts: Record<string, number> }>(`/replans${qs({ state })}`),
  notifications: (shipper?: string) =>
    request<{ digests: Digest[]; pending: Array<{ shipper_id: string; n: number }>; totals: { items: number; digests: number; suppressed: number } }>(`/notifications${qs({ shipper })}`),

  streams: () => request<StreamsOverview>('/streams/overview'),
  dlq: () => request<{ entries: DlqEntry[] }>('/streams/dlq'),
  redrive: (group: string, id: string) => request<{ retryId: string }>(`/streams/dlq/${group}/${id}/redrive`, { method: 'POST' }),
  unknownCars: () => request<{ cars: Array<{ car_id: string; events: number; first_seen: string; types: string[] }> }>('/streams/unknown-cars'),
  registerCar: (carId: string) => request<unknown>('/streams/cars', { method: 'POST', body: { carId, carType: 'boxcar', ownerMark: carId.slice(0, 4) } }),
  calibration: () => request<{ n: number; inside: number; early: number; late: number; median_error_h: number | null }>('/streams/eta-calibration'),
}
