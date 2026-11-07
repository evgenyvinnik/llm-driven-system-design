import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useState } from 'react'
import { DefinitionRow } from '@/components/admin/DefinitionRow'
import { NewDefinitionForm } from '@/components/admin/NewDefinitionForm'
import { Loading } from '@/components/shared/Loading'
import { useAdminData } from '@/lib/use-admin-data'
import { api } from '@/services/api'
import { isAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/catalog')({ component: CatalogPage })

/** The global catalog of setting definitions. Platform admins add and deprecate; org admins read. */
function CatalogPage() {
  const user = useAuthStore((s) => s.user)
  const load = useCallback(() => api.definitions(true), [])
  const { data, error, reload } = useAdminData(load)
  const [notice, setNotice] = useState<string | null>(null)
  const canEdit = user?.role === 'platform_admin'

  if (!isAdmin(user)) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6">
        <p className="card p-4 text-sm text-muted">Only administrators can see the catalog.</p>
      </main>
    )
  }

  const onChanged = (message: string) => {
    setNotice(message)
    void reload()
  }
  const active = (data?.definitions ?? []).filter((d) => d.status === 'active')

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Setting catalog</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Definitions are global. A new one appears for every existing user at once with its default (no backfill). A deprecated key is accepted and
            ignored with a warning during its grace window, then rejected with 422 RETIRED. Retired names are never reused.
          </p>
        </div>
        {data && <span className="font-mono text-xs text-muted">catalog r{data.catalogRevision}</span>}
      </div>
      {notice && <p className="mb-3 rounded-lg bg-accent-50 px-3 py-2 text-sm text-accent-700 dark:bg-accent-500/15 dark:text-accent-100">{notice}</p>}
      {error && <p className="card mb-3 p-3 text-sm text-red-700">{error}</p>}
      {!data && !error && <Loading />}
      {data && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-left" aria-label="Setting definitions">
              <thead className="border-b border-line bg-sunken/50 text-[11px] uppercase tracking-wide text-faint">
                <tr>
                  <th className="px-4 py-2 font-semibold">Key</th>
                  <th className="px-4 py-2 font-semibold">Type and rules</th>
                  <th className="px-4 py-2 font-semibold">Default</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.definitions.map((d) => (
                  <DefinitionRow key={`${d.key}:${d.status}`} def={d} canEdit={canEdit} replacements={active} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
          {canEdit ? (
            <NewDefinitionForm onCreated={(key) => onChanged(`${key} added; open clients refetch and show it with its default`)} />
          ) : (
            <p className="card p-4 text-sm text-muted">Only platform administrators can change the catalog.</p>
          )}
        </div>
      )}
    </main>
  )
}
