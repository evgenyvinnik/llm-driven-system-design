import { createFileRoute } from '@tanstack/react-router'
import { ParamsForm } from '@/components/prices/ParamsForm'
import { PriceTable } from '@/components/prices/PriceTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { simTime } from '@/lib/format'
import { useRefresh } from '@/lib/use-refresh'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/prices')({ component: Prices })

function Prices() {
  const role = useAuthStore((s) => s.user?.role)
  const tick = useLiveStore((s) => s.ticks.price)
  const options = useRefresh(() => api.fuelOptions(), { triggers: [tick] })
  const params = useRefresh(() => api.params())
  const isAdmin = role === 'admin'
  if (!options.data) return options.error ? <ErrorNote message={options.error} /> : <Loading />
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Prices and model</h1>
        <p className="text-sm text-slate-500">{isAdmin ? 'Changing a price or closing a facility re-plans every train still heading through it.' : 'Read-only: admins change prices and parameters.'}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <PriceTable options={options.data.options} editable={isAdmin} onChanged={options.reload} />
        <div className="space-y-4">
          {params.data && <ParamsForm params={params.data.params} editable={isAdmin} onSaved={params.reload} />}
          <div className="card p-4">
            <div className="panel-title mb-2">Recent price changes</div>
            <ul className="space-y-1.5 text-sm">
              {options.data.history.slice(0, 12).map((h, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="text-slate-700">
                    {h.optionId} → <span className="num">${h.pricePerGal.toFixed(2)}</span>
                    <span className="ml-1 text-xs text-slate-500">{h.note}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">
                    {h.changedBy} · {simTime(h.effectiveAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
