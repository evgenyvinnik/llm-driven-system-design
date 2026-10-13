import { create } from 'zustand'
import { api } from '@/services/api'
import type { ModelInfo, Preset } from '@/types'

/** Models and workspace presets: small, shared by several pages, loaded on demand. */
interface CatalogState {
  models: ModelInfo[]
  presets: Preset[]
  loadModels: () => Promise<void>
  loadPresets: () => Promise<void>
  replacePreset: (preset: Preset) => void
  removePreset: (id: string) => void
}

export const useCatalog = create<CatalogState>((set, get) => ({
  models: [],
  presets: [],
  loadModels: async () => {
    if (get().models.length > 0) return
    const { models } = await api.models()
    set({ models })
  },
  loadPresets: async () => {
    const { presets } = await api.listPresets()
    set({ presets })
  },
  replacePreset: (preset) => {
    const others = get().presets.filter((p) => p.id !== preset.id)
    set({ presets: [...others, preset].sort((a, b) => a.name.localeCompare(b.name)) })
  },
  removePreset: (id) => set({ presets: get().presets.filter((p) => p.id !== id) }),
}))
