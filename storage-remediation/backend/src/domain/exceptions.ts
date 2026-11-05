/**
 * Risk acceptance. An exception is time-boxed: it has an owner, a
 * justification, an approver who is not the requester, and an expiry. When it
 * expires the finding reopens automatically.
 * @module domain/exceptions
 */
import type { Severity } from './types.js'

export type ExceptionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'

export interface ExceptionRecord {
  id: string
  status: ExceptionStatus
  requestedBy: string
  expiresAt: Date
}

/** Longest exception an approver may grant, by finding severity. */
export const MAX_EXCEPTION_DAYS: Record<Severity, number> = { critical: 30, high: 90, medium: 180, low: 365 }

export function isExceptionActive(e: Pick<ExceptionRecord, 'status' | 'expiresAt'>, now: Date): boolean {
  return e.status === 'approved' && e.expiresAt.getTime() > now.getTime()
}

/** Approved exceptions whose expiry has passed and must be flipped to expired. */
export function findExpired<T extends Pick<ExceptionRecord, 'status' | 'expiresAt'>>(exceptions: T[], now: Date): T[] {
  return exceptions.filter((e) => e.status === 'approved' && e.expiresAt.getTime() <= now.getTime())
}

export function isExpiringSoon(e: Pick<ExceptionRecord, 'status' | 'expiresAt'>, now: Date, withinMs: number): boolean {
  const left = e.expiresAt.getTime() - now.getTime()
  return e.status === 'approved' && left > 0 && left <= withinMs
}

export function validateExceptionRequest(severity: Severity, days: number): string | null {
  if (!Number.isInteger(days) || days < 1) return 'Duration must be at least one day'
  const max = MAX_EXCEPTION_DAYS[severity]
  if (days > max) return `A ${severity} finding can be excepted for at most ${max} days`
  return null
}

export function canDecide(approverId: string, approverRole: string, e: Pick<ExceptionRecord, 'status' | 'requestedBy'>): string | null {
  if (approverRole !== 'approver' && approverRole !== 'security') return 'Only approvers can decide exceptions'
  if (e.requestedBy === approverId) return 'You cannot approve your own request'
  if (e.status !== 'pending') return `Exception is already ${e.status}`
  return null
}
