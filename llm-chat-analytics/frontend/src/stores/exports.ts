/**
 * Export jobs started from this tab. The job runs on the server; the tab only
 * remembers which IDs to show progress for, and survives navigation.
 */
import { create } from 'zustand'
import { api, type ExportJob } from '../lib/api'
import { toParams, type ResolvedQuery } from '../lib/filters'

interface ExportsState {
  watching: string[]
  /** Idempotency key per pending click, reused if the POST is retried. */
  pendingKey: string | null
  start: (kind: ExportJob['kind'], query: ResolvedQuery) => Promise<ExportJob>
  dismiss: (id: string) => void
}

export const useExports = create<ExportsState>((set, get) => ({
  watching: [],
  pendingKey: null,
  start: async (kind, query) => {
    const key = get().pendingKey ?? crypto.randomUUID()
    set({ pendingKey: key })
    const job = await api<ExportJob>('/exports', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ kind, query: Object.fromEntries(toParams(query)) }),
    })
    set((s) => ({ pendingKey: null, watching: s.watching.includes(job.id) ? s.watching : [job.id, ...s.watching].slice(0, 5) }))
    return job
  },
  dismiss: (id) => set((s) => ({ watching: s.watching.filter((w) => w !== id) })),
}))
