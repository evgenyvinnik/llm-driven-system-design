/**
 * What to do with a job whose execution was interrupted. Pure, because this is
 * the decision the whole design exists for: the answer to "the runner vanished
 * after the deploy succeeded".
 *
 * The evidence is the step table. A step's row says `running` BEFORE its process
 * is spawned, so a step that may have had effects always has a row saying so. The
 * rule is deliberately pessimistic: a non-idempotent step that started, finished or
 * not, makes a retry unsafe. A false positive costs a person one click; a false
 * negative deploys twice.
 * @module scheduling/decisions
 */

export interface StepEvidence {
  name: string
  idempotent: boolean
  status: 'pending' | 'running' | 'success' | 'failure' | 'timed_out' | 'killed' | 'skipped' | 'unknown'
  startedAt: Date | string | null
}

export type LeaseDecision =
  | { action: 'requeue'; reason: string }
  | { action: 'needs_attention'; reason: string; unsafeSteps: string[] }
  | { action: 'fail'; reason: string }

const started = (s: StepEvidence) => s.startedAt !== null && s.status !== 'pending' && s.status !== 'skipped'

export function decideLeaseExpiry(steps: StepEvidence[], autoRequeues: number, maxAutoRequeues: number, runnerName: string | null): LeaseDecision {
  const unsafe = steps.filter((s) => started(s) && !s.idempotent)
  const who = runnerName ?? 'the runner'
  if (unsafe.length > 0) {
    const names = unsafe.map((s) => `"${s.name}"`).join(', ')
    return {
      action: 'needs_attention',
      unsafeSteps: unsafe.map((s) => s.name),
      reason: `Outcome unknown: step ${names} is marked non-idempotent and had started when ${who} stopped responding. It may have succeeded. It will not be retried automatically; a person has to decide.`,
    }
  }
  if (autoRequeues >= maxAutoRequeues) {
    return { action: 'fail', reason: `Gave up after ${autoRequeues + 1} lost runners: this job may be what is killing them` }
  }
  return { action: 'requeue', reason: `Lease expired: ${who} stopped responding. No non-idempotent step had started, so this is safe to retry.` }
}

export type RunnerConclusion = 'success' | 'failure' | 'cancelled'
export type CompletionDecision = { status: 'success' | 'failure' | 'cancelled'; reason: string | null } | { status: 'needs_attention'; reason: string; unsafeSteps: string[] }

/**
 * A step that was killed (cancel) or timed out didn't get to report how far it
 * got, so a non-idempotent one is in the same position as a vanished runner. A
 * step that exited non-zero, by contrast, told us it failed.
 */
export function decideCompletion(conclusion: RunnerConclusion, steps: StepEvidence[], reason: string | null): CompletionDecision {
  const interrupted = steps.filter((s) => !s.idempotent && (s.status === 'killed' || s.status === 'timed_out' || s.status === 'running'))
  if (interrupted.length > 0) {
    const names = interrupted.map((s) => `"${s.name}"`).join(', ')
    const how = interrupted.every((s) => s.status === 'timed_out') ? 'timed out' : 'was killed'
    return {
      status: 'needs_attention',
      unsafeSteps: interrupted.map((s) => s.name),
      reason: `Outcome unknown: non-idempotent step ${names} ${how} before it finished. It may have taken effect. A person has to decide.`,
    }
  }
  return { status: conclusion, reason }
}

export type AttentionDecision = 'succeeded' | 'failed' | 'retry'
