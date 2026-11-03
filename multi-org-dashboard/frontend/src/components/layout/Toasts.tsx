import { Link } from '@tanstack/react-router'
import { XIcon } from '@/components/icons'
import { useToasts } from '@/stores/toast-store'

const TONE = {
  info: 'border-slate-200',
  success: 'border-emerald-300',
  warning: 'border-amber-300',
  error: 'border-red-300',
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`card flex items-start gap-3 border-l-4 p-3 shadow-md ${TONE[t.tone]}`} data-testid="toast">
          <div className="flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs text-slate-600">{t.body}</p>}
            {t.action?.href && (
              <a href={t.action.href} className="mt-1 inline-block text-xs font-medium text-brand-700 underline">
                {t.action.label}
              </a>
            )}
            {t.action?.to && (
              <Link to={t.action.to} className="mt-1 inline-block text-xs font-medium text-brand-700 underline">
                {t.action.label}
              </Link>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-600" aria-label="Dismiss">
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  )
}
