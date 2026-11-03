import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useUi } from '@/stores/ui-store'

/**
 * The single polite live region. Completion is announced once ("Response
 * complete."), instead of making the streaming text itself a live region.
 * The text is cleared and re-set so repeated messages are announced again.
 */
export function LiveAnnouncer() {
  const announcement = useUi((s) => s.announcement)
  const [text, setText] = useState('')
  useEffect(() => {
    setText('')
    const t = setTimeout(() => setText(announcement.text), 50)
    return () => clearTimeout(t)
  }, [announcement])
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="live-announcer">
      {text}
    </div>
  )
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-sm ${
            t.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : t.tone === 'success'
                ? 'border-accent-200 bg-accent-50 text-accent-700'
                : 'border-slate-200 bg-white text-slate-700'
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span>{t.message}</span>
            <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
          {t.conversationId && (
            <Link
              to="/c/$conversationId"
              params={{ conversationId: t.conversationId }}
              className="mt-1 inline-block text-xs font-medium underline"
              onClick={() => dismiss(t.id)}
            >
              Open
            </Link>
          )}
        </div>
      ))}
    </div>
  )
}
