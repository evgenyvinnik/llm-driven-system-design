export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500">
      <span className="animate-pulse">{label}</span>
    </main>
  )
}
