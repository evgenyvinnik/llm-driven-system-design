import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon, TrashIcon, XIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared'
import { timeAgo } from '@/lib/format'
import { api, ApiError } from '@/services/api'
import type { Share } from '@/types'

export type ShareTarget = { kind: 'run'; runId: string } | { kind: 'version'; version: number }

interface Props {
  promptId: string
  target: ShareTarget
  onClose: () => void
}

/** Creates a read-only link to one immutable version or finished run, and lists links to revoke. */
export function ShareDialog({ promptId, target, onClose }: Props) {
  const [created, setCreated] = useState<Share | null>(null)
  const [shares, setShares] = useState<Share[]>([])
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creating, setCreating] = useState(false)

  // Listing is safe to repeat; creating a link is a deliberate click, never an effect.
  useEffect(() => {
    let cancelled = false
    api
      .listShares(promptId)
      .then((res) => !cancelled && setShares(res.shares))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [promptId])

  async function create() {
    setCreating(true)
    setError(null)
    try {
      const { share } = await api.createShare(promptId, target)
      setCreated(share)
      setShares((prev) => [{ ...share, createdBy: 'You', createdAt: new Date().toISOString() }, ...prev])
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link')
    } finally {
      setCreating(false)
    }
  }

  const url = created ? `${window.location.origin}${created.path}` : ''

  async function revoke(token: string) {
    await api.revokeShare(token)
    setShares((prev) => prev.filter((s) => s.token !== token))
    if (created?.token === token) setCreated(null)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 px-4" onClick={onClose}>
      <div className="card w-full max-w-lg p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">
            Share {target.kind === 'run' ? 'this run' : `version ${target.version}`}
          </h2>
          <button className="btn-ghost px-1.5" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Anyone with the link can view {target.kind === 'run' ? 'the prompt, inputs, settings and output of this run' : 'this version of the prompt'}.
          It never changes, even if the prompt is edited later.
        </p>
        {error && <ErrorNote message={error} />}
        {!created && (
          <button className="btn-primary" onClick={() => void create()} disabled={creating}>
            {creating ? 'Creating…' : 'Create link'}
          </button>
        )}
        {created && (
          <div className="flex gap-2">
            <input className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(url)
                setCopied(true)
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
        {shares.length > 0 && (
          <div className="mt-5">
            <div className="panel-title mb-2">Active links for this prompt</div>
            <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
              {shares.map((s) => (
                <li key={s.token} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <span className="font-mono text-slate-700">{s.kind === 'run' ? 'run' : `v${s.version}`}</span>
                  <span className="text-slate-500">
                    {s.createdBy} · {s.createdAt ? timeAgo(s.createdAt) : ''}
                  </span>
                  <button className="ml-auto flex items-center gap-1 text-red-700 hover:underline" onClick={() => void revoke(s.token)}>
                    <TrashIcon className="h-3 w-3" /> Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
