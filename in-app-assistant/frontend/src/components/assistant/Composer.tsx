import { useState, type KeyboardEvent } from 'react'
import { SendIcon, StopIcon } from '@/components/icons'

export function Composer({ busy, onSend, onStop, placeholder }: { busy: boolean; onSend: (text: string) => void; onStop: () => void; placeholder: string }) {
  const [text, setText] = useState('')
  const submit = () => {
    const value = text.trim()
    if (!value || busy) return
    onSend(value)
    setText('')
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="border-t border-slate-200 bg-white p-3">
      <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-100">
        <textarea
          aria-label="Message the assistant"
          name="assistant-input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none bg-transparent text-[13.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
        {busy ? (
          <button type="button" onClick={onStop} className="btn-secondary h-8 px-2" title="Stop" aria-label="Stop">
            <StopIcon className="h-4 w-4" />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={!text.trim()} className="btn-primary h-8 px-2" title="Send" aria-label="Send">
            <SendIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-slate-400">The assistant can make mistakes. It asks before sending anything.</p>
    </div>
  )
}
