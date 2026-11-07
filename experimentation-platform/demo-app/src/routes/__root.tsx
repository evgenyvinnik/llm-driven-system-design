import { Outlet, createRootRoute } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Inspector } from '@/components/inspector/Inspector'
import { Header } from '@/components/shop/Header'
import { PromoRibbon } from '@/components/shop/PromoRibbon'
import { client, loadIdentity, signedIn, signedOut } from '@/lib/experiments'
import { useShop, type Shopper } from '@/stores/shop-store'

export const Route = createRootRoute({ component: Root })

function Root() {
  useEffect(() => {
    // Session start: the app evaluates every flag once, as many apps do to
    // prefetch or tag analytics. That is assignment, not exposure.
    client.evaluateAll()
    void fetch('/api/v1/shop/me')
      .then((r) => r.json() as Promise<{ user: Shopper | null; stableId: string | null }>)
      .then(({ user, stableId }) => {
        useShop.getState().setUser(user)
        const stored = loadIdentity()
        if (user && stableId && stored?.stableId !== stableId) signedIn({ userId: user.id, stableId, orgId: user.orgId, country: user.country, plan: user.plan })
        if (!user && stored) signedOut()
      })
      .catch(() => undefined)
  }, [])
  return (
    <div className="min-h-screen">
      <PromoRibbon />
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-8 pb-72">
        <Outlet />
      </main>
      <Inspector />
    </div>
  )
}
