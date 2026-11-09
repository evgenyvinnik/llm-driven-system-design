import { Chip } from '@/components/shared/Chips'
import type { MoveChange } from '@/types'

const TYPE: Record<MoveChange['type'], { kind: 'good' | 'warn' | 'bad' | 'info' | 'muted'; label: string }> = {
  kept: { kind: 'muted', label: 'kept' },
  changed: { kind: 'warn', label: 'changed' },
  reordered: { kind: 'info', label: 'reordered' },
  added: { kind: 'good', label: 'added' },
  removed: { kind: 'bad', label: 'removed' },
}

function summary(c: MoveChange['before']): string {
  return c ? `${c.carCount} cars ${c.fromTrackId ?? 'main'} → ${c.toTrackId}${c.outboundId ? ` (${c.outboundId})` : ''}` : '–'
}

export function DiffTable({ changes }: { changes: MoveChange[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full" aria-label="Moves changed">
        <thead>
          <tr>
            <th className="th">Change</th>
            <th className="th">Move</th>
            <th className="th">Before</th>
            <th className="th">After</th>
            <th className="th">Why</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.key} className="border-t border-slate-100">
              <td className="td"><Chip kind={TYPE[c.type].kind}>{TYPE[c.type].label}</Chip></td>
              <td className="td font-mono text-xs">{c.key}</td>
              <td className="td text-xs">{summary(c.before)}</td>
              <td className="td text-xs">{summary(c.after)}</td>
              <td className="td">{c.why}</td>
            </tr>
          ))}
          {changes.length === 0 && (
            <tr><td className="td text-slate-500" colSpan={5}>No moves changed.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
