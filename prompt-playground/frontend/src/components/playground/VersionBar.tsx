import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronLeftIcon, SaveIcon, ShareIcon } from '@/components/icons'
import { timeAgo } from '@/lib/format'
import type { PromptDetail } from '@/types'

interface Props {
  detail: PromptDetail
  dirty: boolean
  saving: boolean
  onLoadVersion: (version: number) => void
  onSave: (message: string) => Promise<boolean>
  onShareVersion: () => void
}

export function VersionBar({ detail, dirty, saving, onLoadVersion, onSave, onShareVersion }: Props) {
  const { prompt, versions } = detail
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (await onSave(message.trim())) {
      setComposing(false)
      setMessage('')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-5 py-2.5">
      <Link to="/" className="btn-ghost px-1.5" aria-label="All prompts">
        <ChevronLeftIcon />
      </Link>
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-slate-900">{prompt.title}</h1>
        <p className="truncate text-xs text-slate-500">
          {prompt.headVersion > 0
            ? `v${prompt.headVersion} saved ${timeAgo(versions[0]?.createdAt ?? prompt.updatedAt)} by ${versions[0]?.createdBy ?? prompt.updatedBy.displayName}`
            : 'No saved versions yet'}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {versions.length > 0 && (
          <select
            className="input w-40 py-1 text-xs"
            value=""
            onChange={(e) => e.target.value && onLoadVersion(Number(e.target.value))}
            aria-label="Load a version into the editor"
          >
            <option value="">Load version…</option>
            {versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} · {v.message || 'no message'} · {v.createdBy}
              </option>
            ))}
          </select>
        )}
        {dirty ? (
          <span className="chip bg-amber-50 text-amber-800">● Unsaved changes</span>
        ) : (
          prompt.headVersion > 0 && <span className="chip bg-emerald-50 text-emerald-700">Saved as v{prompt.headVersion}</span>
        )}
        {composing ? (
          <form onSubmit={submit} className="flex items-center gap-1.5">
            <input
              className="input w-56 py-1 text-xs"
              placeholder="What changed? (optional)"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
              maxLength={500}
            />
            <button className="btn-primary py-1 text-xs" disabled={saving}>
              Save v{prompt.headVersion + 1}
            </button>
            <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="btn-secondary py-1 text-xs" onClick={() => setComposing(true)} disabled={!dirty}>
            <SaveIcon className="h-3.5 w-3.5" /> Save version
          </button>
        )}
        {prompt.headVersion > 0 && (
          <button className="btn-ghost py-1 text-xs" onClick={onShareVersion} title={`Share v${prompt.headVersion}`}>
            <ShareIcon className="h-3.5 w-3.5" /> Share v{prompt.headVersion}
          </button>
        )}
      </div>
    </div>
  )
}
