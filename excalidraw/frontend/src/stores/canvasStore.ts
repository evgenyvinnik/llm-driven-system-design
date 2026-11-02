import { create } from 'zustand';
import type { ExcalidrawElement, Tool, Cursor, ViewState, Point } from '../types';

interface CanvasState {
  // Elements
  elements: ExcalidrawElement[];
  selectedElementId: string | null;

  // Active tool
  activeTool: Tool;

  // Viewport
  viewState: ViewState;

  // Drawing state
  isDrawing: boolean;
  drawingStartPoint: Point | null;
  currentPoints: Point[];

  // Cursors
  cursors: Cursor[];

  // Whether the server lets this connection edit the open drawing.
  canEdit: boolean;

  // Style
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  opacity: number;
  fontSize: number;

  // Actions
  setElements: (elements: ExcalidrawElement[]) => void;
  addElement: (element: ExcalidrawElement) => void;
  updateElement: (id: string, updates: Partial<ExcalidrawElement>) => void;
  deleteElement: (id: string) => void;
  applyRemoteElement: (element: ExcalidrawElement) => void;
  applyRemoteMove: (element: ExcalidrawElement) => void;
  setSelectedElementId: (id: string | null) => void;
  setActiveTool: (tool: Tool) => void;
  setViewState: (viewState: Partial<ViewState>) => void;
  setIsDrawing: (isDrawing: boolean) => void;
  setDrawingStartPoint: (point: Point | null) => void;
  setCurrentPoints: (points: Point[]) => void;
  addCurrentPoint: (point: Point) => void;
  setCursors: (cursors: Cursor[]) => void;
  updateCursor: (cursor: Cursor) => void;
  removeCursor: (clientId: string) => void;
  setCanEdit: (canEdit: boolean) => void;
  resetForDrawing: () => void;
  setStrokeColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setStrokeWidth: (width: number) => void;
  setOpacity: (opacity: number) => void;
  setFontSize: (size: number) => void;
  clearCanvas: () => void;
}

/** Canvas state with elements, tool selection, viewport, and collaboration cursors. */
export const useCanvasStore = create<CanvasState>()((set) => ({
  elements: [],
  selectedElementId: null,
  activeTool: 'select',
  viewState: { scrollX: 0, scrollY: 0, zoom: 1 },
  isDrawing: false,
  drawingStartPoint: null,
  currentPoints: [],
  cursors: [],
  canEdit: false,
  strokeColor: '#1e1e1e',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  fontSize: 16,

  setElements: (elements) => set({ elements }),

  addElement: (element) =>
    set((state) => ({
      elements: [...state.elements, element],
    })),

  updateElement: (id, updates) =>
    set((state) => ({
      elements: state.elements.map((el) =>
        el.id === id ? { ...el, ...updates, version: el.version + 1, updatedAt: Date.now() } : el
      ),
    })),

  deleteElement: (id) =>
    set((state) => ({
      elements: state.elements.map((el) =>
        el.id === id ? { ...el, isDeleted: true, version: el.version + 1, updatedAt: Date.now() } : el
      ),
      selectedElementId: state.selectedElementId === id ? null : state.selectedElementId,
    })),

  // Remote changes follow the server's last-writer-wins rule and keep the
  // sender's version. Routing them through updateElement bumped the version a
  // second time, so this client's copy disagreed with everyone else's.
  applyRemoteElement: (element) =>
    set((state) => {
      const index = state.elements.findIndex((el) => el.id === element.id);
      if (index === -1) return { elements: [...state.elements, element] };
      const current = state.elements[index];
      const wins =
        element.version > current.version ||
        (element.version === current.version && element.updatedAt > current.updatedAt);
      if (!wins) return {};
      const elements = [...state.elements];
      elements[index] = element;
      return { elements };
    }),

  applyRemoteMove: (element) =>
    set((state) => ({
      elements: state.elements.map((el) =>
        el.id === element.id
          ? { ...el, x: element.x, y: element.y, version: Math.max(el.version, element.version) }
          : el
      ),
    })),

  setSelectedElementId: (id) => set({ selectedElementId: id }),

  setActiveTool: (tool) => set({ activeTool: tool, selectedElementId: null }),

  setViewState: (viewState) =>
    set((state) => ({
      viewState: { ...state.viewState, ...viewState },
    })),

  setIsDrawing: (isDrawing) => set({ isDrawing }),

  setDrawingStartPoint: (point) => set({ drawingStartPoint: point }),

  setCurrentPoints: (points) => set({ currentPoints: points }),

  addCurrentPoint: (point) =>
    set((state) => ({
      currentPoints: [...state.currentPoints, point],
    })),

  setCursors: (cursors) => set({ cursors }),

  updateCursor: (cursor) =>
    set((state) => {
      const existing = state.cursors.findIndex((c) => c.clientId === cursor.clientId);
      if (existing >= 0) {
        const updated = [...state.cursors];
        updated[existing] = cursor;
        return { cursors: updated };
      }
      return { cursors: [...state.cursors, cursor] };
    }),

  removeCursor: (clientId) =>
    set((state) => ({
      cursors: state.cursors.filter((c) => c.clientId !== clientId),
    })),

  setCanEdit: (canEdit) => set({ canEdit }),

  // Opening another drawing must not inherit the previous one's scene,
  // selection, viewport, cursors, or edit rights.
  resetForDrawing: () =>
    set({
      elements: [],
      selectedElementId: null,
      activeTool: 'select',
      viewState: { scrollX: 0, scrollY: 0, zoom: 1 },
      isDrawing: false,
      drawingStartPoint: null,
      currentPoints: [],
      cursors: [],
      canEdit: false,
    }),

  setStrokeColor: (color) => set({ strokeColor: color }),
  setFillColor: (color) => set({ fillColor: color }),
  setStrokeWidth: (width) => set({ strokeWidth: width }),
  setOpacity: (opacity) => set({ opacity }),
  setFontSize: (size) => set({ fontSize: size }),

  clearCanvas: () => set({ elements: [], selectedElementId: null }),
}));
