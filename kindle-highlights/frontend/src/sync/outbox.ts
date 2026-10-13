/**
 * This browser's outbox for highlight edits and deletes.
 *
 * An edit is shown immediately, stored here (localStorage, so a reload doesn't lose it) and
 * pushed to POST /api/sync/push. Without a network the operations wait and go out on the next
 * flush: when the sync socket reconnects, when the browser fires `online`, or with the next
 * edit. The server treats every operation idempotently (field stamps for edits, tombstones for
 * deletes), so pushing the same batch twice is harmless, and every per-operation status it
 * returns is final, so a rejected operation is dropped instead of being retried forever.
 *
 * @module sync/outbox
 */
import { ApiError, pushOps, type Highlight, type SyncOp, type SyncOpResult } from '@/api/client'
import { useStore } from '@/stores/useStore'

const STORAGE_KEY = 'kindle-highlights-outbox'
/** The server accepts at most this many operations per push. */
const BATCH_SIZE = 100

type UpdateChanges = Extract<SyncOp, { kind: 'update' }>['changes']

function load(): SyncOp[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SyncOp[]) : []
  } catch {
    return []
  }
}

function save(ops: SyncOp[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ops))
  useStore.getState().setPendingOps(ops.length)
}

/** Queues an edit, stamped with this device's clock at the moment the reader made it. */
export function enqueueUpdate(id: string, changes: UpdateChanges): void {
  save([...load(), { opId: crypto.randomUUID(), kind: 'update', id, changes, clientUpdatedAt: Date.now() }])
}

/** Queues a delete. Any queued edits of the same highlight become moot and are dropped. */
export function enqueueDelete(id: string): void {
  const remaining = load().filter((op) => op.id !== id)
  save([...remaining, { opId: crypto.randomUUID(), kind: 'delete', id, clientUpdatedAt: Date.now() }])
}

/** Forgets everything queued (on logout: the operations belong to the account that made them). */
export function clearOutbox(): void {
  save([])
}

/**
 * Overlays queued operations on server data, so a refetch that races a pending push doesn't
 * make an edit flicker back to its old value.
 */
export function withPending(highlights: Highlight[]): Highlight[] {
  const ops = load()
  if (ops.length === 0) return highlights
  const deleted = new Set(ops.filter((op) => op.kind === 'delete').map((op) => op.id))
  return highlights
    .filter((h) => !deleted.has(h.id))
    .map((h) => ops.reduce((acc, op) => (op.kind === 'update' && op.id === h.id ? { ...acc, ...op.changes } : acc), h))
}

let inFlight: Promise<SyncOpResult[]> | null = null

/** Pushes everything queued. Concurrent callers share one request (single flight). */
export function flushOutbox(): Promise<SyncOpResult[]> {
  if (!inFlight) {
    inFlight = drain().finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

async function drain(): Promise<SyncOpResult[]> {
  const results: SyncOpResult[] = []
  for (;;) {
    const batch = load().slice(0, BATCH_SIZE)
    if (batch.length === 0) return results
    const sent = new Set(batch.map((op) => op.opId))
    try {
      const response = await pushOps(batch)
      results.push(...response.results)
    } catch (error) {
      // 400 means the batch itself is malformed and will never succeed: drop it. Anything else
      // (offline, 5xx, expired session) keeps the operations for the next flush.
      if (!(error instanceof ApiError && error.status === 400)) throw error
    }
    // Remove exactly what was sent; operations queued during the request stay.
    save(load().filter((op) => !sent.has(op.opId)))
  }
}

/** Number of operations waiting, for initial render before the store is updated. */
export function pendingCount(): number {
  return load().length
}
