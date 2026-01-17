/**
 * Document store for managing documents, presence, comments, and versions.
 * Central state management for the collaborative editing experience.
 * Uses Zustand for reactive state updates across components.
 */

import { create } from 'zustand';
import type { Document, DocumentListItem, PresenceState, Comment, DocumentVersion } from '../types';
import { documentsApi, commentsApi, versionsApi } from '../services/api';

/**
 * Document state interface for Zustand store.
 * Contains document data, presence info, comments, versions, and CRUD actions.
 */
interface DocumentState {
  /** List of all accessible documents for the document list view */
  documents: DocumentListItem[];
  /** Currently open document with full content */
  currentDocument: Document | null;
  /** Active collaborators in the current document */
  presence: PresenceState[];
  /** Comments on the current document */
  comments: Comment[];
  /** Version history for the current document */
  versions: DocumentVersion[];
  /** True when a document operation is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  // Document actions
  /** Fetches all accessible documents */
  fetchDocuments: () => Promise<void>;
  /** Fetches a single document with content */
  fetchDocument: (id: string) => Promise<void>;
  /** Creates a new document */
  createDocument: (title?: string) => Promise<string | null>;
  /** Updates document metadata */
  updateDocument: (id: string, updates: Partial<Document>) => Promise<void>;
  /** Soft deletes a document */
  deleteDocument: (id: string) => Promise<void>;
  /** Sets the current document in state */
  setCurrentDocument: (doc: Document | null) => void;

  // Presence actions
  /** Sets all presence states (typically from WebSocket sync) */
  setPresence: (presence: PresenceState[]) => void;
  /** Updates a single user's presence */
  updatePresence: (user: PresenceState) => void;
  /** Removes a user's presence when they leave */
  removePresence: (userId: string) => void;

  // Comments actions
  /** Fetches comments for a document */
  fetchComments: (docId: string) => Promise<void>;
  /** Adds a new comment */
  addComment: (docId: string, content: string, anchor?: { start: number; end: number; version: number }) => Promise<void>;
  /** Resolves or unresolves a comment */
  resolveComment: (docId: string, commentId: string, resolved: boolean) => Promise<void>;
  /** Deletes a comment */
  deleteComment: (docId: string, commentId: string) => Promise<void>;
  /** Adds a reply to a comment thread */
  replyToComment: (docId: string, parentId: string, content: string) => Promise<void>;

  // Versions actions
  /** Fetches version history for a document */
  fetchVersions: (docId: string) => Promise<void>;
  /** Creates a named version checkpoint */
  createVersion: (docId: string, name?: string) => Promise<void>;
  /** Restores document to a previous version */
  restoreVersion: (docId: string, versionNumber: number) => Promise<void>;

  /** Clears any error state */
  clearError: () => void;
}

/**
 * Zustand store for document state management.
 * Manages documents, presence, comments, and version history.
 * All async actions handle loading and error states internally.
 */
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
