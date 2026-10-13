/**
 * Starts one run per config. Two or more configs share a comparison ID and
 * show side by side. Each run gets its own Idempotency-Key, created once per
 * click; network-level retries reuse it, so a lost response never starts a
 * duplicate run.
 */
import { useState } from 'react'
import { newId } from '@/lib/format'
import { api, ApiError, type CreateRunInput } from '@/services/api'
import { useRuns } from '@/stores/runs-store'
import type { Draft } from '@/stores/drafts-store'
import type { Run } from '@/types'

async function createWithRetry(input: CreateRunInput, key: string): Promise<Run> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await api.createRun(input, key)).run
    } catch (err) {
      const retryable = err instanceof ApiError && (err.code === 'NETWORK' || err.status >= 500)
      if (!retryable || attempt >= 2) throw err
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
    }
  }
}

export function useRunLauncher(promptId: string, title: string) {
  const follow = useRuns((s) => s.follow)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function launch(draft: Draft): Promise<string | null> {
    setLaunching(true)
    setError(null)
    const comparisonId = draft.configs.length > 1 ? newId() : undefined
    const results = await Promise.allSettled(
      draft.configs.map((config) =>
        createWithRetry(
          { promptId, system: draft.system, template: draft.template, variables: draft.variables, config, comparisonId },
          newId(),
        ),
      ),
    )
    setLaunching(false)
    const started = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    started.forEach((run) => follow(run, title))
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) {
      const err = failure.reason
      const prefix = started.length > 0 ? `${started.length} of ${results.length} runs started. ` : ''
      setError(prefix + (err instanceof ApiError ? err.message : 'Could not start the run'))
    }
    if (started.length === 0) return null
    return comparisonId ?? started[0].id
  }

  return { launch, launching, error, clearError: () => setError(null) }
}
