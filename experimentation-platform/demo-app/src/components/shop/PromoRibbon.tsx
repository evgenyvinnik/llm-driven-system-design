import { useVariant } from 'experimentation-sdk/react'

/** `promo_ribbon` (anonymous unit): killed in prod by the seed, so it only shows in dev or after a resume. */
export function PromoRibbon() {
  const ribbon = useVariant('promo_ribbon')
  if (ribbon.variant !== 'on') return null
  return <div className="bg-brand-900 py-1.5 text-center text-xs font-medium text-brand-50">Autumn sale: 15% off grinders this week</div>
}
