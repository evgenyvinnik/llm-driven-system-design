/**
 * Zustand store for global application state
 * @module stores/useStore
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Highlight, Book } from '@/api/client'

interface AppState {
  // Auth
  user: User | null
  isAuthenticated: boolean
  setUser: (user: User | null) => void
  logout: () => void

  // Highlights
  highlights: Highlight[]
  setHighlights: (highlights: Highlight[]) => void
  addHighlight: (highlight: Highlight) => void
  removeHighlight: (id: string) => void
  updateHighlightInStore: (id: string, updates: Partial<Highlight>) => void

  // Library
  library: Book[]
  setLibrary: (books: Book[]) => void

  // UI State
  selectedBookId: string | null
  setSelectedBookId: (id: string | null) => void
  searchQuery: string
  setSearchQuery: (query: string) => void
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      // Auth
      user: null,
      isAuthenticated: false,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      logout: () => {
        localStorage.removeItem('sessionId')
        set({ user: null, isAuthenticated: false, highlights: [], library: [] })
      },

      // Highlights
      highlights: [],
      setHighlights: (highlights) => set({ highlights }),
      addHighlight: (highlight) =>
        set((state) => ({ highlights: [highlight, ...state.highlights] })),
      removeHighlight: (id) =>
        set((state) => ({
          highlights: state.highlights.filter((h) => h.id !== id),
        })),
      updateHighlightInStore: (id, updates) =>
        set((state) => ({
          highlights: state.highlights.map((h) =>
            h.id === id ? { ...h, ...updates } : h
          ),
        })),

      // Library
      library: [],
      setLibrary: (library) => set({ library }),

      // UI State
      selectedBookId: null,
      setSelectedBookId: (selectedBookId) => set({ selectedBookId }),
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
    }),
    {
      name: 'kindle-highlights-storage',
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
