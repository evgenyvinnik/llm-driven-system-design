import { num, relativeTime } from '@/lib/format'
import type { AccountDetail } from '@/types'

const COUNT_LABELS: [string, string][] = [
  ['oauth', 'Entra ID (OAuth)'],
  ['accountKey', 'Account key'],
  ['sas', 'SAS'],
  ['anonymous', 'Anonymous'],
  ['legacyTls', 'TLS < 1.2'],
  ['http', 'Plain HTTP'],
  ['publicNetwork', 'From public IPs'],
]

export function EvidencePanel({ evidence }: { evidence: AccountDetail['evidence'] }) {
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-800">Usage evidence (StorageBlobLogs)</h2>
        {evidence && <span className="text-xs text-slate-400">computed {relativeTime(evidence.computedAt)}{evidence.stale ? ' · refresh pending' : ''}</span>}
      </div>
      {!evidence && <p className="mt-2 text-sm text-slate-500">Not computed yet.</p>}
      {evidence && !evidence.hasLogs && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">No diagnostic logs for this account. Absence of logs is not evidence of non-use: fix SA-07 first, then wait for a full window.</p>
      )}
      {evidence && evidence.hasLogs && (
        <>
          <p className="mt-1 text-xs text-slate-500">
            {evidence.windowDays} of {evidence.lookbackDays} days of logs available{evidence.windowDays < evidence.lookbackDays ? ' (logging started recently)' : ''} · {num(evidence.counts.total ?? 0)} requests
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className="flex justify-between border-b border-slate-50 py-0.5">
                <dt className="text-slate-500">{label}</dt>
                <dd className={`font-mono text-xs ${key !== 'oauth' && (evidence.counts[key] ?? 0) > 0 ? 'font-semibold text-orange-800' : 'text-slate-700'}`}>{num(evidence.counts[key] ?? 0)}</dd>
              </div>
            ))}
          </dl>
          <h3 className="panel-title mt-4">Top callers</h3>
          <table className="mt-1 w-full text-xs">
            <tbody className="divide-y divide-slate-50">
              {evidence.callers.slice(0, 6).map((c, i) => (
                <tr key={i}>
                  <td className="py-1 font-mono">{c.callerIp}</td>
                  <td className="py-1">{c.authType}{c.protocol === 'HTTP' ? ' · HTTP' : ''}{c.tlsVersion !== 'TLS 1.2' ? ` · ${c.tlsVersion}` : ''}</td>
                  <td className="truncate py-1 text-slate-500">{c.userAgent}</td>
                  <td className="py-1 text-right font-mono">{num(c.requests)}</td>
                  <td className="py-1 pl-2 text-right text-slate-400">{relativeTime(c.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
