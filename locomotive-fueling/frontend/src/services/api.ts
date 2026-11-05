/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code.
 */
import type {
  AlertRow,
  FleetResponse,
  FuelOption,
  OrderRow,
  Params,
  PriceChange,
  TelemetryPoint,
  TicketRow,
  TrainDetail,
  User,
  VendorSettings,
} from '@/types'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
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
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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

export const api = {
  login: (username: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  fleet: () => request<FleetResponse>('/fleet'),
  train: (id: string) => request<TrainDetail>(`/trains/${id}`),
  telemetry: (id: string, limit = 160) => request<{ readings: TelemetryPoint[] }>(`/trains/${id}/telemetry?limit=${limit}`),
  replan: (id: string) => request<{ queued: boolean }>(`/trains/${id}/replan`, { method: 'POST' }),
  acceptPlan: (id: string, version: number) => request<{ version: number }>(`/trains/${id}/plans/${version}/accept`, { method: 'POST' }),
  confirmProposal: (id: string, version: number) => request<{ version: number }>(`/trains/${id}/plans/${version}/confirm`, { method: 'POST' }),
  rejectProposal: (id: string, version: number) => request<{ rejected: number }>(`/trains/${id}/plans/${version}/reject`, { method: 'POST' }),

  orders: () => request<{ orders: OrderRow[] }>('/orders'),
  cancelOrder: (id: number) => request<{ status: string }>(`/orders/${id}/cancel`, { method: 'POST' }),
  tickets: () => request<{ tickets: TicketRow[]; totals: { gallons: number; cost: number } }>('/tickets'),
  alerts: (status: 'open' | 'all' = 'open') => request<{ alerts: AlertRow[] }>(`/alerts?status=${status}`),
  ackAlert: (id: number) => request<{ status: string }>(`/alerts/${id}/ack`, { method: 'POST' }),

  fuelOptions: () => request<{ options: FuelOption[]; history: PriceChange[] }>('/fuel-options'),
  updateOption: (id: string, patch: { pricePerGal?: number; active?: boolean; note?: string }) =>
    request<{ affectedTrains: string[] }>(`/admin/fuel-options/${id}`, { method: 'PUT', body: patch }),
  params: () => request<{ params: Params; defaults: Params }>('/admin/params'),
  updateParams: (patch: Params) => request<{ params: Params }>('/admin/params', { method: 'PUT', body: patch }),
  vendor: () => request<VendorSettings>('/admin/vendor'),
  updateVendor: (patch: Partial<VendorSettings>) => request<VendorSettings>('/admin/vendor', { method: 'PUT', body: patch }),
}
