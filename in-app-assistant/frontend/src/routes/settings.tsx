import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Loading } from '@/components/shared/Loading'
import { api } from '@/services/api'
import type { AssistantSettings } from '@/types'

export const Route = createFileRoute('/settings')({ component: SettingsPage })

const TOGGLES: { key: keyof AssistantSettings; title: string; detail: string }[] = [
  { key: 'allowSend', title: 'Let the assistant send email', detail: 'When off, the send tool is not offered to the model at all, so it cannot even try.' },
  { key: 'allowDocEdits', title: 'Let the assistant edit documents', detail: 'When off, the insert and rewrite tools are hidden from the model.' },
  { key: 'confirmWrites', title: 'Confirm every change', detail: 'Ask before reversible changes too (drafts, tracked suggestions, events without guests). Sends always ask.' },
  { key: 'blockExternalAfterUntrusted', title: 'Block sending outside my organization after reading outside content', detail: 'Once a conversation has read an external email or someone else’s document, sends to outside addresses are refused instead of asking.' },
  { key: 'prefetch', title: 'Search before asking the model', detail: 'For questions that obviously need your data, fetch likely results up front to save a model round trip.' },
]

function SettingsPage() {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  useEffect(() => {
    api.settings().then((r) => setSettings(r.settings))
  }, [])
  const save = (patch: Partial<AssistantSettings>) => api.updateSettings(patch).then((r) => setSettings(r.settings))
  if (!settings) return <Loading />
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-semibold text-slate-900">Assistant settings</h1>
      <p className="mb-5 text-sm text-slate-500">The policy engine and the tool list read these on every request.</p>
      <div className="max-w-2xl space-y-3">
        {TOGGLES.map((t) => (
          <label key={t.key} className="card flex cursor-pointer items-start gap-3 p-4">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-teal-600" checked={Boolean(settings[t.key])} onChange={(e) => void save({ [t.key]: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium text-slate-900">{t.title}</span>
              <span className="block text-xs text-slate-500">{t.detail}</span>
            </span>
          </label>
        ))}
        <div className="card p-4">
          <label className="block text-sm font-medium text-slate-900" htmlFor="max-steps">Step limit: {settings.maxSteps} model calls per request</label>
          <p className="mb-2 text-xs text-slate-500">When it runs out, the assistant makes one last call with tools off and tells you what it did and what is left.</p>
          <input id="max-steps" type="range" min={1} max={30} value={settings.maxSteps} onChange={(e) => void save({ maxSteps: Number(e.target.value) })} className="w-full accent-teal-600" />
        </div>
      </div>
    </div>
  )
}
