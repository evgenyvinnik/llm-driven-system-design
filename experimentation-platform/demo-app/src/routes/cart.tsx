import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useExperimentClient } from 'experimentation-sdk/react'
import { ShippingBanner } from '@/components/shop/ShippingBanner'
import { useShop } from '@/stores/shop-store'

export const Route = createFileRoute('/cart')({ component: Cart })

function Cart() {
  const cart = useShop((s) => s.cart)
  const clear = useShop((s) => s.clear)
  const client = useExperimentClient()
  const [ordered, setOrdered] = useState<number | null>(null)
  const subtotal = cart.reduce((n, l) => n + l.price * l.qty, 0)

  function checkout() {
    // The conversion: attributed to an experiment only if it happens after this
    // unit's first exposure and within that experiment's attribution window.
    client.track('purchase', { value: subtotal })
    void client.flush()
    setOrdered(subtotal)
    clear()
  }

  if (ordered !== null) {
    return (
      <div className="card mx-auto max-w-lg space-y-3 p-8 text-center" data-page="thanks">
        <h1 className="font-display text-3xl font-bold">Thank you!</h1>
        <p className="text-stone-600">Order placed for ${ordered}. A purchase event was sent to the platform.</p>
        <Link to="/" className="btn-brand">
          Keep shopping
        </Link>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4" data-page="cart">
      <h1 className="font-display text-3xl font-bold">Your cart</h1>
      {cart.length === 0 ? (
        <p className="text-stone-600">
          Your cart is empty. <Link to="/" className="underline">Find something you like.</Link>
        </p>
      ) : (
        <>
          <ul className="card divide-y divide-brand-100" aria-label="Cart">
            {cart.map((l) => (
              <li key={l.id} className="flex items-center justify-between px-5 py-3">
                <span>
                  {l.name} <span className="text-stone-400">× {l.qty}</span>
                </span>
                <span className="font-semibold tabular-nums">${l.price * l.qty}</span>
              </li>
            ))}
            <li className="flex items-center justify-between px-5 py-3 font-semibold">
              <span>Subtotal</span>
              <span className="tabular-nums">${subtotal}</span>
            </li>
          </ul>
          <ShippingBanner subtotal={subtotal} />
          <button type="button" className="btn-brand w-full py-3 text-base" onClick={checkout}>
            Place order
          </button>
        </>
      )}
    </div>
  )
}
