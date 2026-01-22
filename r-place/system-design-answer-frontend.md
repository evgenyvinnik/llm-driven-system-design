# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. As a frontend engineer, I'll focus on efficient canvas rendering, real-time WebSocket updates, zoom/pan interactions, cooldown UI, and ensuring smooth performance even with thousands of updates per second. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Interactive Canvas** - Zoomable, pannable grid where users click to place pixels
2. **Color Palette** - 16-color selection with clear visual feedback
3. **Real-time Updates** - See other users' pixel placements instantly
4. **Cooldown Timer** - Visual countdown showing when user can place next pixel
5. **Pixel Info** - Hover to see who placed a pixel and when
6. **History Playback** - Timelapse viewer showing canvas evolution

### Non-Functional Requirements

- **60 FPS** - Smooth zoom/pan even during high update rates
- **Low Latency** - Visual feedback within 100ms of server confirmation
- **Memory Efficient** - Handle 500x500+ canvas without browser lag
- **Mobile Support** - Touch gestures for zoom/pan, responsive layout

### Frontend-Specific Considerations

- Efficient canvas rendering with HTML5 Canvas API
- WebSocket reconnection with exponential backoff
- Optimistic UI updates with rollback on failure
- Responsive design for mobile and desktop

---

## 2. High-Level Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                         React Application                         |
+------------------------------------------------------------------+
|                                                                    |
|  +------------------+  +------------------+  +------------------+  |
|  |    Canvas View   |  |   Color Palette  |  |  Cooldown Timer  |  |
|  |  - Zoom/Pan      |  |  - 16 colors     |  |  - Countdown     |  |
|  |  - Pixel grid    |  |  - Selection     |  |  - Progress bar  |  |
|  |  - Click handler |  |  - Hover preview |  |  - Next place    |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
|           |                     |                     |            |
|           +---------------------+---------------------+            |
|                                 |                                  |
|                    +------------v------------+                     |
|                    |     Zustand Store       |                     |
|                    |  - canvasState (Uint8)  |                     |
|                    |  - selectedColor        |                     |
|                    |  - cooldownEnd          |                     |
|                    |  - viewportPosition     |                     |
|                    |  - zoomLevel            |                     |
|                    +------------+------------+                     |
|                                 |                                  |
|                    +------------v------------+                     |
|                    |   WebSocket Manager     |                     |
|                    |  - Connection state     |                     |
|                    |  - Message batching     |                     |
|                    |  - Reconnection logic   |                     |
|                    +-------------------------+                     |
|                                                                    |
+------------------------------------------------------------------+
                                 |
                                 v
                    +------------------------+
                    |    Backend WebSocket   |
                    |    /ws                 |
                    +------------------------+
```

---

## 3. Deep Dive: Canvas Rendering (10 minutes)

### HTML5 Canvas Architecture

```tsx
interface CanvasViewProps {
  width: number;   // Canvas width in pixels
  height: number;  // Canvas height in pixels
}

export function CanvasView({ width, height }: CanvasViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

  const { canvasData, zoomLevel, viewportX, viewportY } = useCanvasStore();

  // Initialize canvas context
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Disable image smoothing for crisp pixels
    ctx.imageSmoothingEnabled = false;
    ctxRef.current = ctx;

    // Initial render
    renderCanvas();
  }, []);

  // Create ImageData once, reuse for updates
  const imageDataRef = useRef<ImageData | null>(null);

  const renderCanvas = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !canvasData) return;

    // Create or reuse ImageData
    if (!imageDataRef.current) {
      imageDataRef.current = ctx.createImageData(width, height);
    }

    const imageData = imageDataRef.current;
    const pixels = imageData.data;

    // Convert color indices to RGBA
    for (let i = 0; i < canvasData.length; i++) {
      const colorIndex = canvasData[i];
      const color = COLOR_PALETTE[colorIndex];
      const offset = i * 4;

      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
      pixels[offset + 3] = 255;  // Alpha
    }

    // Put image data at origin
    ctx.putImageData(imageData, 0, 0);
  }, [canvasData, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        transform: `scale(${zoomLevel}) translate(${-viewportX}px, ${-viewportY}px)`,
        transformOrigin: 'top left',
        imageRendering: 'pixelated'
      }}
    />
  );
}
```

### Color Palette Definition

```typescript
// 16-color palette (Reddit's r/place palette)
export const COLOR_PALETTE = [
  { r: 255, g: 255, b: 255, name: 'White' },
  { r: 228, g: 228, b: 228, name: 'Light Gray' },
  { r: 136, g: 136, b: 136, name: 'Gray' },
  { r: 34,  g: 34,  b: 34,  name: 'Black' },
  { r: 255, g: 167, b: 209, name: 'Pink' },
  { r: 229, g: 0,   b: 0,   name: 'Red' },
  { r: 229, g: 149, b: 0,   name: 'Orange' },
  { r: 160, g: 106, b: 66,  name: 'Brown' },
  { r: 229, g: 217, b: 0,   name: 'Yellow' },
  { r: 148, g: 224, b: 68,  name: 'Light Green' },
  { r: 2,   g: 190, b: 1,   name: 'Green' },
  { r: 0,   g: 211, b: 221, name: 'Cyan' },
  { r: 0,   g: 131, b: 199, name: 'Light Blue' },
  { r: 0,   g: 0,   b: 234, name: 'Blue' },
  { r: 207, g: 110, b: 228, name: 'Light Purple' },
  { r: 130, g: 0,   b: 128, name: 'Purple' }
];
```

### Efficient Partial Updates

```typescript
// Only update changed pixels instead of full redraw
function updatePixels(updates: PixelUpdate[]): void {
  const ctx = ctxRef.current;
  if (!ctx) return;

  for (const { x, y, color } of updates) {
    // Update internal state
    canvasData[y * CANVAS_WIDTH + x] = color;

    // Draw single pixel
    const c = COLOR_PALETTE[color];
    ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
    ctx.fillRect(x, y, 1, 1);
  }
}
```

### Zoom and Pan Implementation

```tsx
function useZoomPan() {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Mouse wheel zoom
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.5, Math.min(32, zoom * delta));

    // Zoom toward cursor position
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Adjust pan to keep cursor position stable
    const scale = newZoom / zoom;
    setPan({
      x: mouseX - (mouseX - pan.x) * scale,
      y: mouseY - (mouseY - pan.y) * scale
    });

    setZoom(newZoom);
  }, [zoom, pan]);

  // Mouse drag pan
  const handleMouseDown = (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2 || e.ctrlKey) {  // Middle/right click or ctrl
      setIsPanning(true);
      lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isPanning) return;

    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;

    setPan({
      x: pan.x + dx,
      y: pan.y + dy
    });

    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  // Touch gestures for mobile
  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch zoom start
      const dist = getDistance(e.touches[0], e.touches[1]);
      lastPinchDistance.current = dist;
    }
  };

  return { zoom, pan, handlers: { handleWheel, handleMouseDown, handleMouseMove } };
}
```

---

## 4. Deep Dive: Zustand State Management (8 minutes)

### Store Definition

```typescript
interface CanvasState {
  // Canvas data
  canvasData: Uint8Array | null;
  canvasWidth: number;
  canvasHeight: number;

  // User state
  selectedColor: number;
  cooldownEnd: number | null;
  userId: string | null;

  // Viewport state
  zoom: number;
  panX: number;
  panY: number;

  // Connection state
  isConnected: boolean;
  connectionError: string | null;

  // Actions
  setCanvasData: (data: Uint8Array) => void;
  updatePixel: (x: number, y: number, color: number) => void;
  updatePixelsBatch: (updates: PixelUpdate[]) => void;
  setSelectedColor: (color: number) => void;
  setCooldown: (endTime: number) => void;
  setViewport: (zoom: number, panX: number, panY: number) => void;
  setConnectionState: (connected: boolean, error?: string) => void;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  // Initial state
  canvasData: null,
  canvasWidth: 500,
  canvasHeight: 500,
  selectedColor: 0,
  cooldownEnd: null,
  userId: null,
  zoom: 4,
  panX: 0,
  panY: 0,
  isConnected: false,
  connectionError: null,

  // Actions
  setCanvasData: (data) => set({ canvasData: data }),

  updatePixel: (x, y, color) => {
    const { canvasData, canvasWidth } = get();
    if (!canvasData) return;

    const offset = y * canvasWidth + x;
    canvasData[offset] = color;

    // Trigger re-render with new reference
    set({ canvasData: new Uint8Array(canvasData) });
  },

  // Batch updates for efficiency
  updatePixelsBatch: (updates) => {
    const { canvasData, canvasWidth } = get();
    if (!canvasData) return;

    for (const { x, y, color } of updates) {
      const offset = y * canvasWidth + x;
      canvasData[offset] = color;
    }

    set({ canvasData: new Uint8Array(canvasData) });
  },

  setSelectedColor: (color) => set({ selectedColor: color }),

  setCooldown: (endTime) => set({ cooldownEnd: endTime }),

  setViewport: (zoom, panX, panY) => set({ zoom, panX, panY }),

  setConnectionState: (connected, error) => set({
    isConnected: connected,
    connectionError: error ?? null
  })
}));
```

### Optimistic Updates

```typescript
async function placePixel(x: number, y: number): Promise<void> {
  const { selectedColor, cooldownEnd } = useCanvasStore.getState();

  // Check cooldown locally first
  if (cooldownEnd && Date.now() < cooldownEnd) {
    showToast('Wait for cooldown!');
    return;
  }

  // Optimistic update - show immediately
  const previousColor = useCanvasStore.getState().canvasData![y * 500 + x];
  useCanvasStore.getState().updatePixel(x, y, selectedColor);

  try {
    // Send to server via WebSocket
    const result = await wsManager.placePixel(x, y, selectedColor);

    // Set cooldown from server response
    useCanvasStore.getState().setCooldown(result.nextPlacement);

  } catch (error) {
    // Rollback on failure
    useCanvasStore.getState().updatePixel(x, y, previousColor);

    if (error.code === 'RATE_LIMITED') {
      useCanvasStore.getState().setCooldown(Date.now() + error.remainingSeconds * 1000);
      showToast(`Wait ${error.remainingSeconds}s`);
    } else {
      showToast('Failed to place pixel');
    }
  }
}
```

---

## 5. Deep Dive: WebSocket Management (8 minutes)

### WebSocket Manager Class

```typescript
class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private messageQueue: PixelUpdate[] = [];
  private batchInterval: number | null = null;

  connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      useCanvasStore.getState().setConnectionState(true);

      // Start batch processing
      this.batchInterval = window.setInterval(() => this.processBatch(), 50);
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      useCanvasStore.getState().setConnectionState(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      useCanvasStore.getState().setConnectionState(false, 'Connection error');
    };
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'canvas':
        // Initial canvas load
        const data = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
        useCanvasStore.getState().setCanvasData(data);
        break;

      case 'pixels':
        // Batch pixel updates - queue for processing
        this.messageQueue.push(...msg.events);
        break;

      case 'welcome':
        // Connection established, set user info
        useCanvasStore.setState({
          userId: msg.userId,
          cooldownEnd: msg.cooldown > 0 ? Date.now() + msg.cooldown * 1000 : null
        });
        break;

      case 'error':
        this.handleError(msg);
        break;
    }
  }

  private processBatch(): void {
    if (this.messageQueue.length === 0) return;

    // Process all queued updates
    const updates = [...this.messageQueue];
    this.messageQueue = [];

    useCanvasStore.getState().updatePixelsBatch(updates);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      useCanvasStore.getState().setConnectionState(false, 'Connection lost');
      return;
    }

    // Exponential backoff with jitter
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay + jitter);
  }

  async placePixel(x: number, y: number, color: number): Promise<PlaceResult> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      // Generate request ID for response matching
      const requestId = crypto.randomUUID();

      // Store callback for response
      this.pendingRequests.set(requestId, { resolve, reject });

      this.ws.send(JSON.stringify({
        type: 'place',
        x,
        y,
        color,
        requestId
      }));

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 5000);
    });
  }
}

export const wsManager = new WebSocketManager();
```

### Connection Status Indicator

```tsx
function ConnectionStatus() {
  const { isConnected, connectionError } = useCanvasStore();

  if (isConnected) {
    return (
      <div className="flex items-center gap-2 text-green-600">
        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
        <span className="text-sm">Connected</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-red-600">
      <div className="w-2 h-2 bg-red-500 rounded-full" />
      <span className="text-sm">{connectionError || 'Reconnecting...'}</span>
    </div>
  );
}
```

---

## 6. Deep Dive: UI Components (5 minutes)

### Color Palette Component

```tsx
function ColorPalette() {
  const { selectedColor, setSelectedColor } = useCanvasStore();

  return (
    <div className="flex flex-wrap gap-1 p-2 bg-gray-800 rounded-lg max-w-xs">
      {COLOR_PALETTE.map((color, index) => (
        <button
          key={index}
          onClick={() => setSelectedColor(index)}
          className={`
            w-8 h-8 rounded border-2 transition-transform
            ${selectedColor === index
              ? 'border-white scale-110 shadow-lg'
              : 'border-transparent hover:scale-105'}
          `}
          style={{ backgroundColor: `rgb(${color.r},${color.g},${color.b})` }}
          title={color.name}
          aria-label={`Select ${color.name}`}
        />
      ))}
    </div>
  );
}
```

### Cooldown Timer Component

```tsx
function CooldownTimer() {
  const cooldownEnd = useCanvasStore((state) => state.cooldownEnd);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!cooldownEnd) {
      setRemaining(0);
      return;
    }

    const updateRemaining = () => {
      const now = Date.now();
      const diff = Math.max(0, cooldownEnd - now);
      setRemaining(Math.ceil(diff / 1000));
    };

    updateRemaining();
    const interval = setInterval(updateRemaining, 100);

    return () => clearInterval(interval);
  }, [cooldownEnd]);

  if (remaining === 0) {
    return (
      <div className="flex items-center gap-2 text-green-500">
        <CheckIcon className="w-5 h-5" />
        <span>Ready to place!</span>
      </div>
    );
  }

  const progress = cooldownEnd
    ? ((cooldownEnd - Date.now()) / (5 * 1000)) * 100
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-400">Next pixel in:</span>
        <span className="font-mono text-lg">{remaining}s</span>
      </div>
      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all duration-100"
          style={{ width: `${100 - progress}%` }}
        />
      </div>
    </div>
  );
}
```

### Pixel Info Tooltip

```tsx
function PixelInfoTooltip({ x, y, visible }: { x: number; y: number; visible: boolean }) {
  const [pixelInfo, setPixelInfo] = useState<PixelInfo | null>(null);

  useEffect(() => {
    if (!visible) return;

    // Fetch pixel info from API
    fetch(`/api/v1/history/pixel?x=${x}&y=${y}`)
      .then(res => res.json())
      .then(data => setPixelInfo(data))
      .catch(() => setPixelInfo(null));
  }, [x, y, visible]);

  if (!visible || !pixelInfo) return null;

  return (
    <div className="absolute z-50 p-3 bg-gray-900 rounded-lg shadow-xl border border-gray-700">
      <div className="text-sm space-y-1">
        <div className="text-gray-400">Position: ({x}, {y})</div>
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Color:</span>
          <div
            className="w-4 h-4 rounded border border-gray-600"
            style={{ backgroundColor: `rgb(${COLOR_PALETTE[pixelInfo.color].r},${COLOR_PALETTE[pixelInfo.color].g},${COLOR_PALETTE[pixelInfo.color].b})` }}
          />
          <span>{COLOR_PALETTE[pixelInfo.color].name}</span>
        </div>
        {pixelInfo.placedBy && (
          <div className="text-gray-400">
            Placed by: {pixelInfo.placedBy}
          </div>
        )}
        {pixelInfo.placedAt && (
          <div className="text-gray-400">
            {formatRelativeTime(pixelInfo.placedAt)}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 7. Performance Optimizations

### Canvas Rendering Optimizations

```typescript
// Use OffscreenCanvas for non-blocking rendering
function useOffscreenCanvas() {
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (typeof OffscreenCanvas !== 'undefined') {
      workerRef.current = new Worker('/canvas-worker.js');
    }
  }, []);

  const render = useCallback((canvasData: Uint8Array) => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'render', data: canvasData });
    }
  }, []);

  return { render };
}
```

### Viewport Culling

```typescript
// Only render visible portion of canvas
function getVisibleRegion(
  zoom: number,
  panX: number,
  panY: number,
  viewportWidth: number,
  viewportHeight: number
): { startX: number; startY: number; endX: number; endY: number } {
  const startX = Math.max(0, Math.floor(-panX / zoom));
  const startY = Math.max(0, Math.floor(-panY / zoom));
  const endX = Math.min(CANVAS_WIDTH, Math.ceil((viewportWidth - panX) / zoom));
  const endY = Math.min(CANVAS_HEIGHT, Math.ceil((viewportHeight - panY) / zoom));

  return { startX, startY, endX, endY };
}
```

### Request Animation Frame for Updates

```typescript
// Batch visual updates to match display refresh rate
function useAnimationFrameUpdates() {
  const pendingUpdates = useRef<PixelUpdate[]>([]);
  const rafId = useRef<number | null>(null);

  const scheduleUpdate = useCallback((update: PixelUpdate) => {
    pendingUpdates.current.push(update);

    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        const updates = pendingUpdates.current;
        pendingUpdates.current = [];
        rafId.current = null;

        // Apply all pending updates
        useCanvasStore.getState().updatePixelsBatch(updates);
      });
    }
  }, []);

  return scheduleUpdate;
}
```

---

## 8. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| Canvas API | HTML5 Canvas 2D | No GPU acceleration | WebGL (more complex) |
| State management | Zustand | Simple, minimal boilerplate | Redux (more structure) |
| Real-time | WebSocket | Requires reconnection logic | SSE (simpler, one-way) |
| Updates | Optimistic | Can show incorrect state briefly | Wait for confirmation |
| Rendering | Full canvas | Simple, works everywhere | Tile-based (better for huge canvases) |

---

## 9. Accessibility Considerations

```tsx
// Keyboard navigation for canvas
function CanvasKeyboardNav() {
  const [cursorPos, setCursorPos] = useState({ x: 250, y: 250 });

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowUp':
        setCursorPos(p => ({ ...p, y: Math.max(0, p.y - 1) }));
        break;
      case 'ArrowDown':
        setCursorPos(p => ({ ...p, y: Math.min(499, p.y + 1) }));
        break;
      case 'ArrowLeft':
        setCursorPos(p => ({ ...p, x: Math.max(0, p.x - 1) }));
        break;
      case 'ArrowRight':
        setCursorPos(p => ({ ...p, x: Math.min(499, p.x + 1) }));
        break;
      case 'Enter':
      case ' ':
        placePixel(cursorPos.x, cursorPos.y);
        break;
    }
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={`Canvas at position ${cursorPos.x}, ${cursorPos.y}`}
      role="application"
    >
      {/* Canvas content */}
    </div>
  );
}
```

---

## 10. Future Enhancements

1. **WebGL Renderer** - GPU-accelerated rendering for larger canvases
2. **Viewport-Only Updates** - Request only visible region updates
3. **Touch Gestures** - Better mobile pinch-zoom and pan
4. **Collaborative Cursor** - Show other users' cursor positions
5. **Undo History** - Local undo for recent placements

---

## Summary

"To summarize, I've designed r/place's frontend with:

1. **HTML5 Canvas rendering** using ImageData for efficient pixel manipulation with CSS `image-rendering: pixelated` for crisp scaling
2. **Zustand state management** storing the canvas as a Uint8Array with optimistic updates and rollback
3. **WebSocket manager** with automatic reconnection, exponential backoff, and message batching
4. **Zoom/pan interactions** supporting mouse wheel, drag, and touch gestures with smooth 60 FPS performance
5. **Cooldown timer UI** with visual countdown and progress bar
6. **Performance optimizations** including requestAnimationFrame batching and viewport culling

The key insight is that even a 500x500 canvas (250K pixels) can be efficiently rendered using the Canvas 2D API when we leverage ImageData for bulk updates and only redraw changed pixels for incremental updates. The WebSocket batching ensures we can handle thousands of updates per second without overwhelming the render loop."
