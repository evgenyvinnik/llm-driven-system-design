/**
 * Typed API client. Every call goes through `request`, which turns error
 * responses into `ApiError` with the server's code and details, because the board
 * branches on them: NEEDS_OVERRIDE, EDIT_REFUSED, VERSION_CONFLICT, STALE_STATE.
 */
import type {
  AlertView,
  Board,
  ComparisonData,
  CrewReportInput,
  CrewReportResult,
  CrewView,
  HoldEventRow,
  HoldRow,
  OverrideRow,
  PlanDiff,
  PlanVersion,
  Move,
  ReplayData,
  ShiftMetrics,
  SimState,
  User,
  Violation,
} from '@/types'

export interface ApiErrorDetails {
  violations?: Violation[]
  overridable?: boolean
  current?: number | null
  currentAuthor?: string | null
  basedOn?: number
  recomputeQueued?: boolean
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ApiErrorDetails,
    public body?: unknown,
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
    throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? response.statusText, error.details, data)
  }
  return data as T
}

export type EditOp = { op: 'reorder'; moveKey: string; toIndex: number } | { op: 'retarget'; moveKey: string; toTrackId: string }

export interface EditBody {
  expectedVersionNo: number
  ops: EditOp[]
  reason: string
  reasonCode: string
  overrideSoft?: boolean
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body })

export const api = {
  login: (username: string, password: string) => post<{ user: User }>('/auth/login', { username, password }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/auth/me'),

  board: () => request<Board>('/yard/board'),
  plans: () => request<{ stateVersion: number; headVersionId: string | null; workingVersionId: string | null; versions: PlanVersion[] }>('/plans'),
  plan: (id: string) => request<{ version: PlanVersion; parentVersionNo: number | null; stateVersion: number; moves: Move[] }>(`/plans/${id}`),
  diff: (id: string) => request<PlanDiff>(`/plans/${id}/diff`),
  publish: (id: string, expectedStateVersion?: number) => post<{ version: PlanVersion }>(`/plans/${id}/publish`, { expectedStateVersion }),
  discard: (id: string) => post<{ discarded: number }>(`/plans/${id}/discard`),
  edit: (id: string, body: EditBody) => post<{ version: PlanVersion; pinned: { before: string; after: string }[] }>(`/plans/${id}/edits`, body),
  replan: (reason?: string) => post<{ queued: boolean }>('/replan', { reason }),

  lockMove: (moveKey: string, reason: string, reasonCode: string) => post<{ id: string | null }>('/locks', { kind: 'move', moveKey, reason, reasonCode }),
  lockCar: (carId: string, trackId: string, reason: string, reasonCode: string, overrideSoft?: boolean) => post<{ id: string | null; replanQueued: boolean }>('/locks', { kind: 'car_track', carId, trackId, reason, reasonCode, overrideSoft }),
  releaseLock: (id: string, reason: string, reasonCode: string) => post<{ released: boolean }>(`/locks/${id}/release`, { reason, reasonCode }),
  reviseDeparture: (id: string, departure: string, reason: string, reasonCode: string) => post<unknown>(`/yard/outbound/${id}/revise-departure`, { departure, reason, reasonCode }),
  ackAlert: (id: string) => post<{ acknowledged: boolean }>(`/alerts/${id}/ack`),
  alerts: () => request<{ alerts: AlertView[] }>('/alerts'),
  overrides: () => request<{ overrides: OverrideRow[] }>('/overrides'),

  crewMoves: (crew: 'all' | 'hump' | 'trim') => request<CrewView>(`/crew/moves?crew=${crew}`),
  crewReport: (report: CrewReportInput) => post<{ result: CrewReportResult }>('/crew/reports', report),
  crewBatch: (reports: CrewReportInput[]) => post<{ results: CrewReportResult[] }>('/crew/reports/batch', { reports }),

  holds: () => request<{ holds: HoldRow[]; events: HoldEventRow[] }>('/holds'),

  comparison: () => request<ComparisonData>('/comparisons/latest'),
  runComparison: () => post<{ jobId: string }>('/comparisons', {}),
  shiftMetrics: () => request<{ currentShiftId: number; shifts: ShiftMetrics[] }>('/metrics/shifts'),
  replay: () => request<ReplayData>('/replays/latest'),
  runReplay: () => post<{ jobId: string }>('/replays', {}),

  simState: () => request<SimState>('/sim/state'),
  simControl: (action: string, body: unknown = {}) => post<SimState>(`/sim/control/${action}`, body),
  simScenario: (name: string, body: unknown = {}) => post<Record<string, unknown>>(`/sim/scenario/${name}`, body),
}
