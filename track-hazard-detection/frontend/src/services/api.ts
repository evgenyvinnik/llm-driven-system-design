/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into ApiError with the server's code and details.
 */
import type { AlertRow, Board, DeadLetter, Envelope, Hazard, HazardDetail, Latency, OpsOverview, ReplayResult, Restriction, User } from '@/types'

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

export type Command =
  | { kind: 'acknowledge'; note?: string }
  | { kind: 'warn_trains' }
  | { kind: 'speed_restriction'; mpFrom: number; mpTo: number; maxSpeedMph: number; reason?: string }
  | { kind: 'lift_restriction'; restrictionId: string; reason?: string }
  | { kind: 'dispatch_inspector'; inspector: string; etaMinutes: number; note?: string }
  | { kind: 'clear'; note?: string }
  | { kind: 'false_alarm'; note?: string; cause?: string }

export interface CommandResult {
  hazard: Hazard
  appended: string[]
  replayed: boolean
}

/** Sends a command with a fresh command id. The same id is reused if the caller retries this exact submission. */
export function sendCommand(hazardId: string, command: Command, seenVersion?: number, commandId: string = crypto.randomUUID()) {
  return request<CommandResult>(`/hazards/${hazardId}/commands`, { method: 'POST', body: { commandId, seenVersion, command } })
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  board: () => request<Board>('/board'),
  hazards: (status: 'open' | 'closed' | 'all') => request<{ hazards: Hazard[] }>(`/hazards?status=${status}`),
  hazard: (id: string) => request<HazardDetail>(`/hazards/${id}`),
  alerts: (scope: 'mine' | 'all', closed: boolean) => request<{ alerts: AlertRow[]; serverTime: string }>(`/alerts?scope=${scope}&closed=${closed}`),
  restrictions: (status: 'active' | 'all') => request<{ restrictions: Restriction[] }>(`/restrictions?status=${status}`),
  latency: () => request<Latency>('/latency'),
  events: (q: { type?: string; before?: number; limit?: number }) => {
    const params = new URLSearchParams()
    if (q.type) params.set('type', q.type)
    if (q.before) params.set('before', String(q.before))
    params.set('limit', String(q.limit ?? 100))
    return request<{ events: Envelope[]; counts: Array<{ type: string; n: number }> }>(`/events?${params.toString()}`)
  },

  ops: () => request<OpsOverview>('/ops/overview'),
  deadLetters: () => request<{ deadLetters: DeadLetter[] }>('/ops/dlq'),
  redrive: (id: string) => request<{ redrivenTo: string }>(`/ops/dlq/${encodeURIComponent(id)}/redrive`, { method: 'POST' }),
  discard: (id: string) => request<void>(`/ops/dlq/${encodeURIComponent(id)}/discard`, { method: 'POST' }),
  registerSensor: (body: { id: string; type: string; milepost: number }) => request<{ id: string; created: boolean }>('/ops/sensors', { method: 'POST', body }),
  replay: (projection: string) => request<ReplayResult>(`/ops/replay/${projection}`, { method: 'POST' }),
}
