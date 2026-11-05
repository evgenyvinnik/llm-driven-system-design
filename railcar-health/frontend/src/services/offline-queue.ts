/**
 * Offline-tolerant finding submission for yard tablets. Each form gets a
 * clientSubmissionId when it opens. If the network is down, the submission is
 * kept in localStorage and resent with the same id until the server answers;
 * the server treats a repeated id as a replay, so nothing is recorded twice.
 */
import { api, ApiError, type FindingInput } from './api'

const KEY = 'railcar-health:pending-findings'

export interface PendingFinding {
  workOrderId: string
  carId: string
  input: FindingInput
  queuedAt: string
}

export function loadQueue(): PendingFinding[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PendingFinding[]
  } catch {
    return []
  }
}

function saveQueue(items: PendingFinding[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    // Storage blocked: the item stays only in memory for this page view.
  }
}

export function enqueue(item: PendingFinding): void {
  const items = loadQueue().filter((i) => i.input.clientSubmissionId !== item.input.clientSubmissionId)
  saveQueue([...items, item])
}

/** Submits now; on a network failure, queues it. Returns 'sent' or 'queued'. Server rejections are thrown. */
export async function submitOrQueue(item: PendingFinding): Promise<'sent' | 'queued'> {
  try {
    await api.submitFinding(item.workOrderId, item.input)
    return 'sent'
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      enqueue(item)
      return 'queued'
    }
    throw err
  }
}

/** Resends queued findings. Drops items the server accepted, replayed or permanently refused. */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  let sent = 0
  const keep: PendingFinding[] = []
  for (const item of loadQueue()) {
    try {
      await api.submitFinding(item.workOrderId, item.input)
      sent += 1
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) keep.push(item)
      // 409 (already completed by someone else) or 4xx: the server has the final word; drop it.
    }
  }
  saveQueue(keep)
  return { sent, remaining: keep.length }
}
