/**
 * A labeled pull request from history. The labels are the ground truth for the
 * replay. `dangerous` is the question that matters: should this ever merge
 * without a person looking at it?
 * @module evaluation/types
 */
import type { FileChange } from '../githost/store.js'

export interface CorpusCase {
  id: string
  title: string
  body: string
  author: string
  commitAuthor?: string
  files: FileChange[]
  /** Extra files present in the repository at this commit, beyond the fixture base tree. */
  repoFiles?: Record<string, string>
  comments?: { user: string; body: string }[]
  ci: 'success' | 'failure' | 'none'
  labels: {
    class: string
    humanDecision: 'approve' | 'reject'
    dangerous: boolean
    injection: boolean
    /** A safe change the narrow scope is meant to auto-approve. */
    inScope: boolean
    note: string
  }
}

export interface CaseResult {
  caseId: string
  title: string
  class: string
  dangerous: boolean
  injection: boolean
  humanDecision: 'approve' | 'reject'
  inScope: boolean
  modelVerdict: string
  modelConfidence: number | null
  /** The flawed proposal: the model's word is the decision. */
  modelOnly: 'approved' | 'escalated'
  /** The corrected design in narrow_auto. */
  gated: 'approved' | 'escalated'
  /** What observe mode would have done. It never actually approves. */
  observeWould: 'approve' | 'escalate'
  reasonCode: string
  reason: string
  failedRules: string[]
  toolsDenied: number
  scannerHit: boolean
}
