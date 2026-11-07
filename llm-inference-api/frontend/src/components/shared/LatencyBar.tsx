import { ms } from '@/lib/format'

interface Props {
  queueMs: number | null
  ttftMs: number | null
  execMs: number | null
  compact?: boolean
}

/**
 * The latency split as one bar: waiting for capacity (queue), prefill on the
 * model (time to first token), then generation. Queue delay is never mistaken
 * for a slow model because it is drawn and labelled separately.
 */
export function LatencyBar({ queueMs, ttftMs, execMs, compact = false }: Props) {
  const queue = queueMs ?? 0
  const ttft = ttftMs ?? 0
  const gen = execMs === null ? null : Math.max(0, execMs - ttft)
  const total = queue + ttft + (gen ?? 0)
  if (total <= 0) return <span className="text-xs text-slate-400">–</span>
  const seg = (v: number) => `${Math.max(v > 0 ? 2 : 0, (v / total) * 100)}%`
  return (
    <div className={compact ? 'w-40' : 'w-full'}>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`queue ${ms(queue)}, first token ${ms(ttft)}, generation ${ms(gen)}`}>
        <div className="bg-amber-400" style={{ width: seg(queue) }} />
        <div className="bg-sky-500" style={{ width: seg(ttft) }} />
        <div className="bg-emerald-500" style={{ width: seg(gen ?? 0) }} />
      </div>
      {!compact && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />queue {ms(queueMs)}</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky-500" />first token {ms(ttftMs)}</span>
          <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500" />generation {gen === null ? 'in progress' : ms(gen)}</span>
        </div>
      )}
    </div>
  )
}
