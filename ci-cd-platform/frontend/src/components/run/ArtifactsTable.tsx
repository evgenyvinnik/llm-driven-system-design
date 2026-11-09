import { BoxIcon, DownloadIcon } from '@/components/icons'
import { bytes, shortSha } from '@/lib/format'
import type { Artifact } from '@/types'

export function ArtifactsTable({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <table className="w-full" aria-label="Artifacts">
      <thead className="border-b border-slate-100">
        <tr>
          <th className="th">Artifact</th>
          <th className="th">From</th>
          <th className="th">Size</th>
          <th className="th">SHA-256</th>
          <th className="th">Retention</th>
          <th className="th" />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {artifacts.map((a) => (
          <tr key={a.id}>
            <td className="td">
              <span className="flex items-center gap-1.5 font-medium">
                <BoxIcon className="h-4 w-4 text-slate-400" /> {a.name}
              </span>
            </td>
            <td className="td text-xs">
              {a.jobKey}, attempt {a.attempt}
            </td>
            <td className="td num text-xs">{bytes(a.sizeBytes)}</td>
            <td className="td font-mono text-xs" title={a.sha256}>
              {shortSha(a.sha256)}
            </td>
            <td className="td text-xs">{a.expired ? <span className="text-slate-500">expired</span> : `${a.retentionDays} days, until ${new Date(a.expiresAt).toLocaleDateString()}`}</td>
            <td className="td text-right">
              {!a.expired && (
                <a className="btn-ghost !p-1" href={`/api/v1/artifacts/${a.id}/download`} title={`Download ${a.name}`} aria-label={`Download ${a.name}`}>
                  <DownloadIcon className="h-4 w-4" />
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
