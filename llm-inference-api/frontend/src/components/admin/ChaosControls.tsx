const KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'crash_mid_stream', label: 'Crash mid-stream', hint: 'The next admitted request crashes the backend after a few tokens' },
  { id: 'slow', label: 'Slow', hint: 'The next request is stuck in prefill for seconds' },
  { id: 'refuse', label: 'Refuse', hint: 'The next group is refused with 503 (re-routed)' },
  { id: 'overload', label: 'Overload', hint: 'The next group gets 529 and the backend cools down' },
]

/** Failures armed as counts: each fires on exactly the next N matching events. */
export function ChaosControls({ chaos, disabled, onArm }: { chaos: Record<string, number>; disabled: boolean; onArm: (kind: string, n: number) => void }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Chaos (armed counts)</div>
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map((k) => {
          const armed = chaos[k.id] ?? 0
          return (
            <span key={k.id} className="inline-flex items-center overflow-hidden rounded-md border border-slate-200 text-xs" title={k.hint}>
              <button type="button" className="px-2 py-0.5 hover:bg-slate-50 disabled:opacity-50" disabled={disabled} onClick={() => onArm(k.id, armed + 1)}>
                {k.label}
              </button>
              <span className={`num border-l border-slate-200 px-1.5 py-0.5 ${armed > 0 ? 'bg-red-50 font-semibold text-red-700' : 'text-slate-400'}`}>{armed}</span>
              {armed > 0 && (
                <button type="button" className="border-l border-slate-200 px-1.5 py-0.5 text-slate-500 hover:bg-slate-50" disabled={disabled} onClick={() => onArm(k.id, 0)} aria-label={`Disarm ${k.label}`}>
                  ×
                </button>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
