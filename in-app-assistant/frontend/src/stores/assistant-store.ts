/**
 * Assistant state. Turns live in a map keyed by turn ID, and each live turn
 * has its own stream that outlives the component that started it: switching
 * from Docs to Mail mid-answer neither cancels the docs turn nor writes its
 * text into the mail conversation, and the finished answer lands in the
 * docs conversation wherever the user is.
 */
import { create } from 'zustand'
import { ApiError, api } from '@/services/api'
import { runClientTool } from '@/services/client-tools'
import { followTurn, type ConnectionState } from '@/services/turn-stream'
import { newKey } from '@/lib/format'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { App, Citation, PendingAction, TimelineItem, TurnDto, TurnState, TurnStatus } from '@/types'

interface Slot {
  conversationId: string | null
  turnIds: string[]
  loaded: boolean
}

interface AssistantState {
  open: boolean
  slots: Record<App, Slot>
  turns: Record<string, TurnState>
  connection: Record<string, ConnectionState>
  error: string | null
  setOpen: (open: boolean) => void
  load: (app: App) => Promise<void>
  send: (app: App, text: string) => Promise<void>
  cancel: (turnId: string) => Promise<void>
  decide: (turnId: string, actionId: string, approve: boolean) => Promise<void>
  newConversation: (app: App) => void
  applyEvents: (turnId: string, events: { type: string; data: Record<string, unknown>; id?: string }[]) => void
}

const ACTIVE: TurnStatus[] = ['running', 'waiting_client', 'waiting_confirmation']
const WRITE_TOOLS = new Set(['insert_text', 'replace_text', 'create_draft', 'send_draft', 'create_event'])
const streams = new Map<string, () => void>()
const clientCallsHandled = new Set<string>()

const emptySlot = (): Slot => ({ conversationId: null, turnIds: [], loaded: false })

export function isActive(status: TurnStatus): boolean {
  return ACTIVE.includes(status)
}

/** A finished turn loaded from the API, rebuilt into the same timeline the live stream produces. */
function fromDto(dto: TurnDto): TurnState {
  const items: TimelineItem[] = dto.activity.map((a, i) =>
    a.kind === 'notice'
      ? { kind: 'notice', noticeKind: a.name, message: a.summary }
      : { kind: 'tool', callId: `history-${i}`, name: a.name, label: a.summary, status: a.ok ? 'done' : 'failed', summary: a.summary },
  )
  if (dto.pendingAction) items.push({ kind: 'action', action: dto.pendingAction, status: 'pending' })
  if (dto.finalText) items.push({ kind: 'text', step: 999, text: dto.finalText })
  return {
    id: dto.id,
    conversationId: dto.conversationId,
    userText: dto.userText,
    status: dto.status,
    items,
    finalText: dto.finalText,
    citations: dto.citations ?? [],
    usage: dto.usage,
    errorMessage: dto.errorMessage,
    tainted: dto.tainted,
  }
}

/** An active turn before its stream has replayed: metadata only. */
function liveShell(dto: TurnDto): TurnState {
  return { ...fromDto(dto), items: [], finalText: null }
}

function reduce(turn: TurnState, type: string, data: Record<string, unknown>): TurnState {
  const items = [...turn.items]
  switch (type) {
    case 'turn.status':
      return { ...turn, status: data.status as TurnStatus }
    case 'text.delta': {
      const step = Number(data.step)
      const last = items[items.length - 1]
      if (last?.kind === 'text' && last.step === step) items[items.length - 1] = { ...last, text: last.text + String(data.text) }
      else items.push({ kind: 'text', step, text: String(data.text) })
      return { ...turn, items }
    }
    case 'text.discard':
      // A step is being redone after a broken stream: drop its partial text.
      return { ...turn, items: items.filter((i) => !(i.kind === 'text' && i.step === Number(data.step))) }
    case 'tool.status':
      if (!items.some((i) => i.kind === 'tool' && i.callId === data.callId)) {
        items.push({ kind: 'tool', callId: String(data.callId), name: String(data.name), label: String(data.label), status: 'running' })
      }
      return { ...turn, items }
    case 'tool.request':
      return { ...turn, items: items.map((i) => (i.kind === 'tool' && i.callId === data.callId ? { ...i, status: 'waiting' as const } : i)) }
    case 'tool.result': {
      const index = items.findIndex((i) => i.kind === 'tool' && i.callId === data.callId)
      const done = { status: data.ok ? ('done' as const) : ('failed' as const), summary: String(data.summary ?? ''), error: data.error ? String(data.error) : undefined }
      if (index >= 0) items[index] = { ...(items[index] as Extract<TimelineItem, { kind: 'tool' }>), ...done }
      else items.push({ kind: 'tool', callId: String(data.callId), name: String(data.name), label: String(data.summary ?? data.name), ...done })
      return { ...turn, items }
    }
    case 'action.proposed':
      items.push({ kind: 'action', action: data as unknown as PendingAction, status: 'pending' })
      return { ...turn, items }
    case 'action.resolved':
      return {
        ...turn,
        items: items.map((i) => (i.kind === 'action' && i.action.actionId === data.actionId ? { ...i, status: data.status as 'approved' | 'declined' | 'expired' } : i)),
      }
    case 'notice':
      items.push({ kind: 'notice', noticeKind: String(data.kind), message: String(data.message) })
      return { ...turn, items, tainted: turn.tainted || data.kind === 'untrusted' }
    case 'turn.end': {
      const finalText = (data.finalText as string | null) ?? null
      if (finalText && !items.some((i) => i.kind === 'text')) items.push({ kind: 'text', step: 999, text: finalText })
      return {
        ...turn,
        items: items.map((i) => (i.kind === 'action' && i.status === 'pending' ? { ...i, status: 'expired' as const } : i)),
        status: data.status as TurnStatus,
        finalText,
        citations: (data.citations as Citation[]) ?? [],
        usage: (data.usage as TurnState['usage']) ?? turn.usage,
        errorMessage: (data.errorMessage as string | null) ?? null,
        wrappedUp: (data.wrappedUp as string | null) ?? null,
      }
    }
    case 'snapshot':
      return fromDto(data as unknown as TurnDto)
    default:
      return turn
  }
}

export const useAssistantStore = create<AssistantState>((set, get) => {
  function attach(turnId: string) {
    if (streams.has(turnId)) return
    const stop = followTurn(turnId, get().turns[turnId]?.lastEventId, {
      onEvents: (events) => get().applyEvents(turnId, events),
      onConnection: (state) => {
        set((s) => ({ connection: { ...s.connection, [turnId]: state } }))
        if (state === 'closed') streams.delete(turnId)
      },
    })
    streams.set(turnId, stop)
  }

  async function answerClientTool(turnId: string, callId: string, name: string, input: Record<string, unknown>) {
    // A replayed stream repeats tool.request; only answer calls still waiting after the replay batch.
    const item = get().turns[turnId]?.items.find((i) => i.kind === 'tool' && i.callId === callId)
    if (clientCallsHandled.has(callId) || !item || item.kind !== 'tool' || item.status !== 'waiting') return
    clientCallsHandled.add(callId)
    const result = await runClientTool(name, input)
    await api.toolResult(turnId, { callId, ...result }).catch(() => clientCallsHandled.delete(callId))
  }

  return {
    open: true,
    slots: { mail: emptySlot(), docs: emptySlot(), calendar: emptySlot() },
    turns: {},
    connection: {},
    error: null,

    setOpen: (open) => set({ open }),

    async load(app) {
      if (get().slots[app].loaded) return
      const { conversation, turns } = await api.currentConversation(app)
      set((s) => {
        const next = { ...s.turns }
        // Never overwrite a turn this tab is already streaming: the live copy is newer. An active
        // turn starts with an empty timeline, because its stream replays from the first event and
        // rebuilds it; seeding it from the REST copy as well would show every row twice.
        for (const dto of turns) if (!next[dto.id]) next[dto.id] = isActive(dto.status) ? liveShell(dto) : fromDto(dto)
        return { turns: next, slots: { ...s.slots, [app]: { conversationId: conversation?.id ?? null, turnIds: turns.map((t) => t.id), loaded: true } } }
      })
      for (const dto of turns) if (isActive(dto.status)) attach(dto.id)
    },

    async send(app, text) {
      const slot = get().slots[app]
      const workspace = useWorkspaceStore.getState()
      const clientContext =
        app === 'docs'
          ? { openDocument: workspace.documentContext() }
          : app === 'mail' && workspace.openMessageId
            ? { openMessage: workspace.openMessageId }
            : {}
      set({ error: null })
      const key = newKey()
      const input = { conversationId: slot.conversationId ?? undefined, app, text, clientContext }
      try {
        // A lost response is retried with the same key, so the server returns the turn it already created.
        const { turn } = await api.createTurn(input, key).catch((err) => {
          if (err instanceof ApiError && err.status === 0) return api.createTurn(input, key)
          throw err
        })
        set((s) => ({
          turns: { ...s.turns, [turn.id]: s.turns[turn.id] ?? { ...fromDto(turn), items: [] } },
          slots: { ...s.slots, [app]: { conversationId: turn.conversationId, turnIds: [...s.slots[app].turnIds.filter((id) => id !== turn.id), turn.id], loaded: true } },
        }))
        attach(turn.id)
      } catch (err) {
        if (err instanceof ApiError && err.code === 'TURN_IN_PROGRESS') {
          set({ error: 'The assistant is still working on your last request.' })
          const turnId = (err.details as { turnId?: string })?.turnId
          // Started elsewhere (another tab or device): fetch it so its events have a turn to land on.
          if (turnId && !get().turns[turnId]) {
            const { turn } = await api.turn(turnId)
            set((s) => ({
              turns: { ...s.turns, [turn.id]: liveShell(turn) },
              slots: { ...s.slots, [app]: { conversationId: turn.conversationId, turnIds: [...s.slots[app].turnIds.filter((id) => id !== turn.id), turn.id], loaded: true } },
            }))
          }
          if (turnId) attach(turnId)
          return
        }
        set({ error: err instanceof Error ? err.message : 'Could not send' })
      }
    },

    async cancel(turnId) {
      await api.cancelTurn(turnId).catch(() => undefined)
    },

    async decide(turnId, actionId, approve) {
      set((s) => {
        const turn = s.turns[turnId]
        if (!turn) return s
        return {
          turns: { ...s.turns, [turnId]: { ...turn, items: turn.items.map((i) => (i.kind === 'action' && i.action.actionId === actionId ? { ...i, status: 'submitting' as const } : i)) } },
        }
      })
      try {
        if (approve) await api.confirmAction(actionId)
        else await api.declineAction(actionId)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Could not record your decision' })
      }
    },

    newConversation(app) {
      set((s) => ({ slots: { ...s.slots, [app]: { conversationId: null, turnIds: [], loaded: true } }, error: null }))
    },

    applyEvents(turnId, events) {
      const requests: { callId: string; name: string; input: Record<string, unknown> }[] = []
      let wrote = false
      set((s) => {
        let turn = s.turns[turnId]
        if (!turn) return s
        for (const event of events) {
          turn = { ...reduce(turn, event.type, event.data), lastEventId: event.id ?? turn.lastEventId }
          if (event.type === 'tool.request') requests.push({ callId: String(event.data.callId), name: String(event.data.name), input: (event.data.input ?? {}) as Record<string, unknown> })
          if (event.type === 'tool.result' && event.data.ok && WRITE_TOOLS.has(String(event.data.name))) wrote = true
        }
        return { turns: { ...s.turns, [turnId]: turn } }
      })
      if (wrote) useWorkspaceStore.getState().bump()
      for (const r of requests) void answerClientTool(turnId, r.callId, r.name, r.input)
    },
  }
})
