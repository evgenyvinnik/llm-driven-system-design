/**
 * Live run state for the whole app, not one page.
 *
 * Streams live outside React components, so navigating to another prompt or
 * the library does not drop them: a run started on prompt A keeps streaming
 * while the user edits prompt B, and its result is in this store (and a
 * toast) when it finishes. On load, the app re-follows the user's active
 * runs, replaying their output from the start of each run's event stream.
 */
import { create } from 'zustand'
import { api } from '@/services/api'
import { followRun, type ConnectionState } from '@/services/run-stream'
import { useToasts } from '@/stores/toast-store'
import { isTerminal, type Run, type RunStatus, type RunUsage } from '@/types'

export interface LiveRun extends Run {
  output: string
  connection: ConnectionState
  streamError?: string
}

interface RunsState {
  runs: Record<string, LiveRun>
  viewingPromptId: string | null
  titles: Record<string, string>
  upsert: (run: Run) => void
  follow: (run: Run, promptTitle?: string) => void
  cancel: (runId: string) => Promise<void>
  setViewing: (promptId: string | null, title?: string) => void
  reset: () => void
}

const closers = new Map<string, () => void>()

/** Lifecycle order. A run only moves forward, so a lower-ranked copy is always stale. */
const STAGE: Record<RunStatus, number> = { queued: 0, running: 1, completed: 2, cancelled: 2, failed: 2 }

interface EndEvent {
  status: RunStatus
  outputTruncated: boolean
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: RunUsage
  at: string
}

export const useRuns = create<RunsState>((set, get) => {
  const patch = (id: string, fields: Partial<LiveRun>) => {
    const current = get().runs[id]
    if (!current) return
    set({ runs: { ...get().runs, [id]: { ...current, ...fields } } })
  }

  const notifyFinished = (run: LiveRun) => {
    if (get().viewingPromptId === run.promptId) return
    const title = get().titles[run.promptId] ?? run.promptTitle ?? 'a prompt'
    const verb = run.status === 'completed' ? 'finished' : run.status
    useToasts.getState().push({
      message: `Run on “${title}” ${verb}`,
      tone: run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'info',
      promptId: run.promptId,
      runId: run.comparisonId ?? run.id,
      durationMs: 12_000,
    })
  }

  const stopFollowing = (id: string) => {
    closers.get(id)?.()
    closers.delete(id)
  }

  return {
    runs: {},
    viewingPromptId: null,
    titles: {},

    upsert: (run) => {
      const existing = get().runs[run.id]
      let next: LiveRun
      // While a stream is followed it owns status and output. A REST response can also
      // arrive after the stream already delivered the end (e.g. the Stop request's reply
      // racing the executor's cancellation), so never let a copy move a run backwards.
      if (existing && (closers.has(run.id) || STAGE[existing.status] > STAGE[run.status])) {
        next = {
          ...existing,
          version: run.version,
          savedVersion: run.savedVersion,
          system: run.system ?? existing.system,
          input: run.input ?? existing.input,
        }
      } else {
        next = {
          ...existing,
          ...run,
          output: run.output ?? existing?.output ?? run.outputPreview ?? '',
          connection: existing?.connection ?? 'closed',
        }
      }
      set({ runs: { ...get().runs, [run.id]: next } })
    },

    follow: (run, promptTitle) => {
      if (promptTitle) set({ titles: { ...get().titles, [run.promptId]: promptTitle } })
      get().upsert(run)
      if (isTerminal(run.status)) {
        if (run.output === undefined) {
          void api.getRun(run.id).then(({ run: full }) => get().upsert(full)).catch(() => undefined)
        }
        return
      }
      if (closers.has(run.id)) return
      // No cursor: the stream replays from the start, so reset any preview text.
      patch(run.id, { output: '', connection: 'connecting' })
      const close = followRun(run.id, undefined, {
        onConnection: (connection) => patch(run.id, { connection }),
        onFatal: (message) => {
          closers.delete(run.id)
          patch(run.id, { streamError: message })
        },
        onEvent: (type, data) => {
          const current = get().runs[run.id]
          if (!current) return
          if (type === 'status') {
            const d = data as { status: RunStatus; attempt?: number; at: string }
            patch(run.id, {
              status: d.status,
              ...(d.attempt ? { attempt: d.attempt } : {}),
              ...(d.status === 'running' ? { startedAt: d.at } : {}),
            })
          } else if (type === 'delta') {
            patch(run.id, { output: current.output + (data as { text: string }).text })
          } else if (type === 'end') {
            const d = data as EndEvent
            patch(run.id, {
              status: d.status,
              outputTruncated: d.outputTruncated,
              finishReason: d.finishReason,
              errorCode: d.errorCode,
              errorMessage: d.errorMessage,
              usage: d.usage,
              finishedAt: d.at,
            })
            closers.delete(run.id)
            notifyFinished(get().runs[run.id])
          } else if (type === 'snapshot') {
            closers.delete(run.id)
            const full = data as Run
            set({ runs: { ...get().runs, [run.id]: { ...current, ...full, output: full.output ?? '' } } })
            notifyFinished(get().runs[run.id])
          }
        },
      })
      closers.set(run.id, close)
    },

    cancel: async (runId) => {
      patch(runId, { cancelRequested: true })
      const { run } = await api.cancelRun(runId)
      get().upsert(run)
    },

    setViewing: (promptId, title) => {
      set({
        viewingPromptId: promptId,
        ...(promptId && title ? { titles: { ...get().titles, [promptId]: title } } : {}),
      })
    },

    reset: () => {
      for (const id of [...closers.keys()]) stopFollowing(id)
      set({ runs: {}, viewingPromptId: null, titles: {} })
    },
  }
})
