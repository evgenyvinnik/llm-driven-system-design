import { Link } from '@tanstack/react-router'
import { XIcon } from '@/components/icons'
import { useToasts } from '@/stores/toast-store'

const TONES = {
  info: 'border-slate-200',
  success: 'border-emerald-300',
  error: 'border-red-300',
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={`card pointer-events-auto flex items-start gap-2 border-l-4 p-3 shadow-lg ${TONES[t.tone]}`}>
          <div className="flex-1 text-sm text-slate-800">
            {t.message}
            {t.promptId && (
              <Link
                to="/prompts/$promptId"
                params={{ promptId: t.promptId }}
                search={{ run: t.runId }}
                className="ml-1 font-medium text-accent-700 underline"
                onClick={() => dismiss(t.id)}
              >
                View
              </Link>
            )}
          </div>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
