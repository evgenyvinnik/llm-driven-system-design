import { useEffect, useRef, useState } from 'react'
import { SendIcon, StopIcon, WifiOffIcon } from '@/components/icons'
import { stopGeneration } from '@/services/chat-actions'
import { useCatalog } from '@/stores/catalog-store'
import { useConnectivity } from '@/stores/connectivity-store'
import { useGenerations } from '@/stores/generations-store'

interface Props {
  /** The generation being written in this conversation, if any: Send becomes Stop. */
  activeGenerationId?: string
  readOnlyReason?: string
  model: string
  onModelChange: (model: string) => void
  /** Resolves when the send settles; a failed send stays visible as a pending bubble with Retry. */
  onSend: (content: string) => Promise<unknown>
  placeholder?: string
  autoFocus?: boolean
}

export function Composer({ activeGenerationId, readOnlyReason, model, onModelChange, onSend, placeholder, autoFocus }: Props) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const online = useConnectivity((s) => s.online)
  const models = useCatalog((s) => s.models)
  const stopping = useGenerations((s) => (activeGenerationId ? s.byId[activeGenerationId]?.cancelRequested : false))
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the text up to a limit, like every chat app.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const disabledReason = !online ? 'You are offline. Sending is disabled until the connection is back.' : readOnlyReason
  const canSend = !disabledReason && !activeGenerationId && !sending && text.trim().length > 0

  const submit = async () => {
    if (!canSend) return
    const content = text
    setSending(true)
    // Clear right away; the pending bubble shows the text, and a failure keeps it there with Retry.
    setText('')
    await onSend(content)
    setSending(false)
    ref.current?.focus()
  }

  return (
    <div className="border-t border-slate-100 bg-white px-4 pb-4 pt-3">
      <div className="mx-auto max-w-3xl">
        {disabledReason && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-amber-700" role="status">
            <WifiOffIcon className="h-3.5 w-3.5" /> {disabledReason}
          </p>
        )}
        <form
          className="rounded-2xl border border-slate-300 bg-white shadow-sm focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-100"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <label htmlFor="composer" className="sr-only">
            Message
          </label>
          <textarea
            id="composer"
            ref={ref}
            rows={1}
            value={text}
            autoFocus={autoFocus}
            disabled={!!disabledReason}
            placeholder={placeholder ?? 'Message the assistant'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void submit()
              }
            }}
            className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between px-3 pb-2 pt-1">
            <label className="flex items-center gap-1 text-xs text-slate-500">
              <span className="sr-only">Model</span>
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                className="rounded border-none bg-transparent py-0.5 pr-6 text-xs text-slate-600 focus:ring-0"
              >
                {(models.length ? models : [{ id: model, label: model }]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {activeGenerationId ? (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50"
                onClick={() => void stopGeneration(activeGenerationId)}
                disabled={stopping}
                aria-label={stopping ? 'Stopping' : 'Stop generating'}
                title="Stop (cancels the request to the model and keeps the partial answer)"
              >
                <StopIcon className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="submit"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent-600 text-white hover:bg-accent-700 disabled:bg-slate-200 disabled:text-slate-400"
                disabled={!canSend}
                aria-label="Send message"
              >
                <SendIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>
        <p className="mt-1.5 text-center text-[11px] text-slate-400">
          Answers come from a simulated model. Enter to send, Shift+Enter for a new line.
        </p>
      </div>
    </div>
  )
}
