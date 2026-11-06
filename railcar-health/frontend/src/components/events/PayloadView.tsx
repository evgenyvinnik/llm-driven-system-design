/** Pretty-printed JSON payload, scrollable. */
export function PayloadView({ value, label }: { value: unknown; label: string }) {
  return (
    <div>
      <div className="panel-title mb-1">{label}</div>
      <pre className="max-h-72 overflow-auto rounded-md bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}
