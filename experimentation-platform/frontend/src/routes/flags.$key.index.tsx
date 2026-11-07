import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { FlagDetails } from '@/components/editor/FlagDetails'
import { FlagHeader } from '@/components/editor/FlagHeader'
import { HistoryPanel } from '@/components/editor/HistoryPanel'
import { RulesEditor } from '@/components/editor/RulesEditor'
import { StatusPanel } from '@/components/editor/StatusPanel'
import { WeightsEditor } from '@/components/editor/WeightsEditor'
import { Loading } from '@/components/shared/Loading'
import { useFlag } from '@/lib/use-flag'
import { useCanEdit } from '@/stores/auth-store'
import { useEnvStore } from '@/stores/env-store'

export const Route = createFileRoute('/flags/$key/')({ component: FlagEditor })

function FlagEditor() {
  const { key } = Route.useParams()
  const env = useEnvStore((s) => s.env)
  const canEdit = useCanEdit()
  const { data: flag, error, reload } = useFlag(key)
  const [refreshKey, setRefreshKey] = useState(0)
  if (!flag) return error ? <main className="page text-sm text-rose-700">{error}</main> : <Loading />
  const cfg = flag.configs[env]
  const changed = () => {
    reload()
    setRefreshKey((n) => n + 1)
  }
  return (
    <div className="page max-w-7xl" data-ready="true">
      <FlagHeader flag={flag} env={env} tab="config" />
      {!cfg ? (
        <p className="text-sm text-slate-500">No configuration in {env}.</p>
      ) : (
        <>
          <StatusPanel flag={flag} env={env} canEdit={canEdit} onChanged={changed} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-4">
              <WeightsEditor key={`${env}-${cfg.version}`} flag={flag} env={env} canEdit={canEdit} onSaved={changed} />
              <RulesEditor flag={flag} env={env} canEdit={canEdit} onSaved={changed} />
            </div>
            <FlagDetails flag={flag} />
          </div>
          <HistoryPanel flag={flag} env={env} refreshKey={refreshKey} />
        </>
      )}
    </div>
  )
}
