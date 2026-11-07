import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Composer } from '@/components/console/Composer'
import { HistoryTable } from '@/components/console/HistoryTable'
import { OutputPanel } from '@/components/console/OutputPanel'
import { useConsoleStore } from '@/stores/console-store'

export const Route = createFileRoute('/console')({ component: ConsolePage })

function ConsolePage() {
  const loadOrgs = useConsoleStore((s) => s.loadOrgs)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    loadOrgs().catch((e: Error) => setError(e.message))
  }, [loadOrgs])

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Developer console</h1>
        <p className="text-sm text-slate-500">
          Requests run through the same admission control, queues and limits as the public API, charged to the key you pick.
        </p>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Composer />
        <OutputPanel />
      </div>
      <HistoryTable />
    </main>
  )
}
