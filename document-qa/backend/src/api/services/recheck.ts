/**
 * The second access check: every candidate the index returned is re-checked
 * against the source of truth before it can enter a prompt or a citation.
 *
 * A candidate survives only if, in the same snapshot:
 * - its chunk still exists (not retired or purged),
 * - its document is live (no tombstone) and in the asker's org,
 * - its version is the document's current version (so an answer never mixes
 *   an old and a new version, and a new version is invisible until switched),
 * - the asker can read the document right now (owner, org-wide, or a live
 *   member of the shared group), and the asker's account is active.
 *
 * The index's copy of scope/group may be stale in either direction; when it
 * let through something the truth denies, the drop is flagged `staleIndex`
 * so the trace shows the re-check doing its job.
 * @module api/services/recheck
 */
import { accessDecision, type AccessUser, type DenyReason, type Scope } from '../../shared/access.js'

export interface Candidate {
  chunkId: string
  documentId: string
  versionId: string
  similarity: number
  ftsRank: number | null
  fused: number
  via: ('vector' | 'fts')[]
  indexScope: string
  indexGroupId: string | null
  indexAclEpoch: number
}

export interface TruthRow {
  chunkId: string
  versionId: string
  versionNo: number
  documentId: string
  ordinal: number
  text: string
  charStart: number
  charEnd: number
  heading: string | null
  title: string
  orgId: string
  ownerId: string
  scope: Scope
  groupId: string | null
  deletedAt: Date | string | null
  currentVersionId: string | null
  aclEpoch: number
}

export type DropReason = DenyReason | 'chunk_missing' | 'not_current_version'

export interface Kept {
  candidate: Candidate
  truth: TruthRow
}

export interface Dropped {
  candidate: Candidate
  reason: DropReason
  /** The index metadata said readable but the truth says otherwise (scope/group/epoch out of date). */
  staleIndex: boolean
}

export function recheck(candidates: Candidate[], truth: Map<string, TruthRow>, user: AccessUser, liveGroups: ReadonlySet<string>): { kept: Kept[]; dropped: Dropped[] } {
  const kept: Kept[] = []
  const dropped: Dropped[] = []
  for (const c of candidates) {
    const t = truth.get(c.chunkId)
    if (!t) {
      dropped.push({ candidate: c, reason: 'chunk_missing', staleIndex: true })
      continue
    }
    const access = accessDecision({ orgId: t.orgId, ownerId: t.ownerId, scope: t.scope, groupId: t.groupId, deletedAt: t.deletedAt }, user, liveGroups)
    const staleIndex = c.indexAclEpoch < t.aclEpoch || c.indexScope !== t.scope || c.indexGroupId !== t.groupId
    if (!access.allowed) {
      dropped.push({ candidate: c, reason: access.reason, staleIndex })
      continue
    }
    if (t.currentVersionId !== t.versionId) {
      dropped.push({ candidate: c, reason: 'not_current_version', staleIndex: false })
      continue
    }
    kept.push({ candidate: c, truth: t })
  }
  return { kept, dropped }
}

export function summarizeDrops(dropped: Dropped[]): { reason: DropReason; count: number; staleIndex: number }[] {
  const by = new Map<DropReason, { count: number; staleIndex: number }>()
  for (const d of dropped) {
    const cur = by.get(d.reason) ?? { count: 0, staleIndex: 0 }
    cur.count += 1
    if (d.staleIndex) cur.staleIndex += 1
    by.set(d.reason, cur)
  }
  return [...by.entries()].map(([reason, v]) => ({ reason, ...v }))
}
