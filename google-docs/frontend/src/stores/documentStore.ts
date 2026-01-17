import { create } from 'zustand';
import type { Document, DocumentListItem, PresenceState, Comment, DocumentVersion } from '../types';
import { documentsApi, commentsApi, versionsApi } from '../services/api';

interface DocumentState {
  documents: DocumentListItem[];
  currentDocument: Document | null;
  presence: PresenceState[];
  comments: Comment[];
  versions: DocumentVersion[];
  isLoading: boolean;
  error: string | null;

  // Document actions
  fetchDocuments: () => Promise<void>;
  fetchDocument: (id: string) => Promise<void>;
  createDocument: (title?: string) => Promise<string | null>;
  updateDocument: (id: string, updates: Partial<Document>) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  setCurrentDocument: (doc: Document | null) => void;

  // Presence actions
  setPresence: (presence: PresenceState[]) => void;
  updatePresence: (user: PresenceState) => void;
  removePresence: (userId: string) => void;

  // Comments actions
  fetchComments: (docId: string) => Promise<void>;
  addComment: (docId: string, content: string, anchor?: { start: number; end: number; version: number }) => Promise<void>;
  resolveComment: (docId: string, commentId: string, resolved: boolean) => Promise<void>;
  deleteComment: (docId: string, commentId: string) => Promise<void>;
  replyToComment: (docId: string, parentId: string, content: string) => Promise<void>;

  // Versions actions
  fetchVersions: (docId: string) => Promise<void>;
  createVersion: (docId: string, name?: string) => Promise<void>;
  restoreVersion: (docId: string, versionNumber: number) => Promise<void>;

  clearError: () => void;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  currentDocument: null,
  presence: [],
  comments: [],
  versions: [],
  isLoading: false,
  error: null,

  fetchDocuments: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await documentsApi.list();
      if (response.success && response.data) {
        set({ documents: response.data.documents, isLoading: false });
      } else {
        set({ error: response.error || 'Failed to fetch documents', isLoading: false });
      }
    } catch (error) {
      set({ error: 'Network error', isLoading: false });
    }
  },

  fetchDocument: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await documentsApi.get(id);
      if (response.success && response.data) {
        set({ currentDocument: response.data.document, isLoading: false });
      } else {
        set({ error: response.error || 'Failed to fetch document', isLoading: false });
      }
    } catch (error) {
      set({ error: 'Network error', isLoading: false });
    }
  },

  createDocument: async (title?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await documentsApi.create(title);
      if (response.success && response.data) {
        const newDoc = response.data.document;
        set((state) => ({
          documents: [
            {
              id: newDoc.id,
              title: newDoc.title,
              owner_id: newDoc.owner_id,
              owner_name: 'You',
              owner_avatar_color: '#3B82F6',
              permission_level: 'edit',
              updated_at: newDoc.updated_at,
              created_at: newDoc.created_at,
            },
            ...state.documents,
          ],
          isLoading: false,
        }));
        return newDoc.id;
      } else {
        set({ error: response.error || 'Failed to create document', isLoading: false });
        return null;
      }
    } catch (error) {
      set({ error: 'Network error', isLoading: false });
      return null;
    }
  },

  updateDocument: async (id: string, updates: Partial<Document>) => {
    try {
      const response = await documentsApi.update(id, updates);
      if (response.success && response.data) {
        set((state) => ({
          currentDocument: state.currentDocument?.id === id
            ? { ...state.currentDocument, ...updates }
            : state.currentDocument,
          documents: state.documents.map((doc) =>
            doc.id === id ? { ...doc, ...updates } : doc
          ),
        }));
      }
    } catch (error) {
      console.error('Update document error:', error);
    }
  },

  deleteDocument: async (id: string) => {
    try {
      const response = await documentsApi.delete(id);
      if (response.success) {
        set((state) => ({
          documents: state.documents.filter((doc) => doc.id !== id),
          currentDocument: state.currentDocument?.id === id ? null : state.currentDocument,
        }));
      }
    } catch (error) {
      console.error('Delete document error:', error);
    }
  },

  setCurrentDocument: (doc: Document | null) => {
    set({ currentDocument: doc });
  },

  setPresence: (presence: PresenceState[]) => {
    set({ presence });
  },

  updatePresence: (user: PresenceState) => {
    set((state) => {
      const existing = state.presence.findIndex((p) => p.user_id === user.user_id);
      if (existing >= 0) {
        const updated = [...state.presence];
        updated[existing] = user;
        return { presence: updated };
      }
      return { presence: [...state.presence, user] };
    });
  },

  removePresence: (userId: string) => {
    set((state) => ({
      presence: state.presence.filter((p) => p.user_id !== userId),
    }));
  },

  fetchComments: async (docId: string) => {
    try {
      const response = await commentsApi.list(docId);
      if (response.success && response.data) {
        set({ comments: response.data.comments });
      }
    } catch (error) {
      console.error('Fetch comments error:', error);
    }
  },

  addComment: async (docId: string, content: string, anchor?: { start: number; end: number; version: number }) => {
    try {
      const response = await commentsApi.create(docId, content, anchor);
      if (response.success && response.data) {
        set((state) => ({
          comments: [...state.comments, response.data!.comment],
        }));
      }
    } catch (error) {
      console.error('Add comment error:', error);
    }
  },

  resolveComment: async (docId: string, commentId: string, resolved: boolean) => {
    try {
      const response = await commentsApi.update(docId, commentId, { resolved });
      if (response.success) {
        set((state) => ({
          comments: state.comments.map((c) =>
            c.id === commentId ? { ...c, resolved } : c
          ),
        }));
      }
    } catch (error) {
      console.error('Resolve comment error:', error);
    }
  },

  deleteComment: async (docId: string, commentId: string) => {
    try {
      const response = await commentsApi.delete(docId, commentId);
      if (response.success) {
        set((state) => ({
          comments: state.comments.filter((c) => c.id !== commentId && c.parent_id !== commentId),
        }));
      }
    } catch (error) {
      console.error('Delete comment error:', error);
    }
  },

  replyToComment: async (docId: string, parentId: string, content: string) => {
    try {
      const response = await commentsApi.create(docId, content, undefined, parentId);
      if (response.success && response.data) {
        set((state) => ({
          comments: state.comments.map((c) =>
            c.id === parentId
              ? { ...c, replies: [...(c.replies || []), response.data!.comment] }
              : c
          ),
        }));
      }
    } catch (error) {
      console.error('Reply to comment error:', error);
    }
  },

  fetchVersions: async (docId: string) => {
    try {
      const response = await versionsApi.list(docId);
      if (response.success && response.data) {
        set({ versions: response.data.versions });
      }
    } catch (error) {
      console.error('Fetch versions error:', error);
    }
  },

  createVersion: async (docId: string, name?: string) => {
    try {
      const response = await versionsApi.create(docId, name);
      if (response.success && response.data) {
        set((state) => ({
          versions: [response.data!.version, ...state.versions],
        }));
      }
    } catch (error) {
      console.error('Create version error:', error);
    }
  },

  restoreVersion: async (docId: string, versionNumber: number) => {
    try {
      const response = await versionsApi.restore(docId, versionNumber);
      if (response.success) {
        // Refetch document to get restored content
        get().fetchDocument(docId);
        get().fetchVersions(docId);
      }
    } catch (error) {
      console.error('Restore version error:', error);
    }
  },

  clearError: () => set({ error: null }),
}));
