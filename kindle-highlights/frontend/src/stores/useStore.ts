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

  // Sync (not persisted)
  /** live: socket open; offline: reconnecting with backoff; idle: logged out */
  syncStatus: 'idle' | 'connecting' | 'live' | 'offline'
  setSyncStatus: (status: AppState['syncStatus']) => void
  /** Highest feed position another device reported; pages refetch when it moves. */
  remoteSeq: number
  noteRemoteSeq: (seq: number) => void
  /** Operations waiting in this browser's outbox. */
  pendingOps: number
  setPendingOps: (count: number) => void
}

/** Global application state with authentication and UI preferences. */
export const useStore = create<AppState>()(
  persist(
    (set) => ({
      // Auth
      user: null,
      isAuthenticated: false,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      logout: () => {
        localStorage.removeItem('sessionId')
        set({ user: null, isAuthenticated: false, highlights: [], library: [], remoteSeq: 0 })
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

      // Sync
      syncStatus: 'idle',
      setSyncStatus: (syncStatus) => set({ syncStatus }),
      remoteSeq: 0,
      noteRemoteSeq: (seq) => set((state) => (seq > state.remoteSeq ? { remoteSeq: seq } : state)),
      pendingOps: 0,
      setPendingOps: (pendingOps) => set({ pendingOps }),
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
