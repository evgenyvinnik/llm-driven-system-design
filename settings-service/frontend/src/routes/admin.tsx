import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { ChangeLog } from '@/components/admin/ChangeLog'
import { PolicyRow } from '@/components/admin/PolicyRow'
import { Loading } from '@/components/shared/Loading'
import { useAdminData } from '@/lib/use-admin-data'
import { api } from '@/services/api'
import { isAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/admin')({ component: AdminPage })

function AdminPage() {
  const user = useAuthStore((s) => s.user)
  const load = useCallback(async () => {
    const [policy, defs, history] = await Promise.all([api.orgPolicy(), api.definitions(), api.orgHistory()])
    return { policy, defs: defs.definitions, history: history.changes }
  }, [])
  const { data, error, reload } = useAdminData(load)
  const [notice, setNotice] = useState<string | null>(null)

  if (!isAdmin(user)) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6">
        <p className="card p-4 text-sm text-muted">Only organization administrators can see this page.</p>
      </main>
    )
  }

  const onChanged = (message: string) => {
    setNotice(message)
    void reload()
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{user?.orgName} policy</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            An org default applies to members who haven&apos;t chosen. Enforcing locks the setting for everyone; their own choices are kept and come back
            when you lift it. Changes reach open clients live.
          </p>
        </div>
        {data && (
          <span className="font-mono text-xs text-muted" data-org-revision={data.policy.orgRevision}>
            policy r{data.policy.orgRevision} · {data.policy.memberCount} members
          </span>
        )}
      </div>
      {notice && <p className="mb-3 rounded-lg bg-accent-50 px-3 py-2 text-sm text-accent-700 dark:bg-accent-500/15 dark:text-accent-100">{notice}</p>}
      {error && <p className="card mb-3 p-3 text-sm text-red-700">{error}</p>}
      {!data && !error && <Loading />}
      {data && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px] text-left" aria-label="Org policy">
              <thead className="border-b border-line bg-sunken/50 text-[11px] uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-4 py-2 font-semibold">Setting</th>
                  <th className="px-4 py-2 font-semibold">Global default</th>
                  <th className="px-4 py-2 font-semibold">Org value</th>
                  <th className="px-4 py-2 font-semibold">Enforce</th>
                  <th className="px-4 py-2 font-semibold">Own value</th>
                  <th className="px-4 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.policy.items.map((item) => {
                  const def = data.defs.find((d) => d.key === item.key)
                  if (!def) return null
                  return (
                    <PolicyRow
                      key={`${item.key}:${item.rev}`}
                      def={def}
                      item={item}
                      orgRevision={data.policy.orgRevision}
                      memberCount={data.policy.memberCount}
                      onChanged={onChanged}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
          <ChangeLog title="Recent policy and catalog changes" changes={data.history} />
        </div>
      )}
    </main>
  )
}
