import { useNavigate } from '@tanstack/react-router'
import { Exposure, useVariant } from 'experimentation-sdk/react'
import type { Product } from '@/lib/products'
import { useShop } from '@/stores/shop-store'

/**
 * checkout_cta: the button copy comes from the variant's value. The exposure is
 * logged by <Exposure> when this button mounts on the product page: a visitor
 * who never opens a product is assigned but not exposed.
 */
export function BuyButton({ product }: { product: Product }) {
  const cta = useVariant('checkout_cta')
  const add = useShop((s) => s.add)
  const navigate = useNavigate()
  const label = typeof cta.value === 'string' ? cta.value : 'Add to cart'
  return (
    <Exposure evaluation={cta}>
      <button
        type="button"
        className={`btn-brand w-full py-3 text-base ${cta.variant === 'treatment' ? 'bg-emerald-700 hover:bg-emerald-800' : ''}`}
        data-variant={cta.variant ?? 'default'}
        onClick={() => {
          add({ id: product.id, name: product.name, price: product.price })
          void navigate({ to: '/cart' })
        }}
      >
        {label}
      </button>
    </Exposure>
  )
}
