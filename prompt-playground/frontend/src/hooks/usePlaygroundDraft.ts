/**
 * Connects the persisted draft to the prompt's saved head.
 *
 * - No draft yet: start from the head version.
 * - Draft text equal to the head: clean; the base silently advances to the head.
 * - Head moved past the draft's base while the draft has edits: `headMoved`,
 *   so the editor can say who saved what before the user tries to save.
 */
import { useEffect, useMemo } from 'react'
import { extractVariables } from '@/lib/template'
import { DEFAULT_CONFIG, useDrafts, type Draft } from '@/stores/drafts-store'
import type { PromptDetail } from '@/types'

export function usePlaygroundDraft(promptId: string, detail: PromptDetail | null) {
  const draft = useDrafts((s) => s.drafts[promptId]) as Draft | undefined
  const setDraft = useDrafts((s) => s.setDraft)
  const patchDraft = useDrafts((s) => s.patchDraft)
  const head = detail?.head ?? null
  const headVersion = detail?.prompt.headVersion ?? 0

  useEffect(() => {
    if (!detail) return
    if (!draft) {
      setDraft(promptId, {
        baseVersion: headVersion,
        system: head?.system ?? '',
        template: head?.template ?? '',
        variables: {},
        configs: [DEFAULT_CONFIG],
        updatedAt: Date.now(),
      })
      return
    }
    const matchesHead = head !== null && draft.system === head.system && draft.template === head.template
    if (matchesHead && draft.baseVersion !== headVersion) patchDraft(promptId, { baseVersion: headVersion })
  }, [detail, draft, head, headVersion, promptId, setDraft, patchDraft])

  const derived = useMemo(() => {
    if (!draft) return { dirty: false, headMoved: false, variableNames: [] as string[], missing: [] as string[] }
    const dirty = head === null ? draft.template !== '' || draft.system !== '' : draft.system !== head.system || draft.template !== head.template
    const variableNames = extractVariables(draft.system, draft.template)
    return {
      dirty,
      headMoved: dirty && draft.baseVersion < headVersion,
      variableNames,
      missing: variableNames.filter((name) => !(name in draft.variables) || draft.variables[name] === ''),
    }
  }, [draft, head, headVersion])

  return { draft, patch: (p: Partial<Draft>) => patchDraft(promptId, p), ...derived }
}
