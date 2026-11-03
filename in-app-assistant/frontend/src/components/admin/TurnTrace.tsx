import { useEffect, useState } from 'react'
import { describeStep } from '@/components/assistant/StepsList'
import { XIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { AdminTurnDetail } from '@/types'

const KIND_STYLE: Record<string, string> = {
  model_call: 'bg-violet-100 text-violet-700',
  tool_call: 'bg-sky-100 text-sky-700',
  policy: 'bg-amber-100 text-amber-800',
  notice: 'bg-slate-100 text-slate-600',
  wrap_up: 'bg-amber-100 text-amber-800',
  prefetch: 'bg-teal-100 text-teal-700',
  compaction: 'bg-slate-100 text-slate-600',
}

/** One turn's full trace: every model call, tool call and policy decision, plus the saved conversation. */
export function TurnTrace({ turnId, onClose }: { turnId: string; onClose: () => void }) {
  const [data, setData] = useState<AdminTurnDetail | null>(null)
  const [showMessages, setShowMessages] = useState(false)
  useEffect(() => {
    setData(null)
    api.adminTurn(turnId).then(setData)
  }, [turnId])
  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-[620px] flex-col border-l border-slate-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="font-semibold text-slate-900">Turn trace</h2>
        <button type="button" className="btn-ghost px-1.5" onClick={onClose} aria-label="Close"><XIcon /></button>
      </div>
      {!data ? <Loading /> : (
        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          <div>
            <div className="text-slate-900">“{data.turn.userText}”</div>
            <div className="text-xs text-slate-400">
              {data.turn.status} · {data.turn.steps} model calls · {(data.turn.activeMs / 1000).toFixed(1)}s active · {data.turn.model ?? '—'}
              {data.turn.tainted && ' · read untrusted content'}
            </div>
          </div>
          <ol className="space-y-1.5">
            {data.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <span className="w-6 shrink-0 text-right tabular-nums text-slate-300">{s.step}</span>
                <span className={`chip shrink-0 px-1.5 py-0 text-[10px] ${KIND_STYLE[s.kind]}`}>{s.kind.replace('_', ' ')}</span>
                <span className="min-w-0 break-words text-slate-700">
                  {describeStep(s)}
                  {s.kind === 'policy' && typeof s.detail.reason === 'string' && <span className="block text-slate-400">{s.detail.reason}</span>}
                  {s.kind === 'tool_call' && s.detail.args !== undefined && <code className="block truncate text-[10px] text-slate-400">{JSON.stringify(s.detail.args)}</code>}
                </span>
                <span className="ml-auto shrink-0 text-right tabular-nums text-slate-400">
                  {s.latencyMs !== null && `${s.latencyMs}ms`}
                  {s.inputTokens !== null && <span className="block">{s.inputTokens} in{s.cacheReadTokens ? ` (${s.cacheReadTokens} cached)` : ''} / {s.outputTokens} out</span>}
                </span>
              </li>
            ))}
          </ol>
          {data.actions.length > 0 && (
            <div>
              <div className="panel-title mb-1">Confirmations</div>
              {data.actions.map((a) => (
                <div key={a.id} className="text-xs text-slate-600">{a.tool} → <span className="font-medium">{a.status}</span>{a.tainted && ' (after untrusted content)'} · {a.reason}</div>
              ))}
            </div>
          )}
          {data.turn.finalText && (
            <div>
              <div className="panel-title mb-1">Answer</div>
              <p className="whitespace-pre-line text-xs text-slate-700">{data.turn.finalText}</p>
            </div>
          )}
          <div>
            <button type="button" className="btn-secondary text-xs" onClick={() => setShowMessages((v) => !v)}>{showMessages ? 'Hide' : 'Show'} the conversation as the model saw it</button>
            {showMessages && <pre className="mt-2 max-h-[480px] overflow-auto rounded-md bg-slate-900 p-3 text-[10px] leading-snug text-slate-100">{JSON.stringify(data.turn.messages, null, 2)}</pre>}
          </div>
        </div>
      )}
    </div>
  )
}
