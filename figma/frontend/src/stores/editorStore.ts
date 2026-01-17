/**
 * Zustand store for the design editor state.
 * Manages canvas data, selection, tools, viewport, collaboration, and undo/redo history.
 * Provides a centralized state management solution for the editor UI.
 */
import { create } from 'zustand';
import type { DesignObject, Tool, Viewport, PresenceState, CanvasData, Operation } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Operation sender function type - will be set by WebSocket hook
 */
type OperationSender = (operations: Operation[]) => void;

// Global reference to the operation sender (set by WebSocket hook)
let operationSender: OperationSender | null = null;

/**
 * Register the operation sender function from the WebSocket hook
 */
export function setOperationSender(sender: OperationSender | null): void {
  operationSender = sender;
}

/**
 * Helper to create and send an operation via WebSocket
 */
function sendOperation(operation: Operation): void {
  if (operationSender) {
    operationSender([operation]);
  }
}

/**
 * Editor state interface defining all state properties and actions.
 */
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
  setFileId: (id: string | null) => void;
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

/**
 * Default viewport state with no pan and 100% zoom.
 */
const defaultViewport: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

/**
 * Default empty canvas with a single page.
 */
const defaultCanvasData: CanvasData = {
  objects: [],
  pages: [{ id: 'page-1', name: 'Page 1', objects: [] }],
};

/**
 * The main editor store hook.
 * Provides access to editor state and actions throughout the application.
 * Uses Zustand for performant, minimal re-renders.
 */
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
  setViewport: (viewport) =>
    set((state) => ({
      viewport: { ...state.viewport, ...viewport },
    })),

  setCollaborators: (collaborators) => set({ collaborators }),

  updateCollaborator: (presence) =>
    set((state) => {
      const existing = state.collaborators.findIndex((c) => c.userId === presence.userId);
      if (existing !== -1) {
        const updated = [...state.collaborators];
        updated[existing] = presence;
        return { collaborators: updated };
      }
      return { collaborators: [...state.collaborators, presence] };
    }),

  removeCollaborator: (userId) =>
    set((state) => ({
      collaborators: state.collaborators.filter((c) => c.userId !== userId),
    })),

  setUserInfo: (userId, userName, userColor) => set({ userId, userName, userColor }),

  // Object operations - send operations via WebSocket for multi-user sync
  addObject: (obj) => {
    const state = get();
    state.pushHistory();

    // Create and send operation for multi-user sync
    const operation: Operation = {
      id: uuidv4(),
      fileId: state.fileId || '',
      userId: state.userId,
      operationType: 'create',
      objectId: obj.id,
      newValue: obj,
      timestamp: Date.now(),
      clientId: state.userId,
    };
    sendOperation(operation);

    // Apply locally (optimistic update)
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

    // Create and send operation for multi-user sync
    const operation: Operation = {
      id: uuidv4(),
      fileId: state.fileId || '',
      userId: state.userId,
      operationType: 'update',
      objectId: id,
      newValue: updates,
      timestamp: Date.now(),
      clientId: state.userId,
    };
    sendOperation(operation);

    // Apply locally (optimistic update)
    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: state.canvasData.objects.map((obj) =>
          obj.id === id ? { ...obj, ...updates } : obj
        ),
      },
    }));
  },

  deleteObject: (id) => {
    const state = get();
    state.pushHistory();

    // Create and send operation for multi-user sync
    const operation: Operation = {
      id: uuidv4(),
      fileId: state.fileId || '',
      userId: state.userId,
      operationType: 'delete',
      objectId: id,
      timestamp: Date.now(),
      clientId: state.userId,
    };
    sendOperation(operation);

    // Apply locally (optimistic update)
    set((state) => ({
      canvasData: {
        ...state.canvasData,
        objects: state.canvasData.objects.filter((obj) => obj.id !== id),
      },
      selectedIds: state.selectedIds.filter((sid) => sid !== id),
    }));
  },

  duplicateObject: (id) => {
    const state = get();
    const obj = state.canvasData.objects.find((o) => o.id === id);
    if (!obj) return;

    state.pushHistory();
    const newObj: DesignObject = {
      ...obj,
      id: uuidv4(),
      name: `${obj.name} copy`,
      x: obj.x + 20,
      y: obj.y + 20,
    };

    // Create and send operation for multi-user sync
    const operation: Operation = {
      id: uuidv4(),
      fileId: state.fileId || '',
      userId: state.userId,
      operationType: 'create',
      objectId: newObj.id,
      newValue: newObj,
      timestamp: Date.now(),
      clientId: state.userId,
    };
    sendOperation(operation);

    // Apply locally (optimistic update)
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
      const index = objects.findIndex((o) => o.id === id);
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

        // Create and send operation for multi-user sync
        const operation: Operation = {
          id: uuidv4(),
          fileId: state.fileId || '',
          userId: state.userId,
          operationType: 'move',
          objectId: id,
          oldValue: index,
          newValue: newIndex,
          timestamp: Date.now(),
          clientId: state.userId,
        };
        sendOperation(operation);
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
  pushHistory: () =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(JSON.parse(JSON.stringify(state.canvasData)));
      return {
        history: newHistory.slice(-50), // Keep last 50 states
        historyIndex: Math.min(newHistory.length - 1, 49),
      };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex < 0) return state;
      const newIndex = state.historyIndex - 1;
      if (newIndex < 0) return state;
      return {
        canvasData: JSON.parse(JSON.stringify(state.history[newIndex])),
        historyIndex: newIndex,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex >= state.history.length - 1) return state;
      const newIndex = state.historyIndex + 1;
      return {
        canvasData: JSON.parse(JSON.stringify(state.history[newIndex])),
        historyIndex: newIndex,
      };
    }),
}));
