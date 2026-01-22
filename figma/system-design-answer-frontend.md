# Figma - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

## Opening Statement

"Today I'll design Figma, a real-time collaborative design platform, focusing on the frontend architecture. The core challenges are building a high-performance WebGL canvas renderer, managing complex editor state with Zustand, implementing real-time collaboration with cursor presence, and creating an intuitive design tool interface with panels for layers and properties."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **WebGL Canvas Editor** - Hardware-accelerated vector graphics with pan/zoom
2. **Shape Tools** - Create rectangles, ellipses, text, frames, groups
3. **Selection System** - Click, shift-click, marquee selection with resize handles
4. **Layers Panel** - Hierarchical object list with visibility/lock toggles
5. **Properties Panel** - Live-updating form for selected object properties
6. **Real-time Cursors** - See collaborators' cursor positions and selections
7. **Version History** - Browse and restore previous versions
8. **File Browser** - Grid view of files with create/delete actions

### Non-Functional Requirements

- **Performance**: 60fps canvas rendering with 10,000+ objects
- **Latency**: < 50ms for local operations, cursor updates visible within 100ms
- **Responsiveness**: Usable on 1280px+ screens, graceful degradation on smaller
- **Accessibility**: Keyboard shortcuts, focus management, screen reader support for panels

### Out of Scope

- Component library management
- Prototyping/interactions
- Export functionality
- Plugin system

---

## Step 2: Frontend Architecture Overview (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              App.tsx                                        │
│                    (Route: FileBrowser <-> Editor)                          │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            ▼                                         ▼
┌──────────────────────┐               ┌───────────────────────────────────────┐
│    FileBrowser.tsx   │               │              Editor.tsx               │
│  ┌────────────────┐  │               │  (Main workspace container)           │
│  │ File grid      │  │               │                                       │
│  │ Create/Delete  │  │               │  ┌─────────────────────────────────┐  │
│  └────────────────┘  │               │  │           Toolbar.tsx           │  │
└──────────────────────┘               │  │  [Select|Hand|Shapes|Zoom|User] │  │
                                       │  └─────────────────────────────────┘  │
                                       │                                       │
                                       │  ┌─────────┬───────────┬───────────┐  │
                                       │  │ Layers  │  Canvas   │ Properties│  │
                                       │  │ Panel   │           │  Panel    │  │
                                       │  │ .tsx    │  .tsx     │  .tsx     │  │
                                       │  └─────────┴───────────┴───────────┘  │
                                       │                                       │
                                       │  ┌─────────────────────────────────┐  │
                                       │  │    VersionHistory.tsx (Modal)   │  │
                                       │  └─────────────────────────────────┘  │
                                       └───────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Framework | React 19 | Component architecture, hooks |
| Build | Vite | Fast HMR, TypeScript |
| State | Zustand | Global editor state |
| Rendering | PixiJS (WebGL) | GPU-accelerated canvas |
| Styling | Tailwind CSS | Utility-first styles |
| WebSocket | Native API | Real-time sync |
| Routing | TanStack Router | File browser navigation |

---

## Step 3: Deep Dive - PixiJS Canvas Renderer (10 minutes)

### Why PixiJS for Design Tools

PixiJS provides hardware-accelerated 2D rendering via WebGL with a simple API:

```typescript
// renderer/PixiRenderer.ts
import * as PIXI from 'pixi.js';
import { ShapeFactory } from './ShapeFactory';
import { SelectionOverlay } from './SelectionOverlay';
import { CollaboratorCursors } from './CollaboratorCursors';

export class PixiRenderer {
  private app: PIXI.Application;
  private objectsContainer: PIXI.Container;
  private selectionContainer: PIXI.Container;
  private presenceContainer: PIXI.Container;

  private objectMap = new Map<string, PIXI.DisplayObject>();
  private shapeFactory: ShapeFactory;
  private selectionOverlay: SelectionOverlay;
  private cursors: CollaboratorCursors;

  constructor(canvas: HTMLCanvasElement) {
    this.app = new PIXI.Application({
      view: canvas,
      resizeTo: canvas.parentElement!,
      backgroundColor: 0xf5f5f5,
      antialias: true,
      resolution: window.devicePixelRatio,
    });

    // Z-ordered containers
    this.objectsContainer = new PIXI.Container();
    this.selectionContainer = new PIXI.Container();
    this.presenceContainer = new PIXI.Container();

    this.app.stage.addChild(this.objectsContainer);
    this.app.stage.addChild(this.selectionContainer);
    this.app.stage.addChild(this.presenceContainer);

    this.shapeFactory = new ShapeFactory();
    this.selectionOverlay = new SelectionOverlay(this.selectionContainer);
    this.cursors = new CollaboratorCursors(this.presenceContainer);
  }

  render(canvasData: CanvasData, selectedIds: string[], viewport: Viewport): void {
    // Apply viewport transform (pan + zoom)
    this.objectsContainer.position.set(viewport.x, viewport.y);
    this.objectsContainer.scale.set(viewport.zoom);

    // Sync objects
    const currentIds = new Set(canvasData.objects.map(o => o.id));

    // Remove deleted objects
    for (const [id, displayObj] of this.objectMap) {
      if (!currentIds.has(id)) {
        this.objectsContainer.removeChild(displayObj);
        this.objectMap.delete(id);
      }
    }

    // Add/update objects
    for (const obj of canvasData.objects) {
      let displayObj = this.objectMap.get(obj.id);

      if (!displayObj) {
        displayObj = this.shapeFactory.create(obj);
        this.objectsContainer.addChild(displayObj);
        this.objectMap.set(obj.id, displayObj);
      } else {
        this.shapeFactory.update(displayObj, obj);
      }

      // Apply visibility and opacity
      displayObj.visible = obj.visible;
      displayObj.alpha = obj.opacity;
    }

    // Update selection overlay
    const selectedObjects = canvasData.objects.filter(o => selectedIds.includes(o.id));
    this.selectionOverlay.render(selectedObjects, viewport);
  }

  renderPresence(collaborators: Presence[], viewport: Viewport): void {
    this.cursors.render(collaborators, viewport);
  }

  hitTest(x: number, y: number): string | null {
    // Convert screen coords to canvas coords
    const point = new PIXI.Point(x, y);
    const hit = this.app.renderer.plugins.interaction.hitTest(point);
    return hit?.name ?? null;
  }

  destroy(): void {
    this.app.destroy(true);
  }
}
```

### Shape Factory for Object Types

```typescript
// renderer/ShapeFactory.ts
export class ShapeFactory {
  create(obj: DesignObject): PIXI.Graphics | PIXI.Text {
    switch (obj.type) {
      case 'rectangle':
        return this.createRectangle(obj);
      case 'ellipse':
        return this.createEllipse(obj);
      case 'text':
        return this.createText(obj);
      default:
        return this.createRectangle(obj); // Fallback
    }
  }

  private createRectangle(obj: DesignObject): PIXI.Graphics {
    const g = new PIXI.Graphics();
    g.name = obj.id; // For hit testing

    this.drawRectangle(g, obj);
    g.position.set(obj.x, obj.y);
    g.angle = obj.rotation;

    // Enable interaction for hit testing
    g.eventMode = 'static';

    return g;
  }

  private drawRectangle(g: PIXI.Graphics, obj: DesignObject): void {
    g.clear();

    // Fill
    if (obj.fill && obj.fill !== 'transparent') {
      g.beginFill(this.colorToHex(obj.fill));
      g.drawRect(0, 0, obj.width, obj.height);
      g.endFill();
    }

    // Stroke
    if (obj.stroke && obj.strokeWidth > 0) {
      g.lineStyle(obj.strokeWidth, this.colorToHex(obj.stroke));
      g.drawRect(0, 0, obj.width, obj.height);
    }
  }

  private createEllipse(obj: DesignObject): PIXI.Graphics {
    const g = new PIXI.Graphics();
    g.name = obj.id;

    g.beginFill(this.colorToHex(obj.fill));
    g.drawEllipse(obj.width / 2, obj.height / 2, obj.width / 2, obj.height / 2);
    g.endFill();

    if (obj.stroke && obj.strokeWidth > 0) {
      g.lineStyle(obj.strokeWidth, this.colorToHex(obj.stroke));
      g.drawEllipse(obj.width / 2, obj.height / 2, obj.width / 2, obj.height / 2);
    }

    g.position.set(obj.x, obj.y);
    g.angle = obj.rotation;
    g.eventMode = 'static';

    return g;
  }

  private createText(obj: DesignObject): PIXI.Text {
    const style = new PIXI.TextStyle({
      fontFamily: obj.fontFamily || 'Inter',
      fontSize: obj.fontSize || 16,
      fill: this.colorToHex(obj.fill),
    });

    const text = new PIXI.Text(obj.text || 'Text', style);
    text.name = obj.id;
    text.position.set(obj.x, obj.y);
    text.angle = obj.rotation;
    text.eventMode = 'static';

    return text;
  }

  update(displayObj: PIXI.DisplayObject, obj: DesignObject): void {
    displayObj.position.set(obj.x, obj.y);
    displayObj.angle = obj.rotation;

    if (displayObj instanceof PIXI.Graphics) {
      if (obj.type === 'rectangle') {
        this.drawRectangle(displayObj, obj);
      } else if (obj.type === 'ellipse') {
        this.drawEllipse(displayObj, obj);
      }
    } else if (displayObj instanceof PIXI.Text) {
      displayObj.text = obj.text || '';
      displayObj.style.fontSize = obj.fontSize || 16;
      displayObj.style.fill = this.colorToHex(obj.fill);
    }
  }

  private colorToHex(color: string): number {
    if (!color || color === 'transparent') return 0x000000;
    return parseInt(color.replace('#', ''), 16);
  }
}
```

### Selection Overlay with Resize Handles

```typescript
// renderer/SelectionOverlay.ts
export class SelectionOverlay {
  private container: PIXI.Container;
  private bounds: PIXI.Graphics;
  private handles: PIXI.Graphics[] = [];

  constructor(container: PIXI.Container) {
    this.container = container;
    this.bounds = new PIXI.Graphics();
    this.container.addChild(this.bounds);

    // Create 8 resize handles
    for (let i = 0; i < 8; i++) {
      const handle = new PIXI.Graphics();
      handle.beginFill(0xffffff);
      handle.lineStyle(1, 0x0d99ff);
      handle.drawRect(-4, -4, 8, 8);
      handle.endFill();
      handle.eventMode = 'static';
      handle.cursor = this.getHandleCursor(i);
      this.handles.push(handle);
      this.container.addChild(handle);
    }
  }

  render(selectedObjects: DesignObject[], viewport: Viewport): void {
    this.bounds.clear();
    this.handles.forEach(h => h.visible = false);

    if (selectedObjects.length === 0) return;

    // Calculate bounding box
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const obj of selectedObjects) {
      minX = Math.min(minX, obj.x);
      minY = Math.min(minY, obj.y);
      maxX = Math.max(maxX, obj.x + obj.width);
      maxY = Math.max(maxY, obj.y + obj.height);
    }

    // Transform to screen coords
    const screenMinX = minX * viewport.zoom + viewport.x;
    const screenMinY = minY * viewport.zoom + viewport.y;
    const screenWidth = (maxX - minX) * viewport.zoom;
    const screenHeight = (maxY - minY) * viewport.zoom;

    // Draw bounds rectangle
    this.bounds.lineStyle(1, 0x0d99ff);
    this.bounds.drawRect(screenMinX, screenMinY, screenWidth, screenHeight);

    // Position handles
    const positions = [
      [screenMinX, screenMinY],                           // NW
      [screenMinX + screenWidth / 2, screenMinY],        // N
      [screenMinX + screenWidth, screenMinY],            // NE
      [screenMinX + screenWidth, screenMinY + screenHeight / 2], // E
      [screenMinX + screenWidth, screenMinY + screenHeight],     // SE
      [screenMinX + screenWidth / 2, screenMinY + screenHeight], // S
      [screenMinX, screenMinY + screenHeight],           // SW
      [screenMinX, screenMinY + screenHeight / 2],       // W
    ];

    positions.forEach((pos, i) => {
      this.handles[i].position.set(pos[0], pos[1]);
      this.handles[i].visible = true;
    });
  }

  private getHandleCursor(index: number): string {
    const cursors = ['nw-resize', 'n-resize', 'ne-resize', 'e-resize',
                     'se-resize', 's-resize', 'sw-resize', 'w-resize'];
    return cursors[index];
  }
}
```

---

## Step 4: Deep Dive - Zustand State Management (10 minutes)

### Editor Store Design

```typescript
// stores/editorStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

interface EditorState {
  // Canvas data
  canvasData: CanvasData;

  // Selection
  selectedIds: string[];

  // Tools
  activeTool: 'select' | 'hand' | 'rectangle' | 'ellipse' | 'text';

  // Viewport
  viewport: Viewport;

  // Collaboration
  collaborators: Presence[];
  myUserId: string;
  myColor: string;

  // History
  history: CanvasData[];
  historyIndex: number;

  // Connection
  wsConnected: boolean;

  // Actions
  setCanvasData: (data: CanvasData) => void;
  addObject: (obj: DesignObject) => void;
  updateObject: (id: string, updates: Partial<DesignObject>) => void;
  deleteObjects: (ids: string[]) => void;
  setSelectedIds: (ids: string[]) => void;
  setActiveTool: (tool: EditorState['activeTool']) => void;
  setViewport: (viewport: Viewport) => void;
  updateCollaborators: (collaborators: Presence[]) => void;
  undo: () => void;
  redo: () => void;
  pushHistory: () => void;
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    canvasData: { objects: [], pages: [] },
    selectedIds: [],
    activeTool: 'select',
    viewport: { x: 0, y: 0, zoom: 1 },
    collaborators: [],
    myUserId: '',
    myColor: '#0d99ff',
    history: [],
    historyIndex: -1,
    wsConnected: false,

    setCanvasData: (data) => set((state) => {
      state.canvasData = data;
    }),

    addObject: (obj) => set((state) => {
      state.canvasData.objects.push(obj);
      // Select the new object
      state.selectedIds = [obj.id];
    }),

    updateObject: (id, updates) => set((state) => {
      const idx = state.canvasData.objects.findIndex(o => o.id === id);
      if (idx !== -1) {
        Object.assign(state.canvasData.objects[idx], updates);
      }
    }),

    deleteObjects: (ids) => set((state) => {
      state.canvasData.objects = state.canvasData.objects.filter(
        o => !ids.includes(o.id)
      );
      state.selectedIds = state.selectedIds.filter(id => !ids.includes(id));
    }),

    setSelectedIds: (ids) => set((state) => {
      state.selectedIds = ids;
    }),

    setActiveTool: (tool) => set((state) => {
      state.activeTool = tool;
      if (tool !== 'select') {
        state.selectedIds = [];
      }
    }),

    setViewport: (viewport) => set((state) => {
      state.viewport = viewport;
    }),

    updateCollaborators: (collaborators) => set((state) => {
      state.collaborators = collaborators;
    }),

    undo: () => set((state) => {
      if (state.historyIndex > 0) {
        state.historyIndex--;
        state.canvasData = JSON.parse(JSON.stringify(state.history[state.historyIndex]));
      }
    }),

    redo: () => set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        state.canvasData = JSON.parse(JSON.stringify(state.history[state.historyIndex]));
      }
    }),

    pushHistory: () => set((state) => {
      // Truncate future history if we're not at the end
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(JSON.parse(JSON.stringify(state.canvasData)));
      state.historyIndex = state.history.length - 1;

      // Limit history size
      if (state.history.length > 50) {
        state.history.shift();
        state.historyIndex--;
      }
    }),
  }))
);
```

### Derived Selectors

```typescript
// stores/selectors.ts
import { useEditorStore } from './editorStore';

export const useSelectedObjects = () => {
  return useEditorStore((state) => {
    const { objects } = state.canvasData;
    return objects.filter(o => state.selectedIds.includes(o.id));
  });
};

export const useSingleSelectedObject = () => {
  const selectedObjects = useSelectedObjects();
  return selectedObjects.length === 1 ? selectedObjects[0] : null;
};

export const useCanUndo = () => {
  return useEditorStore((state) => state.historyIndex > 0);
};

export const useCanRedo = () => {
  return useEditorStore((state) =>
    state.historyIndex < state.history.length - 1
  );
};

export const useActiveCollaborators = () => {
  return useEditorStore((state) =>
    state.collaborators.filter(c => c.userId !== state.myUserId)
  );
};
```

---

## Step 5: Deep Dive - Canvas Component with Event Handling (8 minutes)

### Main Canvas Component

```typescript
// components/Canvas.tsx
import { useRef, useEffect, useCallback, useState } from 'react';
import { useEditorStore, useSelectedObjects } from '../stores/editorStore';
import { PixiRenderer } from '../renderer/PixiRenderer';
import { generateId } from '../utils/id';

export function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PixiRenderer | null>(null);

  const canvasData = useEditorStore(s => s.canvasData);
  const selectedIds = useEditorStore(s => s.selectedIds);
  const viewport = useEditorStore(s => s.viewport);
  const activeTool = useEditorStore(s => s.activeTool);
  const collaborators = useEditorStore(s => s.collaborators);

  const { addObject, updateObject, setSelectedIds, setViewport, pushHistory } = useEditorStore();

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<'move' | 'pan' | 'draw' | null>(null);

  // Initialize renderer
  useEffect(() => {
    if (canvasRef.current && !rendererRef.current) {
      rendererRef.current = new PixiRenderer(canvasRef.current);
    }

    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Render on state change
  useEffect(() => {
    rendererRef.current?.render(canvasData, selectedIds, viewport);
  }, [canvasData, selectedIds, viewport]);

  // Render presence
  useEffect(() => {
    rendererRef.current?.renderPresence(collaborators, viewport);
  }, [collaborators, viewport]);

  // Convert screen coords to canvas coords
  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    return {
      x: (screenX - viewport.x) / viewport.zoom,
      y: (screenY - viewport.y) / viewport.zoom,
    };
  }, [viewport]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const canvasPos = screenToCanvas(screenX, screenY);

    setDragStart({ x: screenX, y: screenY });
    setIsDragging(true);

    if (activeTool === 'hand') {
      setDragMode('pan');
    } else if (activeTool === 'select') {
      // Hit test
      const hitId = rendererRef.current?.hitTest(screenX, screenY);

      if (hitId) {
        if (e.shiftKey) {
          // Toggle selection
          setSelectedIds(
            selectedIds.includes(hitId)
              ? selectedIds.filter(id => id !== hitId)
              : [...selectedIds, hitId]
          );
        } else if (!selectedIds.includes(hitId)) {
          setSelectedIds([hitId]);
        }
        setDragMode('move');
      } else {
        setSelectedIds([]);
        setDragMode(null);
      }
    } else if (['rectangle', 'ellipse', 'text'].includes(activeTool)) {
      // Start drawing
      const newObject: DesignObject = {
        id: generateId(),
        type: activeTool as DesignObject['type'],
        name: `${activeTool} 1`,
        x: canvasPos.x,
        y: canvasPos.y,
        width: 0,
        height: 0,
        rotation: 0,
        fill: '#cccccc',
        stroke: '#000000',
        strokeWidth: 1,
        opacity: 1,
        visible: true,
        locked: false,
        text: activeTool === 'text' ? 'Text' : undefined,
        fontSize: activeTool === 'text' ? 16 : undefined,
      };
      addObject(newObject);
      setDragMode('draw');
    }
  }, [activeTool, selectedIds, screenToCanvas, addObject, setSelectedIds]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    if (!isDragging) return;

    const deltaX = screenX - dragStart.x;
    const deltaY = screenY - dragStart.y;

    if (dragMode === 'pan') {
      setViewport({
        ...viewport,
        x: viewport.x + deltaX,
        y: viewport.y + deltaY,
      });
      setDragStart({ x: screenX, y: screenY });
    } else if (dragMode === 'move' && selectedIds.length > 0) {
      // Move selected objects
      const canvasDelta = {
        x: deltaX / viewport.zoom,
        y: deltaY / viewport.zoom,
      };

      selectedIds.forEach(id => {
        const obj = canvasData.objects.find(o => o.id === id);
        if (obj && !obj.locked) {
          updateObject(id, {
            x: obj.x + canvasDelta.x,
            y: obj.y + canvasDelta.y,
          });
        }
      });
      setDragStart({ x: screenX, y: screenY });
    } else if (dragMode === 'draw' && selectedIds.length === 1) {
      // Resize drawing object
      const startCanvas = screenToCanvas(dragStart.x, dragStart.y);
      const endCanvas = screenToCanvas(screenX, screenY);

      updateObject(selectedIds[0], {
        width: Math.abs(endCanvas.x - startCanvas.x),
        height: Math.abs(endCanvas.y - startCanvas.y),
        x: Math.min(startCanvas.x, endCanvas.x),
        y: Math.min(startCanvas.y, endCanvas.y),
      });
    }
  }, [isDragging, dragMode, dragStart, viewport, selectedIds, canvasData, updateObject, setViewport, screenToCanvas]);

  const handleMouseUp = useCallback(() => {
    if (isDragging && (dragMode === 'move' || dragMode === 'draw')) {
      pushHistory();
    }
    setIsDragging(false);
    setDragMode(null);
  }, [isDragging, dragMode, pushHistory]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();

    const rect = canvasRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom toward mouse position
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(5, viewport.zoom * zoomFactor));

    // Adjust pan to keep mouse position stable
    const mouseCanvasX = (mouseX - viewport.x) / viewport.zoom;
    const mouseCanvasY = (mouseY - viewport.y) / viewport.zoom;

    setViewport({
      zoom: newZoom,
      x: mouseX - mouseCanvasX * newZoom,
      y: mouseY - mouseCanvasY * newZoom,
    });
  }, [viewport, setViewport]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full cursor-crosshair"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    />
  );
}
```

---

## Step 6: Deep Dive - Panels and UI Components (5 minutes)

### Layers Panel

```typescript
// components/LayersPanel.tsx
import { useEditorStore } from '../stores/editorStore';
import { EyeIcon, EyeSlashIcon, LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline';

export function LayersPanel() {
  const objects = useEditorStore(s => s.canvasData.objects);
  const selectedIds = useEditorStore(s => s.selectedIds);
  const { setSelectedIds, updateObject } = useEditorStore();

  // Reverse order (top of stack at top of list)
  const reversedObjects = [...objects].reverse();

  return (
    <div className="w-60 bg-gray-900 text-white flex flex-col">
      <div className="px-3 py-2 border-b border-gray-700 font-medium text-sm">
        Layers
      </div>

      <div className="flex-1 overflow-y-auto">
        {reversedObjects.map((obj) => (
          <LayerItem
            key={obj.id}
            object={obj}
            isSelected={selectedIds.includes(obj.id)}
            onSelect={(id, multi) => {
              if (multi) {
                setSelectedIds(
                  selectedIds.includes(id)
                    ? selectedIds.filter(i => i !== id)
                    : [...selectedIds, id]
                );
              } else {
                setSelectedIds([id]);
              }
            }}
            onToggleVisibility={(id) => {
              updateObject(id, { visible: !obj.visible });
            }}
            onToggleLock={(id) => {
              updateObject(id, { locked: !obj.locked });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function LayerItem({ object, isSelected, onSelect, onToggleVisibility, onToggleLock }: {
  object: DesignObject;
  isSelected: boolean;
  onSelect: (id: string, multi: boolean) => void;
  onToggleVisibility: (id: string) => void;
  onToggleLock: (id: string) => void;
}) {
  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-1.5 cursor-pointer
        ${isSelected ? 'bg-blue-600' : 'hover:bg-gray-800'}
        ${!object.visible ? 'opacity-50' : ''}
      `}
      onClick={(e) => onSelect(object.id, e.shiftKey)}
    >
      <ShapeIcon type={object.type} />

      <span className="flex-1 text-sm truncate">{object.name}</span>

      <button
        className="p-1 hover:bg-gray-700 rounded"
        onClick={(e) => { e.stopPropagation(); onToggleVisibility(object.id); }}
      >
        {object.visible ? (
          <EyeIcon className="w-4 h-4" />
        ) : (
          <EyeSlashIcon className="w-4 h-4" />
        )}
      </button>

      <button
        className="p-1 hover:bg-gray-700 rounded"
        onClick={(e) => { e.stopPropagation(); onToggleLock(object.id); }}
      >
        {object.locked ? (
          <LockClosedIcon className="w-4 h-4" />
        ) : (
          <LockOpenIcon className="w-4 h-4 opacity-50" />
        )}
      </button>
    </div>
  );
}
```

### Properties Panel

```typescript
// components/PropertiesPanel.tsx
import { useSingleSelectedObject } from '../stores/selectors';
import { useEditorStore } from '../stores/editorStore';

export function PropertiesPanel() {
  const selected = useSingleSelectedObject();
  const { updateObject, pushHistory } = useEditorStore();

  if (!selected) {
    return (
      <div className="w-64 bg-gray-100 p-4 text-gray-500 text-sm">
        Select an object to edit its properties
      </div>
    );
  }

  const handleChange = (key: keyof DesignObject, value: unknown) => {
    updateObject(selected.id, { [key]: value });
  };

  const handleBlur = () => {
    pushHistory();
  };

  return (
    <div className="w-64 bg-gray-100 p-4 flex flex-col gap-4">
      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Position</h3>
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="X" value={selected.x} onChange={v => handleChange('x', v)} onBlur={handleBlur} />
          <NumberInput label="Y" value={selected.y} onChange={v => handleChange('y', v)} onBlur={handleBlur} />
          <NumberInput label="W" value={selected.width} onChange={v => handleChange('width', v)} onBlur={handleBlur} />
          <NumberInput label="H" value={selected.height} onChange={v => handleChange('height', v)} onBlur={handleBlur} />
        </div>
      </section>

      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Appearance</h3>
        <ColorInput label="Fill" value={selected.fill} onChange={v => { handleChange('fill', v); handleBlur(); }} />
        <ColorInput label="Stroke" value={selected.stroke} onChange={v => { handleChange('stroke', v); handleBlur(); }} />
        <NumberInput label="Stroke Width" value={selected.strokeWidth} onChange={v => handleChange('strokeWidth', v)} onBlur={handleBlur} />
        <NumberInput label="Opacity" value={selected.opacity * 100} onChange={v => handleChange('opacity', v / 100)} onBlur={handleBlur} min={0} max={100} step={1} />
      </section>

      {selected.type === 'text' && (
        <section>
          <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">Text</h3>
          <textarea
            className="w-full p-2 border rounded text-sm"
            value={selected.text || ''}
            onChange={e => handleChange('text', e.target.value)}
            onBlur={handleBlur}
          />
          <NumberInput label="Font Size" value={selected.fontSize || 16} onChange={v => handleChange('fontSize', v)} onBlur={handleBlur} />
        </section>
      )}
    </div>
  );
}

function NumberInput({ label, value, onChange, onBlur, min, max, step = 1 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onBlur?: () => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-6">{label}</span>
      <input
        type="number"
        className="flex-1 px-2 py-1 border rounded text-sm"
        value={Math.round(value * 100) / 100}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        onBlur={onBlur}
        min={min}
        max={max}
        step={step}
      />
    </label>
  );
}

function ColorInput({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 mb-2">
      <span className="text-xs text-gray-500 w-16">{label}</span>
      <input
        type="color"
        className="w-8 h-8 border rounded cursor-pointer"
        value={value || '#000000'}
        onChange={e => onChange(e.target.value)}
      />
      <input
        type="text"
        className="flex-1 px-2 py-1 border rounded text-sm"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  );
}
```

---

## Step 7: Real-time Collaboration Hook (3 minutes)

### WebSocket Hook

```typescript
// hooks/useWebSocket.ts
import { useEffect, useRef, useCallback } from 'react';
import { useEditorStore } from '../stores/editorStore';

export function useWebSocket(fileId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    setCanvasData,
    updateObject,
    addObject,
    deleteObjects,
    updateCollaborators,
  } = useEditorStore();

  const connect = useCallback(() => {
    if (!fileId) return;

    const ws = new WebSocket(`ws://localhost:3000/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      useEditorStore.setState({ wsConnected: true });

      // Subscribe to file
      ws.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          fileId,
          userId: useEditorStore.getState().myUserId,
          userName: 'Current User',
        },
      }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'sync':
          setCanvasData(message.payload.file.canvasData);
          useEditorStore.setState({ myColor: message.payload.yourColor });
          break;

        case 'operation':
          applyOperations(message.payload.operations);
          break;

        case 'presence':
          updateCollaborators(message.payload.presence);
          break;
      }
    };

    ws.onclose = () => {
      useEditorStore.setState({ wsConnected: false });

      // Reconnect with backoff
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, 2000);
    };
  }, [fileId, setCanvasData, updateCollaborators]);

  const applyOperations = (operations: Operation[]) => {
    for (const op of operations) {
      switch (op.operationType) {
        case 'create':
          addObject(op.payload as DesignObject);
          break;
        case 'update':
          updateObject(op.objectId, op.payload);
          break;
        case 'delete':
          deleteObjects([op.objectId]);
          break;
      }
    }
  };

  const sendOperation = useCallback((operation: Partial<Operation>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'operation',
        payload: { operations: [operation] },
      }));
    }
  }, []);

  const sendPresence = useCallback((cursor: { x: number; y: number }) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'presence',
        payload: { cursor, selection: useEditorStore.getState().selectedIds },
      }));
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { sendOperation, sendPresence };
}
```

---

## Step 8: Trade-offs and Decisions (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| PixiJS over raw Canvas 2D | Higher memory, but 60fps with complex scenes |
| Zustand over Redux | Less boilerplate, simpler for this use case |
| Full rerender on state change | Simpler logic vs. fine-grained updates |
| In-memory undo history | Limited to 50 steps to save memory |
| Immediate property updates | Responsive feel, but more WebSocket traffic |

### Alternatives Considered

1. **Raw WebGL shaders**
   - More control but significantly more complex
   - PixiJS abstracts the shader complexity

2. **Canvas 2D API**
   - Simpler but slower with many objects
   - No GPU acceleration

3. **React-konva**
   - React integration built-in
   - Less flexibility than raw PixiJS

---

## Closing Summary

"I've designed the frontend architecture for a Figma-like collaborative design tool with:

1. **PixiJS Renderer** - GPU-accelerated canvas with object management, selection overlays, and collaborator cursors
2. **Zustand State Management** - Centralized store with immer for immutable updates, history for undo/redo
3. **Canvas Component** - Event handling for selection, moving, drawing, panning, and zooming
4. **Panels** - Layers panel with visibility/lock, Properties panel with live updates
5. **WebSocket Hook** - Real-time collaboration with reconnection logic

The key insight is separating rendering (PixiJS) from state (Zustand) and letting React orchestrate the data flow. Happy to dive deeper into any component."

---

## Future Enhancements

1. **Virtual Rendering** - Only render objects in viewport for 100k+ object files
2. **Web Workers** - Offload hit testing and geometry calculations
3. **Gesture Support** - Touch events for tablet users
4. **Keyboard Shortcuts** - Full shortcut system with customization
5. **Accessibility** - Screen reader support for layer navigation
