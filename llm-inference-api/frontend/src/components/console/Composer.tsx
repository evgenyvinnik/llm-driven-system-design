import { useState, type FormEvent } from 'react'
import { PlayIcon, StopIcon, UnplugIcon } from '@/components/icons'
import { useConsoleStore } from '@/stores/console-store'
import type { Mode } from '@/types'
import { KeyPicker } from './KeyPicker'
import { SYSTEM_PRESETS } from './presets'

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'stream', label: 'Stream', hint: 'Tokens over SSE. Closing the connection cancels.' },
  { id: 'sync', label: 'Sync', hint: 'One JSON response. Cancel closes the connection, which cancels the request.' },
  { id: 'async', label: 'Async', hint: '202 + id. The id owns the work: detach and fetch later, or cancel by id.' },
]

export function Composer() {
  const run = useConsoleStore((s) => s.run)
  const submit = useConsoleStore((s) => s.submit)
  const cancel = useConsoleStore((s) => s.cancel)
  const detach = useConsoleStore((s) => s.detach)
  const keyId = useConsoleStore((s) => s.keyId)
  const [mode, setMode] = useState<Mode>('stream')
  const [priority, setPriority] = useState<'auto' | 'interactive' | 'batch'>('auto')
  const [preset, setPreset] = useState('support')
  const [message, setMessage] = useState('How do I reset the arm after a torque fault?')
  const [maxTokens, setMaxTokens] = useState(256)
  const [outputTokens, setOutputTokens] = useState(60)
  const active = run.phase === 'submitting' || run.phase === 'queued' || run.phase === 'running'

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    const system = SYSTEM_PRESETS.find((p) => p.id === preset)?.text ?? ''
    void submit({
      mode,
      model: 'mock-large',
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      ...(priority !== 'auto' ? { priority } : {}),
      messages: [{ role: 'user', content: message }],
      metadata: { mock_output_tokens: outputTokens },
    })
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-4" aria-label="New request">
      <KeyPicker />
      <div>
        <span className="label">Mode</span>
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5" role="radiogroup" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'seg-on' : 'seg'} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">{MODES.find((m) => m.id === mode)?.hint}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="priority">Priority lane</label>
          <select id="priority" className="input" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            <option value="auto">Auto ({mode === 'async' ? 'bulk' : 'interactive'})</option>
            <option value="interactive">Interactive</option>
            <option value="batch">Bulk</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="preset">System prompt</label>
          <select id="preset" className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {SYSTEM_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="message">Message</label>
        <textarea id="message" name="message" className="input min-h-[72px]" value={message} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="max-tokens">max_tokens (reserved)</label>
          <input id="max-tokens" type="number" min={1} max={4096} className="input" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="out-tokens">Mock output length</label>
          <input id="out-tokens" type="number" min={1} max={4096} className="input" value={outputTokens} onChange={(e) => setOutputTokens(Number(e.target.value))} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={!keyId || active || !message.trim()}>
          <PlayIcon className="h-4 w-4" variant="solid" /> Send request
        </button>
        {active && (
          <button type="button" className="btn-danger" onClick={() => void cancel()}>
            <StopIcon className="h-4 w-4" /> Cancel
          </button>
        )}
        {active && run.mode === 'async' && run.requestId && (
          <button type="button" className="btn-secondary" onClick={detach}>
            <UnplugIcon className="h-4 w-4" /> Detach
          </button>
        )}
        {run.phase === 'detached' && run.requestId && (
          <button type="button" className="btn-danger" onClick={() => void cancel()}>
            <StopIcon className="h-4 w-4" /> Cancel by id
          </button>
        )}
      </div>
    </form>
  )
}
