import { AlertIcon, FlameIcon, InfoIcon } from '@/components/icons'
import { TIER_NAMES, TIER_STYLE } from '@/lib/tiers'

export function TierBadge({ tier, size = 'sm' }: { tier: number; size?: 'sm' | 'lg' }) {
  const style = TIER_STYLE[tier] ?? TIER_STYLE[1]
  const Icon = tier >= 4 ? FlameIcon : tier >= 2 ? AlertIcon : InfoIcon
  return (
    <span className={`chip ${style.badge} ${size === 'lg' ? 'px-2.5 py-1 text-sm' : ''} font-semibold`}>
      <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      {TIER_NAMES[tier] ?? 'NONE'}
    </span>
  )
}
