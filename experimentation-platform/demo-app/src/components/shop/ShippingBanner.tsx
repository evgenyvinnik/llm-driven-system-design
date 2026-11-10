/**
 * shipping_banner: DELIBERATELY BROKEN, to show what the SRM check catches.
 *
 * Control logs its exposure on mount (correct). The treatment logs its exposure
 * from the illustration's onLoad, and the illustration comes from a slow
 * "CDN" (the shop API answers after 3.5 s): visitors who check out or leave
 * sooner saw the banner text but are never logged. The treatment arm loses
 * exposures, the split drifts from 50/50, and the results page says not to
 * trust it. The fix is <Exposure> around the banner, like control.
 */
import { Exposure, useClientState, useExperimentClient, useVariant } from 'experimentation-sdk/react'
import { TruckIcon } from '@/components/icons'

const ILLUSTRATION = '/api/v1/shop/assets/free-shipping.svg'

export function ShippingBanner({ subtotal }: { subtotal: number }) {
  const banner = useVariant('shipping_banner')
  const client = useExperimentClient()
  const { context } = useClientState()
  const remaining = Math.max(0, 50 - subtotal)
  const text = remaining === 0 ? 'You get free shipping on this order.' : `Add $${remaining} more for free shipping.`
  if (banner.variant !== 'treatment') {
    return (
      <Exposure evaluation={banner}>
        <p className="flex items-center gap-2 rounded-xl bg-stone-100 px-4 py-3 text-sm text-stone-700" data-variant="control">
          <TruckIcon /> {text}
        </p>
      </Exposure>
    )
  }
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-variant="treatment">
      <div className="flex items-center gap-2 font-semibold">
        <TruckIcon /> Free shipping over $50
      </div>
      <p className="mt-0.5">{text}</p>
      {/* The bug: the exposure waits for a slow image that many visitors never see finish loading. */}
      <img src={ILLUSTRATION} alt="" className="mt-2 h-10" onLoad={() => client.logExposure(banner, context)} />
    </div>
  )
}
