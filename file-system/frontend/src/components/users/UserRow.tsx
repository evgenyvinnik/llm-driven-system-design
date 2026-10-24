import { useState } from 'react'
import { ArchiveIcon, RotateCcwIcon } from '@/components/icons'
import { formatBytes, timeAgo } from '@/lib/format'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import type { RestoreResult, UserSummary } from '@/types'
import { QuotaBar } from './QuotaBar'

interface UserRowProps {
  user: UserSummary
  onChanged: () => void
  onRestored: (result: RestoreResult) => void
}

export function UserRow({ user, onChanged, onRestored }: UserRowProps) {
  const push = useToasts((s) => s.push)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function backup() {
    setBusy(true)
    try {
      const { fileCount } = await api.backupUser(user.id)
      push('success', `Backed up ${fileCount} of ${user.id}'s files`)
      onChanged()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    setBusy(true)
    try {
      onRestored(await api.restoreUser(user.id))
      setConfirming(false)
      onChanged()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="border-t border-slate-100" data-user={user.id}>
      <td className="td whitespace-nowrap font-mono font-medium text-slate-900">{user.id}</td>
      <td className="td w-72">
        <QuotaBar used={user.used} capacity={user.capacity} />
      </td>
      <td className="td tabular-nums text-slate-600">{user.fileCount}</td>
      <td className="td text-slate-600">
        {user.backup ? (
          <span>
            {user.backup.fileCount} files, {formatBytes(user.backup.bytes)}
            <span className="block text-xs text-slate-400">{timeAgo(user.backup.takenAt)}</span>
          </span>
        ) : (
          <span className="text-slate-400">No backup</span>
        )}
      </td>
      <td className="td text-right">
        {confirming ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-slate-500">Replace {user.id}&apos;s files with the backup?</span>
            <button className="btn-danger py-1" onClick={restore} disabled={busy}>
              Confirm restore
            </button>
            <button className="btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="inline-flex gap-1.5">
            <button className="btn-secondary py-1" onClick={backup} disabled={busy}>
              <ArchiveIcon /> Back up
            </button>
            <button className="btn-secondary py-1" onClick={() => setConfirming(true)} disabled={busy}>
              <RotateCcwIcon /> Restore
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}
