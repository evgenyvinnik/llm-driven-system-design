/**
 * Starts the client and renders children without waiting on the network when
 * a snapshot is already held (cache or bootstrap). With nothing held, it waits
 * at most `maxWaitMs` for the first fetch, then renders with coded defaults
 * rather than a blank page.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ExperimentClient } from '../client/client.js'
import { ExperimentContext } from './context.js'

export interface ExperimentProviderProps {
  client: ExperimentClient
  children: ReactNode
  /** How long to hold first render when nothing is cached (default 300 ms). */
  maxWaitMs?: number
  fallback?: ReactNode
}

export function ExperimentProvider({ client, children, maxWaitMs = 300, fallback = null }: ExperimentProviderProps) {
  const [ready, setReady] = useState(() => client.getSnapshot() !== null)
  useEffect(() => {
    void client.start()
    if (ready) return
    const timer = setTimeout(() => setReady(true), maxWaitMs)
    void client.ready().then(() => {
      clearTimeout(timer)
      setReady(true)
    })
    return () => clearTimeout(timer)
  }, [client, maxWaitMs, ready])
  return <ExperimentContext.Provider value={client}>{ready ? children : fallback}</ExperimentContext.Provider>
}
