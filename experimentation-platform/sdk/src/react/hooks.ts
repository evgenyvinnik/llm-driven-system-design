import { useEffect, useMemo } from 'react'
import type { Evaluation } from '../core/types.js'
import { useClientState, useExperimentClient } from './context.js'

/**
 * The variant for a flag or experiment. Evaluates locally (no network) and
 * re-evaluates when the snapshot or identity changes. Logs an assignment event
 * (deduped) but never an exposure: rendering the variant is what counts, so
 * wrap the treatment in <Exposure> or call useExposure where it renders.
 */
export function useVariant(key: string): Evaluation {
  const client = useExperimentClient()
  const state = useClientState()
  // state.revision moves whenever the client applies a new snapshot, which peek() reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const evaluation = useMemo(() => client.peek(key, state.context), [client, key, state.revision, state.context])
  useEffect(() => {
    client.recordAssignment(evaluation, state.context)
  }, [client, evaluation, state.context])
  return evaluation
}

/** Logs the exposure when the calling component mounts (i.e. the variant rendered). */
export function useExposure(evaluation: Evaluation, enabled = true): void {
  const client = useExperimentClient()
  const state = useClientState()
  useEffect(() => {
    if (enabled) client.logExposure(evaluation, state.context)
  }, [client, evaluation, enabled, state.context])
}
