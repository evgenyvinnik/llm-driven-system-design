export const TIER_NAMES: Record<number, string> = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' }

/** Status palette (reserved): always paired with the tier name and an icon. */
export const TIER_STYLE: Record<number, { badge: string; dot: string; ring: string; hex: string }> = {
  4: { badge: 'bg-red-50 text-red-800 ring-1 ring-red-200', dot: 'bg-tier-critical', ring: 'border-l-tier-critical', hex: '#d03b3b' },
  3: { badge: 'bg-orange-50 text-orange-800 ring-1 ring-orange-200', dot: 'bg-tier-high', ring: 'border-l-tier-high', hex: '#ec835a' },
  2: { badge: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200', dot: 'bg-tier-medium', ring: 'border-l-tier-medium', hex: '#fab219' },
  1: { badge: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200', dot: 'bg-tier-low', ring: 'border-l-tier-low', hex: '#64748b' },
}
