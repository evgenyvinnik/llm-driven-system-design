import type { TimelineEvent } from '@/types'

/** Colour per kind of event: car facts, train facts, plan versions, decisions made by services. */
export const KIND: Record<string, string> = {
  fact: 'bg-slate-100 text-slate-700',
  train: 'bg-indigo-50 text-indigo-800',
  plan: 'bg-amber-50 text-amber-800',
  decision: 'bg-emerald-50 text-emerald-800',
}

export function kindOf(e: TimelineEvent): keyof typeof KIND {
  if (e.type.startsWith('Train') && !e.type.startsWith('TrainCapacity')) return 'train'
  if (e.type.startsWith('TripPlan')) return 'plan'
  if (e.producer.startsWith('svc:')) return 'decision'
  return 'fact'
}

