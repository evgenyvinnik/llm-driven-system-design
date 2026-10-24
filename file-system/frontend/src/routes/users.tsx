import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { RefreshIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared'
import { AddUserForm, MergeUsersForm, RestoreBanner, UsersTable } from '@/components/users'
import { api, errorMessage } from '@/services/api'
import { useToasts } from '@/stores/toast-store'
import { useUsers } from '@/stores/users-store'
import type { RestoreResult } from '@/types'

export const Route = createFileRoute('/users')({ component: UsersPage })

function UsersPage() {
  const { users, loaded, error, load } = useUsers()
  const push = useToasts((s) => s.push)
  const [restored, setRestored] = useState<RestoreResult | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  async function reset() {
    try {
      await api.reset()
      setRestored(null)
      push('success', 'Demo data reset')
      void load()
    } catch (err) {
      push('error', errorMessage(err))
    }
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Users and quotas</h1>
          <p className="mt-1 text-sm text-slate-500">Every owned file counts against its owner&apos;s capacity. Unowned files count against no one.</p>
        </div>
        <button className="btn-secondary" onClick={reset}>
          <RefreshIcon /> Reset demo data
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          {restored && <RestoreBanner result={restored} onClose={() => setRestored(null)} />}
          {loaded ? <UsersTable users={users} onChanged={load} onRestored={setRestored} /> : <p className="text-sm text-slate-500">Loading…</p>}
        </div>
        <aside className="space-y-4">
          <AddUserForm onCreated={load} />
          <MergeUsersForm users={users} onMerged={load} />
        </aside>
      </div>
    </main>
  )
}
