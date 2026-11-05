import { Link } from '@tanstack/react-router'
import { CampaignStatusBadge } from '@/components/shared'
import { num, relativeTime } from '@/lib/format'
import type { Campaign } from '@/types'

export function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  if (campaigns.length === 0) return <div className="card p-8 text-center text-sm text-slate-500">No campaigns yet.</div>
  return (
    <div className="card overflow-hidden">
      <table className="w-full" aria-label="Campaigns">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">Campaign</th>
            <th className="th">Status</th>
            <th className="th">Progress</th>
            <th className="th text-right">Rolled back</th>
            <th className="th text-right">Failed</th>
            <th className="th">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {campaigns.map((c) => {
            const counts = c.counts
            const done = counts ? counts.verified + counts.rolled_back + counts.failed + counts.skipped + counts.escalated + counts.cancelled : 0
            return (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link to="/campaigns/$campaignId" params={{ campaignId: c.id }} className="font-medium text-accent-700 hover:underline">{c.name}</Link>
                  <div className="text-xs text-slate-500"><span className="font-mono">{c.controlId}</span>{c.selfService ? ' · self-service' : ''} · by {c.createdBy}</div>
                </td>
                <td className="td">
                  <CampaignStatusBadge status={c.status} />
                  {c.currentWave && c.status !== 'completed' && <div className="text-xs text-slate-500">wave {c.currentWave} of {c.waveCount}</div>}
                </td>
                <td className="td">
                  {counts && (
                    <>
                      <div className="h-1.5 w-36 rounded-full bg-accent-100"><div className="h-1.5 rounded-full bg-accent-600" style={{ width: `${counts.total ? (done / counts.total) * 100 : 0}%` }} /></div>
                      <div className="text-xs text-slate-500">{num(counts.verified)} verified of {num(counts.total)}</div>
                    </>
                  )}
                </td>
                <td className="td text-right">{num(counts?.rolled_back ?? 0)}</td>
                <td className="td text-right">{num(counts?.failed ?? 0)}</td>
                <td className="td text-xs text-slate-500">{relativeTime(c.createdAt)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
