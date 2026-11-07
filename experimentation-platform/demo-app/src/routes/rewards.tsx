import { createFileRoute } from '@tanstack/react-router'
import { RewardsBanner } from '@/components/shop/RewardsBanner'
import { useShop } from '@/stores/shop-store'

export const Route = createFileRoute('/rewards')({ component: Rewards })

function Rewards() {
  const user = useShop((s) => s.user)
  return (
    <div className="mx-auto max-w-2xl space-y-5" data-page="rewards">
      <h1 className="font-display text-3xl font-bold">Rewards</h1>
      <RewardsBanner />
      <div className="card space-y-2 p-6">
        <p className="text-sm text-stone-500">Your balance</p>
        <p className="font-display text-4xl font-bold tabular-nums">{user ? 340 : 0} pts</p>
        <p className="text-sm text-stone-600">{user ? 'Enough for $15 off your next order.' : 'Sign in to start earning points.'}</p>
      </div>
      <p className="text-xs text-stone-500">Only about one visitor in eight opens this tab. Everyone is assigned to the banner experiment; only those who see it here are exposed.</p>
    </div>
  )
}
