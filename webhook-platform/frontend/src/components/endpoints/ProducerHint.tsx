import { KeyIcon } from '@/components/icons'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

/** How a producer emits events: the API key prefix and a curl line with an Idempotency-Key. */
export function ProducerHint() {
  const { data } = usePoll(() => api.apiKeys(), 30_000)
  const key = data?.apiKeys[0]
  return (
    <section className="card p-4 text-sm">
      <h2 className="panel-title mb-2 flex items-center gap-1.5">
        <KeyIcon className="h-3.5 w-3.5" /> Emitting events
      </h2>
      <p className="text-slate-600">
        Producers POST events with an API key{key ? <> (<span className="code">{key.prefix}…</span>, last used {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleTimeString() : 'never'})</> : null} and an
        <span className="code">Idempotency-Key</span>. A retried POST with the same key returns the original event instead of creating a second one.
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs text-slate-100">{`curl -X POST /api/v1/events \\
  -H 'Authorization: Bearer whk_…' -H 'Idempotency-Key: order-1042-created' \\
  -d '{"type":"order.created","orderingKey":"order_1042","data":{"orderId":"1042","amount":4200}}'`}</pre>
    </section>
  )
}
