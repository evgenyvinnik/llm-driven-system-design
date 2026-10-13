import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Language = 'python' | 'javascript';

interface EditorState {
  /** Preferred language, remembered across problems. */
  language: Language;
  /** Unsubmitted code per problem and language, keyed `${slug}:${language}`. */
  drafts: Record<string, string>;
  setLanguage: (language: Language) => void;
  saveDraft: (slug: string, language: Language, code: string) => void;
  clearDraft: (slug: string, language: Language) => void;
}

export const draftKey = (slug: string, language: Language): string => `${slug}:${language}`;

/**
 * Client-owned editor state, persisted to localStorage so a refresh, a language switch or a
 * closed tab never loses code. Server data (problems, submissions) is not kept here.
 * Callers debounce saveDraft: persisting on every keystroke would serialize all drafts per key.
 */
export const useEditorStore = create<EditorState>()(
  persist(
    (set) => ({
      language: 'python',
      drafts: {},
      setLanguage: (language) => set({ language }),
      saveDraft: (slug, language, code) =>
        set((state) => ({ drafts: { ...state.drafts, [draftKey(slug, language)]: code } })),
      clearDraft: (slug, language) =>
        set((state) => {
          const drafts = { ...state.drafts };
          delete drafts[draftKey(slug, language)];
          return { drafts };
        }),
    }),
    {
      name: 'leetcode-editor',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
