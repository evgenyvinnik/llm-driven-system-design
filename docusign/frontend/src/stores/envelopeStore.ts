import { create } from 'zustand';
import { Envelope, Document, Recipient, DocumentField } from '../types';
import { envelopeApi, documentApi, recipientApi, fieldApi } from '../services/api';

interface EnvelopeState {
  envelopes: Envelope[];
  currentEnvelope: Envelope | null;
  documents: Document[];
  recipients: Recipient[];
  fields: DocumentField[];
  isLoading: boolean;
  error: string | null;

  // Envelope actions
  fetchEnvelopes: (status?: string) => Promise<void>;
  fetchEnvelope: (id: string) => Promise<void>;
  createEnvelope: (name: string, message?: string) => Promise<Envelope>;
  updateEnvelope: (id: string, data: Partial<Envelope>) => Promise<void>;
  sendEnvelope: (id: string) => Promise<void>;
  voidEnvelope: (id: string, reason: string) => Promise<void>;
  deleteEnvelope: (id: string) => Promise<void>;

  // Document actions
  uploadDocument: (envelopeId: string, file: File) => Promise<Document>;
  deleteDocument: (id: string) => Promise<void>;

  // Recipient actions
  addRecipient: (envelopeId: string, data: { name: string; email: string; routingOrder?: number }) => Promise<Recipient>;
  updateRecipient: (id: string, data: Partial<Recipient>) => Promise<void>;
  deleteRecipient: (id: string) => Promise<void>;

  // Field actions
  addField: (documentId: string, data: {
    recipientId: string;
    type: string;
    pageNumber: number;
    x: number;
    y: number;
    width?: number;
    height?: number;
  }) => Promise<DocumentField>;
  updateField: (id: string, data: Partial<DocumentField>) => Promise<void>;
  deleteField: (id: string) => Promise<void>;

  clearCurrent: () => void;
  clearError: () => void;
}

export const useEnvelopeStore = create<EnvelopeState>((set, get) => ({
  envelopes: [],
  currentEnvelope: null,
  documents: [],
  recipients: [],
  fields: [],
  isLoading: false,
  error: null,

  fetchEnvelopes: async (status?: string) => {
    set({ isLoading: true, error: null });
    try {
      const { envelopes } = await envelopeApi.list(status);
      set({ envelopes, isLoading: false });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  fetchEnvelope: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const { envelope, documents, recipients, fields } = await envelopeApi.get(id);
      set({
        currentEnvelope: envelope,
        documents,
        recipients,
        fields,
        isLoading: false,
      });
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  createEnvelope: async (name: string, message?: string) => {
    set({ isLoading: true, error: null });
    try {
      const { envelope } = await envelopeApi.create({ name, message });
      set((state) => ({
        envelopes: [envelope, ...state.envelopes],
        isLoading: false,
      }));
      return envelope;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  updateEnvelope: async (id: string, data: Partial<Envelope>) => {
    try {
      const { envelope } = await envelopeApi.update(id, data);
      set((state) => ({
        currentEnvelope: state.currentEnvelope?.id === id ? envelope : state.currentEnvelope,
        envelopes: state.envelopes.map((e) => (e.id === id ? envelope : e)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  sendEnvelope: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const { envelope } = await envelopeApi.send(id);
      set((state) => ({
        currentEnvelope: state.currentEnvelope?.id === id ? envelope : state.currentEnvelope,
        envelopes: state.envelopes.map((e) => (e.id === id ? envelope : e)),
        isLoading: false,
      }));
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  voidEnvelope: async (id: string, reason: string) => {
    try {
      const { envelope } = await envelopeApi.void(id, reason);
      set((state) => ({
        currentEnvelope: state.currentEnvelope?.id === id ? envelope : state.currentEnvelope,
        envelopes: state.envelopes.map((e) => (e.id === id ? envelope : e)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deleteEnvelope: async (id: string) => {
    try {
      await envelopeApi.delete(id);
      set((state) => ({
        envelopes: state.envelopes.filter((e) => e.id !== id),
        currentEnvelope: state.currentEnvelope?.id === id ? null : state.currentEnvelope,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  uploadDocument: async (envelopeId: string, file: File) => {
    set({ isLoading: true, error: null });
    try {
      const { document } = await documentApi.upload(envelopeId, file);
      set((state) => ({
        documents: [...state.documents, document],
        isLoading: false,
      }));
      return document;
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
      throw err;
    }
  },

  deleteDocument: async (id: string) => {
    try {
      await documentApi.delete(id);
      set((state) => ({
        documents: state.documents.filter((d) => d.id !== id),
        fields: state.fields.filter((f) => f.document_id !== id),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  addRecipient: async (envelopeId: string, data) => {
    try {
      const { recipient } = await recipientApi.add(envelopeId, data);
      set((state) => ({
        recipients: [...state.recipients, recipient],
      }));
      return recipient;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateRecipient: async (id: string, data) => {
    try {
      const { recipient } = await recipientApi.update(id, data);
      set((state) => ({
        recipients: state.recipients.map((r) => (r.id === id ? recipient : r)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deleteRecipient: async (id: string) => {
    try {
      await recipientApi.delete(id);
      set((state) => ({
        recipients: state.recipients.filter((r) => r.id !== id),
        fields: state.fields.filter((f) => f.recipient_id !== id),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  addField: async (documentId: string, data) => {
    try {
      const { field } = await fieldApi.add(documentId, data);
      set((state) => ({
        fields: [...state.fields, field],
      }));
      return field;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  updateField: async (id: string, data) => {
    try {
      const { field } = await fieldApi.update(id, data);
      set((state) => ({
        fields: state.fields.map((f) => (f.id === id ? field : f)),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deleteField: async (id: string) => {
    try {
      await fieldApi.delete(id);
      set((state) => ({
        fields: state.fields.filter((f) => f.id !== id),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  clearCurrent: () => set({ currentEnvelope: null, documents: [], recipients: [], fields: [] }),

  clearError: () => set({ error: null }),
}));
