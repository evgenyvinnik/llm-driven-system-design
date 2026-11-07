/**
 * The request state machine. Every status change is one conditional UPDATE
 * whose WHERE clause comes from this table, so two racing transitions (a
 * cancel and a completion) cannot both win: PostgreSQL's row lock serializes
 * them and the loser matches zero rows.
 *
 *   queued ──▶ running ──▶ completed
 *     │           ├──────▶ cancelled
 *     │           └──────▶ failed
 *     ├──────────────────▶ cancelled
 *     └──────────────────▶ failed
 *
 * `queued` includes "dispatched to a backend but no output yet": such a request
 * can still be re-routed. `running` starts at the first output token, the point
 * after which a request is pinned to its backend.
 * @module shared/state-machine
 */

export const STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const
export type RequestStatus = (typeof STATUSES)[number]

export const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['completed', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
}

export function isTerminal(status: RequestStatus): boolean {
  return TRANSITIONS[status].length === 0
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** Statuses a request may be in for a move to `to` to succeed. */
export function sourcesOf(to: RequestStatus): RequestStatus[] {
  return STATUSES.filter((s) => TRANSITIONS[s].includes(to))
}
