import { createFileRoute } from '@tanstack/react-router'
import { MovementCard, RingShares } from '@/components/routing/RingShares'
import { AffinityTables } from '@/components/routing/AffinityTables'
import { Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/routing')({ component: RoutingPage })

function RoutingPage() {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true)
  const { data, error } = usePoll(api.routing, 5000)
  if (!isAdmin) return <main className="mx-auto max-w-7xl px-4 py-6 text-sm text-slate-600">Routing is for platform operators.</main>
  if (!data) return error ? <main className="mx-auto max-w-7xl px-4 py-6 text-sm text-red-700">{error}</main> : <Loading />

  return (
    <main className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Routing</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Requests that share a prefix (a system prompt) are cheaper on the backend that already holds it in cache. That is a performance preference, not a correctness rule, so the router
          gives it up under load, during a drain, or when a backend is down. Once output starts, a request never moves.
        </p>
      </div>
      <section className="card p-4" aria-label="Ring">
        <RingShares shares={data.shares} title={`Key space owned per backend (${data.backends.length} backends)`} />
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <MovementCard label={`Adding ${data.add.backend}`} change={data.add} current={data.shares} />
        <MovementCard label={`Removing ${data.remove.backend}`} change={data.remove} current={data.shares} />
      </div>
      <AffinityTables view={data} />
    </main>
  )
}
