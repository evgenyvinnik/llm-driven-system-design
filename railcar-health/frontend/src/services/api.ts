/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into ApiError with the server's code and details. Status 0 means
 * the server could not be reached (offline yard tablet).
 */
import type {
  Alert, AlertEvent, AlertNotification, Backtest, CarDetail, Clock, DeadLetter, Detector, EventDetail, Fault, Heatmap, Hold, Metrics, Network, OpsOverview,
  StoredEvent, Thresholds, TimelineSubject, Trip, TripPass, TripUnit, TrendSeries, User, WorkOrder, Yard,
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

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '')
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : ''
}

export interface AlertQuery {
  status?: 'active' | 'closed' | 'all'
  tier?: number
  territory?: string
  late?: boolean
}

export interface FindingInput {
  clientSubmissionId: string
  finding: 'confirmed_bearing_defect' | 'brake_defect' | 'wheel_defect' | 'no_defect_found'
  disposition: 'bad_order' | 'release' | 'repaired'
  notes?: string
  observedAt?: string
  replacement?: { componentId: string; installedAt: string; axle?: number }
}

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),
  clock: () => request<Clock>('/clock'),

  alerts: (q: AlertQuery) =>
    request<{ alerts: Alert[]; counts: Record<string, number>; clock: Clock }>(`/alerts${qs({ status: q.status, tier: q.tier, territory: q.territory, late: q.late || undefined })}`),
  alert: (id: string) => request<{ alert: Alert; events: AlertEvent[]; notifications: AlertNotification[]; clock: Clock }>(`/alerts/${id}`),
  acknowledge: (id: string, version: number, action: string, note?: string) =>
    request<{ alert: Alert }>(`/alerts/${id}/acknowledge`, { method: 'POST', body: { version, action, note } }),

  trips: () => request<{ trips: Trip[]; clock: Clock }>('/trips'),
  trip: (id: string) => request<{ trip: Trip; units: TripUnit[]; passes: TripPass[]; clock: Clock }>(`/trips/${encodeURIComponent(id)}`),
  heatmap: (id: string) => request<Heatmap>(`/trips/${encodeURIComponent(id)}/heatmap`),

  car: (id: string) => request<CarDetail & { clock: Clock }>(`/cars/${encodeURIComponent(id)}`),
  trend: (id: string, position: string) => request<{ series: TrendSeries[] }>(`/cars/${encodeURIComponent(id)}/trend${qs({ position })}`),

  yards: () => request<{ yards: Yard[] }>('/yards'),
  workOrders: (yardId: string, status: 'open' | 'completed') => request<{ workOrders: WorkOrder[]; clock: Clock }>(`/yards/${yardId}/work-orders${qs({ status })}`),
  holds: (yardId: string) => request<{ holds: Hold[] }>(`/yards/${yardId}/holds`),
  outboundCheck: (yardId: string, carIds: string[]) =>
    request<{ blocked: Array<{ carId: string; status: string; reason: string; yardId: string }>; clear: string[] }>(`/yards/${yardId}/outbound-check`, { method: 'POST', body: { carIds } }),
  startWorkOrder: (id: string) => request<{ workOrder: WorkOrder }>(`/work-orders/${id}/start`, { method: 'POST' }),
  submitFinding: (workOrderId: string, input: FindingInput) =>
    request<{ finding: { id: string }; replayed: boolean }>(`/work-orders/${workOrderId}/finding`, { method: 'POST', body: input }),

  network: () => request<Network>('/network'),
  detector: (id: string) =>
    request<{
      detector: Detector
      recentPasses: Array<{ passId: string; symbol: string | null; passedAt: string; lagSeconds: number; late: boolean; medianAboveAmbient: number | null }>
      biasSamples: Array<{ tripId: string; sampleF: number; sampledAt: string }>
      missedTrains: Array<{ tripId: string; symbol: string; notedAt: string }>
    }>(`/network/detectors/${id}`),

  thresholds: () =>
    request<{ config: Thresholds; version: number; defaults: Thresholds; updatedBy: string | null; updatedAt: string | null; history: Array<{ version: number; changedBy: string; changedAt: string }> }>(
      '/admin/thresholds',
    ),
  saveThresholds: (version: number, config: Thresholds) => request<{ config: Thresholds; version: number }>('/admin/thresholds', { method: 'PUT', body: { version, config } }),
  previewThresholds: (config: Thresholds) => request<Backtest>('/admin/thresholds/preview', { method: 'POST', body: { config } }),
  metrics: () => request<Metrics>('/admin/metrics'),

  carTimeline: (carId: string) => request<{ subject: TimelineSubject; events: StoredEvent[] }>(`/event-log/cars/${encodeURIComponent(carId)}`),
  caseTimeline: (caseId: string) => request<{ subject: TimelineSubject; events: StoredEvent[] }>(`/event-log/cases/${caseId}`),
  event: (eventId: string) => request<EventDetail>(`/event-log/events/${eventId}`),

  opsStreams: () => request<OpsOverview>('/ops/streams'),
  deadLetters: () => request<{ entries: DeadLetter[] }>('/ops/dlq'),
  redrive: (id: string) => request<{ redriven: string; newMessageId: string; group: string }>(`/ops/dlq/${id}/redrive`, { method: 'POST' }),
  redriveAll: () => request<{ redriven: number }>('/ops/dlq/redrive-all', { method: 'POST' }),
  setFault: (group: string, fault: Fault) => request<{ faults: Record<string, Fault> }>(`/ops/faults/${group}`, { method: 'PUT', body: fault }),
  clearFault: (group: string) => request<{ faults: Record<string, Fault> }>(`/ops/faults/${group}`, { method: 'DELETE' }),
}
