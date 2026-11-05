import { createFileRoute } from '@tanstack/react-router'
import { OrdersTable } from '@/components/orders/OrdersTable'
import { TicketsTable } from '@/components/orders/TicketsTable'
import { VendorControls } from '@/components/orders/VendorControls'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { useRefresh } from '@/lib/use-refresh'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/orders')({ component: Orders })

function Orders() {
  const ticks = useLiveStore((s) => s.ticks)
  const orders = useRefresh(() => Promise.all([api.orders(), api.fleet()]), { triggers: [ticks.order, ticks.ticket], coalesceMs: 1500 })
  const tickets = useRefresh(() => api.tickets(), { triggers: [ticks.ticket, ticks.order], coalesceMs: 2000 })
  if (!orders.data) return orders.error ? <ErrorNote message={orders.error} /> : <Loading />
  const [{ orders: rows }, fleet] = orders.data
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">DTL truck orders</h1>
        <p className="text-sm text-slate-500">
          One order per accepted stop, keyed by train, location and option. A timeout is &ldquo;outcome unknown&rdquo;: we ask the vendor by key before ever sending again.
        </p>
      </div>
      <VendorControls />
      <OrdersTable orders={rows} nowMs={fleet.simNow} onChanged={orders.reload} />
      {tickets.data && <TicketsTable tickets={tickets.data.tickets} totals={tickets.data.totals} />}
    </div>
  )
}
