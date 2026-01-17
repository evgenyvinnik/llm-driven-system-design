import { create } from 'zustand';
import type { DesignObject, Tool, Viewport, PresenceState, CanvasData } from '../types';
import { v4 as uuidv4 } from 'uuid';

interface EditorState {
  // File state
  fileId: string | null;
  fileName: string;
  canvasData: CanvasData;

  // Selection and tool
  selectedIds: string[];
  activeTool: Tool;

  // Viewport
  viewport: Viewport;

  // Presence
  collaborators: PresenceState[];
  userId: string;
  userName: string;
  userColor: string;

  // History
  historyIndex: number;
  history: CanvasData[];

  // Actions
  setFileId: (id: string) => void;
  setFileName: (name: string) => void;
  setCanvasData: (data: CanvasData) => void;
  setSelectedIds: (ids: string[]) => void;
  setActiveTool: (tool: Tool) => void;
  setViewport: (viewport: Partial<Viewport>) => void;
  setCollaborators: (collaborators: PresenceState[]) => void;
  updateCollaborator: (presence: PresenceState) => void;
  removeCollaborator: (userId: string) => void;

  // Object operations
  addObject: (obj: DesignObject) => void;
  updateObject: (id: string, updates: Partial<DesignObject>) => void;
  deleteObject: (id: string) => void;
  duplicateObject: (id: string) => void;
  moveObjectInLayer: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;

  // User info
  setUserInfo: (userId: string, userName: string, userColor: string) => void;

  // History
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
}

const defaultViewport: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

const defaultCanvasData: CanvasData = {
  objects: [],
  pages: [{ id: 'page-1', name: 'Page 1', objects: [] }],
};

export const useEditorStore = create<EditorState>((set, get) => ({
  // Initial state
  fileId: null,
  fileName: 'Untitled',
  canvasData: defaultCanvasData,
  selectedIds: [],
  activeTool: 'select',
  viewport: defaultViewport,
  collaborators: [],
  userId: uuidv4(),
  userName: `User ${Math.floor(Math.random() * 1000)}`,
  userColor: '#3B82F6',
  historyIndex: -1,
  history: [],

  // Setters
  setFileId: (id) => set({ fileId: id }),
  setFileName: (name) => set({ fileName: name }),
  setCanvasData: (data) => set({ canvasData: data }),
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  setActiveTool: (tool) => set({ activeTool: tool }),
  setViewport: (viewport) => set((state) => ({
    viewport: { ...state.viewport, ...viewport },
  })),

  setCollaborators: (collaborators) => set({ collaborators }),

  updateCollaborator: (presence) => set((state) => {
    const existing = state.collaborators.findIndex(c => c.userId === presence.userId);
    if (existing !== -1) {
      const updated = [...state.collaborators];
      updated[existing] = presence;
      return { collaborators: updated };
    }
    return { collaborators: [...state.collaborators, presence] };
  }),

  removeCollaborator: (userId) => set((state) => ({
    collaborators: state.collaborators.filter(c => c.userId !== userId),
  })),

  setUserInfo: (userId, userName, userColor) => set({ userId, userName, userColor }),

  // Object operations
  addObject: (obj) => {
    const state = get();
    state.pushHistory();
    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: [...state.canvasData.objects, obj],
      },
      selectedIds: [obj.id],
    }));
  },

  updateObject: (id, updates) => {
    const state = get();
    state.pushHistory();
    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: state.canvasData.objects.map(obj =>
          obj.id === id ? { ...obj, ...updates } : obj
        ),
      },
    }));
  },

  deleteObject: (id) => {
    const state = get();
    state.pushHistory();
    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: state.canvasData.objects.filter(obj => obj.id !== id),
      },
      selectedIds: state.selectedIds.filter(sid => sid !== id),
    }));
  },

  duplicateObject: (id) => {
    const state = get();
    const obj = state.canvasData.objects.find(o => o.id === id);
    if (!obj) return;

    state.pushHistory();
    const newObj: DesignObject = {
      ...obj,
      id: uuidv4(),
      name: `${obj.name} copy`,
      x: obj.x + 20,
      y: obj.y + 20,
    };

    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: [...state.canvasData.objects, newObj],
      },
      selectedIds: [newObj.id],
    }));
  },

  moveObjectInLayer: (id, direction) => {
    const state = get();
    state.pushHistory();
    set((state) => {
      const objects = [...state.canvasData.objects];
      const index = objects.findIndex(o => o.id === id);
      if (index === -1) return state;

      let newIndex = index;
      switch (direction) {
        case 'up':
          newIndex = Math.min(index + 1, objects.length - 1);
          break;
        case 'down':
          newIndex = Math.max(index - 1, 0);
          break;
        case 'top':
          newIndex = objects.length - 1;
          break;
        case 'bottom':
          newIndex = 0;
          break;
      }

      if (newIndex !== index) {
        const [obj] = objects.splice(index, 1);
        objects.splice(newIndex, 0, obj);
      }

      return {
        canvasData: {
          ...state.canvasData,
          objects,
        },
      };
    });
  },

  // History
  pushHistory: () => set((state) => {
    const newHistory = state.history.slice(0, state.historyIndex + 1);
    newHistory.push(JSON.parse(JSON.stringify(state.canvasData)));
    return {
      history: newHistory.slice(-50), // Keep last 50 states
      historyIndex: Math.min(newHistory.length - 1, 49),
    };
  }),

  undo: () => set((state) => {
    if (state.historyIndex < 0) return state;
    const newIndex = state.historyIndex - 1;
    if (newIndex < 0) return state;
    return {
      canvasData: JSON.parse(JSON.stringify(state.history[newIndex])),
      historyIndex: newIndex,
    };
  }),

  redo: () => set((state) => {
    if (state.historyIndex >= state.history.length - 1) return state;
    const newIndex = state.historyIndex + 1;
    return {
      canvasData: JSON.parse(JSON.stringify(state.history[newIndex])),
      historyIndex: newIndex,
    };
  }),
}));
