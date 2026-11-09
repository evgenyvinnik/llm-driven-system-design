import type { Move } from '@/types'

/** Yard clock time, in UTC so every screen and every report agree. */
export const clock = (iso: string | null | undefined): string => (iso ? new Date(iso).toISOString().slice(11, 16) : '–')
export const clockDay = (iso: string | null | undefined): string => (iso ? `${new Date(iso).toISOString().slice(5, 10)} ${clock(iso)}` : '–')

export const KIND_LABEL: Record<Move['kind'], string> = {
  receive: 'Receive',
  classify: 'Classify',
  assemble: 'Assemble',
  setout: 'Set out',
}

export function describeMove(m: Pick<Move, 'kind' | 'carCount' | 'fromTrackId' | 'toTrackId' | 'blockId' | 'inboundId' | 'outboundId'>, trainName?: (id: string) => string): string {
  const cars = `${m.carCount} car${m.carCount === 1 ? '' : 's'}`
  const to = m.toTrackId
  const from = m.fromTrackId ?? 'main'
  if (m.kind === 'receive') return `${m.inboundId} arrives: ${cars} onto ${to}`
  if (m.kind === 'classify') return `${m.blockId}: ${cars} ${from} → ${to}`
  const train = m.outboundId ? (trainName ? trainName(m.outboundId) : m.outboundId) : ''
  if (m.kind === 'assemble') return `${m.blockId} for ${train}: ${cars} ${from} → ${to}`
  return `Set out ${cars} from ${train}: ${from} → ${to}`
}

export const OVERRIDE_REASONS: { code: string; label: string }[] = [
  { code: 'protect_departure', label: 'Protect a departure' },
  { code: 'track_condition', label: 'Track condition' },
  { code: 'crew_availability', label: 'Crew availability' },
  { code: 'customer_priority', label: 'Customer priority' },
  { code: 'radio_information', label: 'Information the planner lacks' },
  { code: 'planner_wrong', label: 'Plan looks wrong' },
  { code: 'crew_preference', label: 'Crew preference' },
  { code: 'safety_concern', label: 'Safety concern' },
  { code: 'other', label: 'Other' },
]

export const reasonLabel = (code: string): string => OVERRIDE_REASONS.find((r) => r.code === code)?.label ?? code
