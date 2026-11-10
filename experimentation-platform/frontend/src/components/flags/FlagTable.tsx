import { Link } from '@tanstack/react-router'
import { ChartIcon } from '@/components/icons'
import { KindChip, StatusChip } from '@/components/shared/StatusChip'
import { WeightsBar } from '@/components/shared/WeightsBar'
import { pctBuckets, timeAgo } from '@/lib/format'
import type { Flag } from '@/types'

export function FlagTable({ flags, env }: { flags: Flag[]; env: string }) {
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="Flags and experiments">
        <thead className="border-b border-slate-200 bg-slate-50">
          <tr>
            <th className="th">Key</th>
            <th className="th">Kind · unit</th>
            <th className="th">Status ({env})</th>
            <th className="th w-64">Allocation</th>
            <th className="th">Targeting</th>
            <th className="th">Version</th>
            <th className="th" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {flags.map((f) => {
            const cfg = f.configs[env]
            const enrolled = cfg ? Object.values(cfg.weights).reduce((a, b) => a + b, 0) : 0
            return (
              <tr key={f.key} className="hover:bg-slate-50" data-flag={f.key}>
                <td className="td">
                  <Link to="/flags/$key" params={{ key: f.key }} className="font-mono text-sm font-semibold text-accent-700 hover:underline">
                    {f.key}
                  </Link>
                  <div className="text-xs text-slate-500">{f.name}</div>
                </td>
                <td className="td">
                  <div className="flex items-center gap-1.5">
                    <KindChip kind={f.kind} />
                    <span className="chip bg-slate-100 text-slate-600">{f.unitType}</span>
                  </div>
                </td>
                <td className="td">{cfg ? <StatusChip status={cfg.status} /> : '—'}</td>
                <td className="td">
                  {cfg && (
                    <div className="space-y-1">
                      <WeightsBar allocation={cfg.allocation} variants={f.variants.map((v) => v.key)} height="h-2.5" />
                      <div className="num text-[11px] text-slate-500">
                        {f.variants
                          .filter((v) => (cfg.weights[v.key] ?? 0) > 0)
                          .map((v) => `${v.key} ${pctBuckets(cfg.weights[v.key])}`)
                          .join(' · ') || 'nobody'}
                        {enrolled < 10_000 && ` · ${pctBuckets(10_000 - enrolled)} not enrolled`}
                      </div>
                    </div>
                  )}
                </td>
                <td className="td text-xs text-slate-500">{cfg ? `${cfg.rules.length} rule${cfg.rules.length === 1 ? '' : 's'}, else ${cfg.fallthrough}` : '—'}</td>
                <td className="td num text-xs text-slate-500">
                  v{cfg?.version ?? '—'}
                  <div>{cfg ? timeAgo(cfg.updatedAt) : ''}</div>
                </td>
                <td className="td text-right">
                  {f.kind === 'experiment' && (
                    <Link to="/flags/$key/results" params={{ key: f.key }} className="btn-ghost text-xs">
                      <ChartIcon className="h-3.5 w-3.5" /> Results
                    </Link>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
