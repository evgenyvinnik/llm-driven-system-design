import { useEffect, useState } from 'react'
import { api } from '@/services/api'
import type { MockModelSettings } from '@/types'

const CHAOS_LABELS: Record<string, string> = {
  overloaded: '529 overloaded (primary only)',
  rate_limited: '429 rate limited (primary only)',
  midstream_disconnect: 'Drop the stream halfway',
  max_tokens_text: 'Cut a text reply at max_tokens',
  max_tokens_tool: 'Cut a tool call at max_tokens',
  invalid_tool_name: 'Invent a tool name',
  invalid_args: 'Send invalid arguments',
  repeat_call: 'Repeat the same call (loop)',
  refusal: 'Refuse',
}

/** The mock model's knobs: failures fire on the next N requests, on demand. */
export function ModelPanel() {
  const [state, setState] = useState<{ provider: string; settings: MockModelSettings | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => api.adminModel().then(setState).catch((e) => setError(e.message))
  useEffect(() => {
    void refresh()
  }, [])
  const update = (patch: Partial<MockModelSettings>) => api.adminUpdateModel(patch).then(() => refresh())
  if (error) return <div className="card p-3 text-sm text-red-600">{error}</div>
  if (!state) return null
  if (!state.settings) return <div className="card p-3 text-sm text-slate-600">Running against the real model ({state.provider}); failure switches only exist on the mock.</div>
  const s = state.settings
  return (
    <div className="card space-y-3 p-3">
      <div className="panel-title">Mock model</div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <label className="space-y-1">
          <span className="text-slate-500">Time to first token: {s.ttftMs} ms</span>
          <input type="range" min={0} max={4000} step={50} value={s.ttftMs} onChange={(e) => void update({ ttftMs: Number(e.target.value) })} className="w-full accent-teal-600" />
        </label>
        <label className="space-y-1">
          <span className="text-slate-500">Tokens per second: {s.tokensPerSecond}</span>
          <input type="range" min={5} max={400} step={5} value={s.tokensPerSecond} onChange={(e) => void update({ tokensPerSecond: Number(e.target.value) })} className="w-full accent-teal-600" />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" className="mt-0.5 accent-teal-600" checked={s.followInjectedInstructions} onChange={(e) => void update({ followInjectedInstructions: e.target.checked })} />
        <span>Gullible model: obey instructions found inside emails. Leave on to see the policy engine, not the model, stop the send.</span>
      </label>
      <div className="space-y-1">
        <div className="text-xs text-slate-500">Arm a failure for the next request(s)</div>
        {Object.entries(CHAOS_LABELS).map(([kind, label]) => (
          <div key={kind} className="flex items-center justify-between text-xs">
            <span className="text-slate-700">{label}</span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 text-right tabular-nums text-slate-400">{s.chaos[kind] ?? 0}</span>
              <button type="button" className="btn-secondary px-2 py-0.5 text-xs" onClick={() => void update({ chaos: { [kind]: (s.chaos[kind] ?? 0) + (kind === 'overloaded' ? 3 : kind === 'repeat_call' ? 6 : 1) } })}>Arm</button>
              <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => void update({ chaos: { [kind]: 0 } })}>Clear</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
