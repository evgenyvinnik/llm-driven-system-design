/**
 * Fault switches. Worker switches live in PostgreSQL (armed counts are
 * consumed atomically by whichever worker gets there first); the mock
 * embedder and model keep theirs in memory, proxied through the API.
 */
import { useState } from 'react'
import { BoltIcon } from '@/components/icons'
import { ApiError, api } from '@/services/api'
import type { ChaosName, OpsOverview } from '@/types'
import { NumberField } from './NumberField'

export function ChaosPanel({ data, onChange }: { data: OpsOverview; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const wrap = (fn: () => Promise<unknown>) => async () => {
    setError(null)
    try {
      await fn()
      onChange()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed')
    }
  }
  const chaos = (name: ChaosName) => (v: number) => wrap(() => api.setChaos(name, v))()
  const emb = data.embedder?.settings
  const mod = data.model?.settings
  const paused = data.chaos.acl_sync_paused > 0
  const purgeHeld = (data.chaos.purge_paused ?? 0) > 0

  return (
    <section className="card p-4" aria-label="Fault injection">
      <h2 className="panel-title flex items-center gap-1.5">
        <BoltIcon className="h-3.5 w-3.5" /> Fault injection
      </h2>
      {error && <p className="mt-1 text-xs text-rose-800">{error}</p>}
      <div className="mt-2 grid gap-6 lg:grid-cols-3">
        <div>
          <h3 className="mb-1 text-xs font-semibold text-slate-600">Pipeline workers</h3>
          <NumberField label="Kill worker mid-chunk" hint="armed count; exits after half the chunks are written" value={data.chaos.kill_mid_chunk} onSave={chaos('kill_mid_chunk')} />
          <NumberField label="Blob store outage" hint="armed count of failing MinIO calls" value={data.chaos.blob_outage} onSave={chaos('blob_outage')} />
          <NumberField label="Hold version switch (ms)" hint="delay between indexing and activation" step={500} value={data.chaos.activation_delay_ms} onSave={chaos('activation_delay_ms')} />
          <div className="flex items-center justify-between py-1">
            <div>
              <div className="text-sm text-slate-700">Index metadata sync</div>
              <div className="text-[11px] text-slate-400">paused = index rows keep the old scope</div>
            </div>
            <button type="button" className={paused ? 'btn-primary !py-1 text-xs' : 'btn-secondary !py-1 text-xs'} onClick={() => void chaos('acl_sync_paused')(paused ? 0 : 1)}>
              {paused ? 'Paused · resume' : 'Running · pause'}
            </button>
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <div className="text-sm text-slate-700">Purges</div>
              <div className="text-[11px] text-slate-400">held = deleted stays hidden, removal waits</div>
            </div>
            <button type="button" className={purgeHeld ? 'btn-primary !py-1 text-xs' : 'btn-secondary !py-1 text-xs'} onClick={() => void chaos('purge_paused')(purgeHeld ? 0 : 1)}>
              {purgeHeld ? 'Held · release' : 'Running · hold'}
            </button>
          </div>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-slate-600">Mock embedder {data.embedder ? '' : '(unreachable)'}</h3>
          <NumberField label="Latency per batch (ms)" step={50} value={emb?.latencyMs ?? null} onSave={(v) => wrap(() => api.setEmbedder({ latencyMs: v }))()} />
          <NumberField label="Failure rate (0-1)" step={0.05} value={emb?.failureRate ?? null} onSave={(v) => wrap(() => api.setEmbedder({ failureRate: v }))()} />
          <NumberField label="Next N answer 429" hint="Retry-After honoured by the embed stage" value={emb?.armed.rate_limited ?? null} onSave={(v) => wrap(() => api.setEmbedder({ armed: { rate_limited: v } }))()} />
          <NumberField label="Next N answer 500" hint="fails the attempt; 3 in a row poisons" value={emb?.armed.server_error ?? null} onSave={(v) => wrap(() => api.setEmbedder({ armed: { server_error: v } }))()} />
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-slate-600">Mock model {data.model ? `(${data.model.active} streaming)` : '(unreachable)'}</h3>
          <NumberField label="Time to first token (ms)" step={50} value={mod?.ttftMs ?? null} onSave={(v) => wrap(() => api.setModel({ ttftMs: v }))()} />
          <NumberField label="Tokens per second" value={mod?.tokensPerSecond ?? null} onSave={(v) => wrap(() => api.setModel({ tokensPerSecond: Math.max(1, v) }))()} />
          <NumberField label="Failure rate (0-1)" step={0.05} value={mod?.failureRate ?? null} onSave={(v) => wrap(() => api.setModel({ failureRate: v }))()} />
          <NumberField label="Next N disconnect mid-stream" value={mod?.armed.midstream_disconnect ?? null} onSave={(v) => wrap(() => api.setModel({ armed: { midstream_disconnect: v } }))()} />
          <NumberField label="Next N overloaded (529)" value={mod?.armed.overloaded ?? null} onSave={(v) => wrap(() => api.setModel({ armed: { overloaded: v } }))()} />
          <NumberField label="Next N server error (500)" value={mod?.armed.server_error ?? null} onSave={(v) => wrap(() => api.setModel({ armed: { server_error: v } }))()} />
        </div>
      </div>
    </section>
  )
}
