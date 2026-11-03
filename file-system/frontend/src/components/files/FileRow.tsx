import { useState } from 'react'
import { CheckIcon, FileIcon, PencilIcon, TrashIcon, XIcon } from '@/components/icons'
import { OwnerChip, SizeInput } from '@/components/shared'
import { toBytes, type SizeUnit } from '@/lib/size'
import { formatBytes } from '@/lib/format'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import type { DirEntry } from '@/types'

interface FileRowProps {
  entry: DirEntry
  path: string
  onChanged: () => void
}

export function FileRow({ entry, path, onChanged }: FileRowProps) {
  const push = useToasts((s) => s.push)
  const [mode, setMode] = useState<'view' | 'resize' | 'delete'>('view')
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<SizeUnit>('KB')
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<string>) {
    setBusy(true)
    try {
      push('success', await fn())
      setMode('view')
      onChanged()
    } catch (err) {
      push('error', errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const resize = () => {
    const bytes = toBytes(amount, unit)
    if (bytes === null) return push('error', 'Enter a size of 0 or more')
    void act(async () => {
      const { previous } = await api.updateFile(path, bytes)
      return `${entry.name}: ${formatBytes(previous)} → ${formatBytes(bytes)}`
    })
  }

  const remove = () =>
    void act(async () => {
      const { size } = await api.deleteFile(path)
      return `Deleted ${entry.name} (${formatBytes(size)} freed)`
    })

  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="td">
        <span className="flex items-center gap-2 font-mono text-slate-800">
          <FileIcon className="h-4 w-4 text-slate-400" />
          {entry.name}
        </span>
      </td>
      <td className="td tabular-nums text-slate-700">
        {mode === 'resize' ? (
          <div className="flex w-56 items-center gap-1">
            <SizeInput id={`resize-${entry.name}`} amount={amount} unit={unit} onChange={(a, u) => (setAmount(a), setUnit(u))} />
            <button className="btn-ghost" onClick={resize} disabled={busy} aria-label="Save size">
              <CheckIcon />
            </button>
          </div>
        ) : (
          formatBytes(entry.size)
        )}
      </td>
      <td className="td text-slate-400">—</td>
      <td className="td">
        <OwnerChip owner={entry.owner} />
      </td>
      <td className="td text-right">
        {mode === 'delete' ? (
          <span className="inline-flex items-center gap-1">
            <button className="btn-danger py-1" onClick={remove} disabled={busy}>
              Delete
            </button>
            <button className="btn-ghost" onClick={() => setMode('view')} aria-label="Cancel">
              <XIcon />
            </button>
          </span>
        ) : (
          <span className="inline-flex gap-0.5">
            <button
              className="btn-ghost"
              onClick={() => (setMode(mode === 'resize' ? 'view' : 'resize'), setAmount(String(+(entry.size / 1024).toFixed(1))), setUnit('KB'))}
              aria-label={`Resize ${entry.name}`}
              title="Resize"
            >
              <PencilIcon />
            </button>
            <button className="btn-ghost hover:text-red-700" onClick={() => setMode('delete')} aria-label={`Delete ${entry.name}`} title="Delete">
              <TrashIcon />
            </button>
          </span>
        )}
      </td>
    </tr>
  )
}
