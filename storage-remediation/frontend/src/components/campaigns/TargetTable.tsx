import { Link } from '@tanstack/react-router'
import { StateBadge } from '@/components/shared'
import { relativeTime, valueText } from '@/lib/format'
import type { CampaignTarget } from '@/types'

export function TargetTable({ targets }: { targets: CampaignTarget[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-800">Recently updated accounts</div>
      <table className="w-full" aria-label="Targets">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Account</th>
            <th className="th">State</th>
            <th className="th">Change</th>
            <th className="th">Detail</th>
            <th className="th">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {targets.map((t) => (
            <tr key={t.id}>
              <td className="td">
                <Link to="/accounts/$name" params={{ name: t.accountName }} className="font-mono text-[13px] text-accent-700 hover:underline">{t.accountName}</Link>
                <div className="text-xs text-slate-500">W{t.waveNo} · {t.environment}</div>
              </td>
              <td className="td"><StateBadge state={t.state} /></td>
              <td className="td font-mono text-xs">
                {t.beforeValue === null ? '—' : t.state === 'rolled_back' ? `${valueText(t.beforeValue)} → ${valueText(t.afterValue)} → ${valueText(t.beforeValue)} (restored)` : `${valueText(t.beforeValue)} → ${valueText(t.afterValue ?? '…')}`}
              </td>
              <td className="td max-w-md text-xs text-slate-600">
                {t.rollbackReason ?? t.lastError ?? (t.writeOutcome && t.writeOutcome !== 'written' ? t.writeOutcome.replaceAll('_', ' ') : t.state === 'baking' && t.bakeUntil ? `bake ends ${relativeTime(t.bakeUntil)}` : '')}
              </td>
              <td className="td text-xs text-slate-500">{relativeTime(t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
