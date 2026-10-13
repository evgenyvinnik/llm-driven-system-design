/**
 * Unsaved editor state per prompt, persisted to localStorage so a refresh or
 * an accidental navigation never loses work. A draft remembers the head
 * version it was based on; saving sends that as `baseVersion`, which is how
 * the server detects that someone else saved in the meantime.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ModelConfig } from '@/types'

export interface Draft {
  baseVersion: number
  system: string
  template: string
  variables: Record<string, string>
  /** One config runs a single run; two or three run a side-by-side comparison. */
  configs: ModelConfig[]
  updatedAt: number
}

export const DEFAULT_CONFIG: ModelConfig = { model: 'sim-fast', temperature: 0.7, maxTokens: 512, topP: 1 }

interface DraftsState {
  drafts: Record<string, Draft>
  setDraft: (promptId: string, draft: Draft) => void
  patchDraft: (promptId: string, patch: Partial<Draft>) => void
  clearDraft: (promptId: string) => void
}

export const useDrafts = create<DraftsState>()(
  persist(
    (set, get) => ({
      drafts: {},
      setDraft: (promptId, draft) => set({ drafts: { ...get().drafts, [promptId]: draft } }),
      patchDraft: (promptId, patch) => {
        const current = get().drafts[promptId]
        if (!current) return
        set({ drafts: { ...get().drafts, [promptId]: { ...current, ...patch, updatedAt: Date.now() } } })
      },
      clearDraft: (promptId) => {
        const next = { ...get().drafts }
        delete next[promptId]
        set({ drafts: next })
      },
    }),
    { name: 'prompt-playground-drafts', version: 1 },
  ),
)
