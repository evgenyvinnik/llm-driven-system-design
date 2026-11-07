/** Owner-only: sharing, new version upload and delete. */
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { TrashIcon, UploadIcon } from '@/components/icons'
import { usePoll } from '@/lib/use-poll'
import { ApiError, api } from '@/services/api'
import type { DocumentItem, Scope } from '@/types'

export function OwnerControls({ doc, onChange }: { doc: DocumentItem; onChange: () => void }) {
  const navigate = useNavigate()
  const groups = usePoll(() => api.groups(), 60_000)
  const file = useRef<HTMLInputElement>(null)
  const versionKey = useRef<{ name: string; key: string } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const value = doc.scope === 'group' ? `group:${doc.groupId}` : doc.scope

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Request failed' })
    } finally {
      setBusy(false)
    }
  }

  const share = (v: string) =>
    run(async () => {
      const [scope, groupId] = v.startsWith('group:') ? ['group', v.slice(6)] : [v, null]
      const res = await api.share(doc.id, scope as Scope, groupId)
      setNotice({ tone: 'ok', text: res.changed ? 'Sharing saved. It applies to the next question; index metadata syncs in the background.' : 'No change.' })
      onChange()
    })

  const uploadVersion = (f: File) =>
    run(async () => {
      // One key per chosen file: re-choosing the same file after a failure retries idempotently.
      if (versionKey.current?.name !== `${f.name}:${f.size}:${f.lastModified}`) versionKey.current = { name: `${f.name}:${f.size}:${f.lastModified}`, key: crypto.randomUUID() }
      const res = await api.uploadVersion(doc.id, f, versionKey.current.key)
      setNotice(res.unchanged ? { tone: 'warn', text: 'Unchanged: that file is identical to the latest version.' } : { tone: 'ok', text: `Version ${res.versionNo} uploaded. Answers use v${doc.currentVersionNo ?? '?'} until it is fully indexed.` })
      onChange()
    })

  const remove = () =>
    run(async () => {
      if (!window.confirm(`Delete "${doc.title}"? It disappears immediately; its files, chunks, embeddings and cached answers are then purged.`)) return
      await api.remove(doc.id)
      void navigate({ to: '/documents' })
    })

  const tone = notice?.tone === 'err' ? 'text-rose-800' : notice?.tone === 'warn' ? 'text-amber-800' : 'text-emerald-700'
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="label" htmlFor="sharing">Sharing</label>
          <select id="sharing" className="input !w-56" value={value} disabled={busy} onChange={(e) => void share(e.target.value)}>
            <option value="private">Private (only you)</option>
            {(groups.data?.groups ?? []).map((g) => (
              <option key={g.id} value={`group:${g.id}`}>
                Group: {g.name}
              </option>
            ))}
            <option value="org">Org-wide</option>
          </select>
        </div>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => file.current?.click()}>
          <UploadIcon className="h-3.5 w-3.5" /> Upload new version
        </button>
        <input ref={file} type="file" accept=".txt,.md,.markdown,.html,.htm" className="hidden" aria-label="New version file" onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void uploadVersion(f)
          e.target.value = ''
        }} />
        <button type="button" className="btn-danger" disabled={busy} onClick={() => void remove()}>
          <TrashIcon className="h-3.5 w-3.5" /> Delete
        </button>
      </div>
      {doc.staleIndexRows > 0 && (
        <p className="text-xs text-amber-800">
          Index metadata syncing ({doc.staleIndexRows} stale index rows). Access is already enforced from the source of truth.
        </p>
      )}
      {notice && <p className={`text-xs ${tone}`}>{notice.text}</p>}
    </div>
  )
}
