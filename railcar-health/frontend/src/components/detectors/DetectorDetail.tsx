import { LateBadge } from '@/components/shared/Badges'
import { Loading } from '@/components/shared/Loading'
import { signed, timeText } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'

export function DetectorDetail({ id, revision }: { id: string; revision: number }) {
  const { data } = useFetch(() => api.detector(id), [id, revision])
  if (!data) return <Loading />
  return (
    <div className="space-y-4 text-sm">
      <div>
        <div className="panel-title mb-1">Recent trains</div>
        <ul className="space-y-1">
          {data.recentPasses.map((p) => (
            <li key={p.passId} className="flex items-center gap-2">
              <span className="font-mono">{p.symbol ?? '—'}</span>
              <span className="text-xs text-slate-500">{timeText(p.passedAt)} · train median {p.medianAboveAmbient ?? '—'}°F above ambient</span>
              {p.late && <LateBadge lagSeconds={p.lagSeconds} />}
            </li>
          ))}
          {data.recentPasses.length === 0 && <li className="text-slate-500">No trains recorded.</li>}
        </ul>
      </div>
      <div>
        <div className="panel-title mb-1">Bias samples (this detector minus neighbours, same train)</div>
        <div className="flex flex-wrap gap-1.5">
          {data.biasSamples.map((s) => <span key={s.tripId} className="chip bg-slate-100 text-slate-700">{signed(s.sampleF)}°F</span>)}
          {data.biasSamples.length === 0 && <span className="text-slate-500">None yet.</span>}
        </div>
      </div>
      {data.missedTrains.length > 0 && (
        <div>
          <div className="panel-title mb-1">Trains seen on both sides but not here</div>
          <p className="font-mono text-xs text-slate-700">{data.missedTrains.map((m) => m.symbol).join(', ')}</p>
        </div>
      )}
    </div>
  )
}
