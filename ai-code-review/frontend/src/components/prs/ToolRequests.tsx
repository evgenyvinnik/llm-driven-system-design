import { ToneIcon } from '@/components/shared/Chips'
import type { Run } from '@/types'

export function ToolRequests({ run }: { run: Run | undefined }) {
  if (!run || run.toolCalls.length === 0) return null
  return (
    <section aria-label="Tool requests" className="card p-4">
      <h2 className="panel-title mb-2">Tool requests from the model</h2>
      <ul className="space-y-1.5">
        {run.toolCalls.map((t, i) => (
          <li key={i} className="flex gap-2 text-sm">
            <span className="mt-0.5"><ToneIcon ok={t.allowed} /></span>
            <div className="min-w-0">
              <code className="code">{t.name}({t.input ? JSON.stringify(t.input) : ''})</code>
              <div className={`text-xs ${t.allowed ? 'text-slate-500' : 'font-medium text-rose-700'}`}>
                {t.allowed ? `Allowed, ${t.resultBytes} bytes at the pinned SHA` : `Denied (${t.denialReason?.replace(/_/g, ' ')}), and audited`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
