export function Legend() {
  const item = 'flex items-center gap-1.5'
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
      <span className={item}>
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1l6 6-6 6-6-6z" fill="#d03b3b" /></svg>hazard (colour = severity)
      </span>
      <span className={item}>
        <svg width="18" height="10" viewBox="0 0 18 10"><rect x="1" y="1" width="16" height="8" rx="2" fill="#f97316" opacity="0.3" stroke="#f97316" strokeDasharray="3 2" /></svg>heat risk zone
      </span>
      <span className={item}>
        <svg width="18" height="10" viewBox="0 0 18 10"><rect x="1" y="1" width="16" height="8" rx="2" fill="#facc15" stroke="#a16207" strokeWidth="0.6" /></svg>speed restriction
      </span>
      <span className={item}>
        <svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 1l12 5-12 5z" fill="#1d4ed8" /></svg>train (red ring = warned)
      </span>
      <span className={item}>
        <svg width="18" height="10" viewBox="0 0 18 10"><rect width="18" height="10" fill="#fecaca" /><path d="M0 10 10 0M8 10 18 0" stroke="#dc2626" strokeWidth="1.5" opacity="0.6" /></svg>coverage gap
      </span>
    </div>
  )
}
