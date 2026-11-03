import { useEffect, useLayoutEffect, useRef } from 'react'
import { PlusIcon, SparkleIcon, XIcon } from '@/components/icons'
import { isActive, useAssistantStore } from '@/stores/assistant-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { App } from '@/types'
import { Composer } from './Composer'
import { SuggestionChips } from './SuggestionChips'
import { TurnView } from './TurnView'

const APP_LABEL: Record<App, string> = { mail: 'Mail', docs: 'Docs', calendar: 'Calendar' }

function ContextLine({ app }: { app: App }) {
  const doc = useWorkspaceStore((s) => s.openDocument)
  const selection = useWorkspaceStore((s) => s.selection)
  const message = useWorkspaceStore((s) => s.openMessageId)
  if (app === 'docs' && doc) return <span>Sees “{doc.title}”{selection.length ? ` · ${selection.length} selected` : ''}</span>
  if (app === 'mail' && message) return <span>Sees the open email</span>
  return <span>Acts as you, with your permissions</span>
}

export function AssistantPanel({ app }: { app: App }) {
  const slot = useAssistantStore((s) => s.slots[app])
  const turns = useAssistantStore((s) => s.turns)
  const error = useAssistantStore((s) => s.error)
  const connection = useAssistantStore((s) => s.connection)
  const { load, send, cancel, newConversation, setOpen } = useAssistantStore.getState()
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  useEffect(() => {
    void load(app).catch(() => undefined)
  }, [app, load])

  const visible = slot.turnIds.map((id) => turns[id]).filter(Boolean)
  const activeTurn = visible.find((t) => isActive(t.status))
  const lastItems = visible[visible.length - 1]?.items.length ?? 0
  const lastText = JSON.stringify(visible[visible.length - 1]?.items.at(-1) ?? null).length

  // Follow the stream only while the reader is at the bottom; keep their place if they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [visible.length, lastItems, lastText])

  return (
    <aside className="flex h-full w-[400px] shrink-0 flex-col border-l border-slate-200 bg-slate-50" aria-label="Assistant">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <SparkleIcon className="h-4 w-4 text-accent-600" /> Assistant <span className="chip bg-slate-100 text-slate-500">{APP_LABEL[app]}</span>
          </div>
          <div className="text-[11px] text-slate-400">
            <ContextLine app={app} />
          </div>
        </div>
        <div className="flex gap-1">
          <button type="button" className="btn-ghost px-2" onClick={() => newConversation(app)} title="New conversation" aria-label="New conversation">
            <PlusIcon />
          </button>
          <button type="button" className="btn-ghost px-2" onClick={() => setOpen(false)} title="Close" aria-label="Close assistant">
            <XIcon />
          </button>
        </div>
      </header>
      <div
        ref={scroller}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {visible.length === 0 && (
          <div className="space-y-3">
            <p className="text-[13px] text-slate-600">Ask about your mail, documents and calendar, or have me draft, edit and schedule. I&apos;ll ask before anything leaves your account.</p>
            <SuggestionChips app={app} onPick={(text) => void send(app, text)} />
          </div>
        )}
        {visible.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
        {/* Screen readers hear that an answer finished or needs a decision, not every streamed token. */}
        <div className="sr-only" aria-live="polite">
          {visible.at(-1)?.status === 'waiting_confirmation'
            ? 'The assistant needs your confirmation before it continues.'
            : visible.at(-1) && !isActive(visible.at(-1)!.status)
              ? 'The assistant finished answering.'
              : ''}
        </div>
      </div>
      {activeTurn && connection[activeTurn.id] === 'reconnecting' && (
        <div className="border-t border-slate-200 bg-slate-100 px-4 py-1.5 text-xs text-slate-600">Connection lost. Reconnecting without losing your answer…</div>
      )}
      {error && <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">{error}</div>}
      <Composer
        busy={!!activeTurn}
        onSend={(text) => void send(app, text)}
        onStop={() => activeTurn && void cancel(activeTurn.id)}
        placeholder={app === 'docs' ? 'Ask about or edit this document…' : app === 'calendar' ? 'Ask about your schedule…' : 'Ask about your mail…'}
      />
    </aside>
  )
}
