/**
 * What only the browser knows: the open document (with live, possibly unsaved
 * edits), the selection, the open email. The assistant sends this as client
 * context with each request and reads it again through the get_selection
 * client tool.
 */
import { create } from 'zustand'
import type { DocumentDetail, OpenDocumentContext } from '@/types'

interface WorkspaceState {
  openDocument: DocumentDetail | null
  selection: string[]
  openMessageId: string | null
  /** Bumped when the assistant changes data, so open views refetch. */
  revision: number
  setOpenDocument: (doc: DocumentDetail | null) => void
  setSelection: (ids: string[]) => void
  setOpenMessage: (id: string | null) => void
  bump: () => void
  documentContext: () => OpenDocumentContext | undefined
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  openDocument: null,
  selection: [],
  openMessageId: null,
  revision: 0,
  setOpenDocument: (doc) =>
    set((s) => ({ openDocument: doc, selection: doc && s.openDocument?.id === doc.id ? s.selection.filter((id) => doc.paragraphs.some((p) => p.id === id)) : [] })),
  setSelection: (ids) => set({ selection: ids }),
  setOpenMessage: (id) => set({ openMessageId: id }),
  bump: () => set((s) => ({ revision: s.revision + 1 })),
  documentContext: () => {
    const { openDocument: doc, selection } = get()
    if (!doc) return undefined
    return {
      doc_id: doc.id,
      title: doc.title,
      version: doc.version,
      selection,
      // A simplified view with stable paragraph IDs; the model edits by ID, never by character offset.
      outline: doc.paragraphs.map((p) => ({ id: p.id, kind: p.kind, text: p.text.slice(0, 120) })),
    }
  },
}))
