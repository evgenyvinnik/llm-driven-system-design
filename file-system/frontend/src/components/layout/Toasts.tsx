import { CheckIcon, XIcon } from '@/components/icons'
import { useToasts } from '@/stores/toast-store'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`card flex items-start gap-2 px-3 py-2.5 text-sm shadow-lg ${toast.kind === 'error' ? 'border-red-200' : 'border-accent-200'}`}
        >
          <span className={toast.kind === 'error' ? 'text-red-600' : 'text-accent-600'}>
            {toast.kind === 'error' ? <XIcon /> : <CheckIcon />}
          </span>
          <p className="flex-1 text-slate-700">{toast.message}</p>
          <button className="text-slate-400 hover:text-slate-700" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
