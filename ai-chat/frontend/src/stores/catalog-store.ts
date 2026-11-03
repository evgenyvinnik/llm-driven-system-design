import { create } from 'zustand'
import { api } from '@/services/api'
import type { ModelInfo } from '@/types'

interface CatalogState {
  models: ModelInfo[]
  load: () => Promise<void>
}

export const useCatalog = create<CatalogState>((set, get) => ({
  models: [],
  load: async () => {
    if (get().models.length > 0) return
    try {
      set({ models: (await api.models()).models })
    } catch {
      /* the composer falls back to the conversation's model */
    }
  },
}))
