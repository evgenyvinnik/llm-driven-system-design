import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { FlagTable } from '@/components/flags/FlagTable'
import { NewFlagForm } from '@/components/flags/NewFlagForm'
import { PlusIcon } from '@/components/icons'
import { Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useCanEdit } from '@/stores/auth-store'
import { useEnvStore } from '@/stores/env-store'

export const Route = createFileRoute('/flags/')({ component: FlagsPage })

function FlagsPage() {
  const env = useEnvStore((s) => s.env)
  const canEdit = useCanEdit()
  const [creating, setCreating] = useState(false)
  const { data, error } = usePoll(() => api.flags(), 5000)
  if (!data) return error ? <main className="page text-sm text-rose-700">{error}</main> : <Loading />
  const experiments = data.flags.filter((f) => f.kind === 'experiment')
  const running = experiments.filter((f) => f.configs[env]?.status === 'running').length
  return (
    <div className="page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="h1">Flags &amp; experiments</h1>
          <p className="text-sm text-slate-500">
            {data.flags.length} keys · {running} experiment{running === 1 ? '' : 's'} running in <span className="font-medium">{env}</span>. Every change bumps the
            config version, is audited, and publishes a new ruleset snapshot to connected SDKs.
          </p>
        </div>
        <button type="button" className="btn-primary" disabled={!canEdit} title={canEdit ? undefined : 'Viewers cannot create flags'} onClick={() => setCreating(true)}>
          <PlusIcon /> New
        </button>
      </div>
      {creating && <NewFlagForm onClose={() => setCreating(false)} />}
      <FlagTable flags={data.flags} env={env} />
    </div>
  )
}
