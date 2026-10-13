export function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-slate-500">{detail}</div>}
    </div>
  )
}
