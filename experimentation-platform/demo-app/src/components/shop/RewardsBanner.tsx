import { Exposure, useVariant } from 'experimentation-sdk/react'
import { StarIcon } from '@/components/icons'

/**
 * rewards_teaser: lives on the Rewards tab, which most visitors never open.
 * Every visitor is assigned at session start; only those who open this tab and
 * have the banner in view are exposed (whenVisible).
 */
export function RewardsBanner() {
  const teaser = useVariant('rewards_teaser')
  if (teaser.variant !== 'treatment') {
    return (
      <Exposure evaluation={teaser} whenVisible>
        <p className="text-sm text-stone-600" data-variant="control">
          Earn 1 point per dollar. 100 points = $5 off.
        </p>
      </Exposure>
    )
  }
  return (
    <Exposure evaluation={teaser} whenVisible>
      <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-400 px-5 py-4 text-white" data-variant="treatment">
        <StarIcon className="h-7 w-7" />
        <div>
          <div className="font-display text-lg font-bold">Double points this week</div>
          <div className="text-sm opacity-90">Every dollar earns 2 points until Sunday.</div>
        </div>
      </div>
    </Exposure>
  )
}
