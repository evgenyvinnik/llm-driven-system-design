import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

/** The flag with every environment's config, refreshed every few seconds so concurrent edits show up. */
export function useFlag(key: string) {
  return usePoll(() => api.flag(key).then((r) => r.flag), 4000, [key])
}
