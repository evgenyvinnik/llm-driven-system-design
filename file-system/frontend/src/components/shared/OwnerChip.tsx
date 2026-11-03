export function OwnerChip({ owner }: { owner: string | null }) {
  if (owner === null) return <span className="chip bg-slate-100 text-slate-500">unowned</span>
  return <span className="chip bg-accent-50 text-accent-700">{owner}</span>
}
