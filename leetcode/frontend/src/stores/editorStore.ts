import { create } from 'zustand';

type Language = 'python' | 'javascript';

interface EditorState {
  language: Language;
  code: string;
  originalCode: string;
  isRunning: boolean;
  isSubmitting: boolean;
  setLanguage: (language: Language) => void;
  setCode: (code: string) => void;
  setOriginalCode: (code: string) => void;
  resetCode: () => void;
  setIsRunning: (isRunning: boolean) => void;
  setIsSubmitting: (isSubmitting: boolean) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  language: 'python',
  code: '',
  originalCode: '',
  isRunning: false,
  isSubmitting: false,

  setLanguage: (language) => set({ language }),
  setCode: (code) => set({ code }),
  setOriginalCode: (code) => set({ originalCode: code, code }),
  resetCode: () => set({ code: get().originalCode }),
  setIsRunning: (isRunning) => set({ isRunning }),
  setIsSubmitting: (isSubmitting) => set({ isSubmitting }),
}));
