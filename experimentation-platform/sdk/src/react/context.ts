import { createContext, useContext, useSyncExternalStore } from 'react'
import type { ClientState, ExperimentClient } from '../client/client.js'

export const ExperimentContext = createContext<ExperimentClient | null>(null)

export function useExperimentClient(): ExperimentClient {
  const client = useContext(ExperimentContext)
  if (!client) throw new Error('useExperimentClient must be used inside <ExperimentProvider>')
  return client
}

/** Re-renders when the snapshot, context or connection changes. */
export function useClientState(): ClientState {
  const client = useExperimentClient()
  return useSyncExternalStore(client.subscribe, client.getState, client.getState)
}
