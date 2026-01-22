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
┌──────────────────────────────────────────────────────────────────────────────┐
│                           React Application                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │   Canvas View    │  │   Color Palette  │  │  Cooldown Timer  │           │
│  │  - Zoom/Pan      │  │  - 16 colors     │  │  - Countdown     │           │
│  │  - Pixel grid    │  │  - Selection     │  │  - Progress bar  │           │
│  │  - Click handler │  │  - Hover preview │  │  - Next place    │           │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘           │
│           │                     │                     │                      │
│           └─────────────────────┼─────────────────────┘                      │
│                                 │                                            │
│                    ┌────────────▼────────────┐                               │
│                    │      Zustand Store      │                               │
│                    │  - canvasState (Uint8)  │                               │
│                    │  - selectedColor        │                               │
│                    │  - cooldownEnd          │                               │
│                    │  - viewportPosition     │                               │
│                    │  - zoomLevel            │                               │
│                    └────────────┬────────────┘                               │
│                                 │                                            │
│                    ┌────────────▼────────────┐                               │
│                    │   WebSocket Manager     │                               │
│                    │  - Connection state     │                               │
│                    │  - Message batching     │                               │
│                    │  - Reconnection logic   │                               │
│                    └─────────────────────────┘                               │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    Backend WebSocket    │
                    │         /ws             │
                    └─────────────────────────┘
```

---

## 3. Deep Dive: Canvas Rendering (10 minutes)

### HTML5 Canvas Architecture

"The core rendering uses a single HTML5 canvas element with the 2D context. The key insight is using ImageData for efficient bulk pixel updates."

**Canvas Setup:**
- Disable alpha channel for performance: `getContext('2d', { alpha: false })`
- Disable image smoothing for crisp pixel edges: `ctx.imageSmoothingEnabled = false`
- CSS property: `image-rendering: pixelated` for sharp scaling

**Canvas State:**
- `canvasData`: Uint8Array of color indices (1 byte per pixel)
- `canvasWidth`, `canvasHeight`: Grid dimensions (e.g., 500x500)
- `imageDataRef`: Reusable ImageData object for rendering

**Render Flow:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Uint8Array     │────▶│  Convert to     │────▶│  putImageData   │
│  (color indices)│     │  RGBA ImageData │     │  (draw to ctx)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

"For each pixel, look up the color in the palette, write RGBA values to the ImageData buffer, then call putImageData once for the entire canvas."

### Color Palette Definition (16 colors)

| Index | Color | Name |
|-------|-------|------|
| 0 | #FFFFFF | White |
| 1 | #E4E4E4 | Light Gray |
| 2 | #888888 | Gray |
| 3 | #222222 | Black |
| 4 | #FFA7D1 | Pink |
| 5 | #E50000 | Red |
| 6 | #E59500 | Orange |
| 7 | #A06A42 | Brown |
| 8 | #E5D900 | Yellow |
| 9 | #94E044 | Light Green |
| 10 | #02BE01 | Green |
| 11 | #00D3DD | Cyan |
| 12 | #0083C7 | Light Blue |
| 13 | #0000EA | Blue |
| 14 | #CF6EE4 | Light Purple |
| 15 | #820080 | Purple |

### Efficient Partial Updates

"Instead of redrawing the entire canvas for each incoming pixel, I draw only the changed pixels using fillRect."

**Incremental Update Flow:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Receive batch  │────▶│  Update internal│────▶│  fillRect for   │
│  of PixelUpdate │     │  Uint8Array     │     │  each pixel     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

"For each update: look up color from palette, set fillStyle, call fillRect(x, y, 1, 1)."

### Zoom and Pan Implementation

**State:**
- `zoom`: Current zoom level (0.5 to 32)
- `pan`: { x, y } offset in pixels
- `isPanning`: Boolean for drag state

**Mouse Wheel Zoom:**
- Calculate zoom delta (0.9 for zoom out, 1.1 for zoom in)
- Clamp to range [0.5, 32]
- Adjust pan to keep cursor position stable during zoom
- Formula: `newPan = cursorPos - (cursorPos - oldPan) * (newZoom / oldZoom)`

**Mouse Drag Pan:**
- Track mouse position on mousedown
- Calculate delta on mousemove
- Update pan by delta
- Works with middle click, right click, or ctrl+left click

**Touch Gestures (Mobile):**
- Two-finger pinch for zoom (track distance between touches)
- Single finger drag for pan
- Store initial pinch distance on touchstart with 2 touches

**CSS Transform Approach:**

```
┌─────────────────────────────────────────────────────────────┐
│  style={{                                                    │
│    transform: `scale(${zoom}) translate(${-panX}px, ...)`,  │
│    transformOrigin: 'top left',                              │
│    imageRendering: 'pixelated'                               │
│  }}                                                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dive: Zustand State Management (8 minutes)

### Store Structure

**Canvas Data:**
- `canvasData`: Uint8Array | null (the pixel grid)
- `canvasWidth`, `canvasHeight`: number (grid dimensions)

**User State:**
- `selectedColor`: number (0-15 palette index)
- `cooldownEnd`: number | null (timestamp when user can place again)
- `userId`: string | null

**Viewport State:**
- `zoom`: number (current zoom level)
- `panX`, `panY`: number (viewport offset)

**Connection State:**
- `isConnected`: boolean
- `connectionError`: string | null

### Store Actions

**setCanvasData(data: Uint8Array):**
- Called on initial canvas load from WebSocket

**updatePixel(x, y, color):**
- Updates single pixel in canvasData
- Triggers re-render with new Uint8Array reference: `new Uint8Array(canvasData)`

**updatePixelsBatch(updates: PixelUpdate[]):**
- Efficiently updates multiple pixels
- Single re-render at end of batch

**setSelectedColor(color):**
- Updates palette selection

**setCooldown(endTime):**
- Sets cooldown timer end timestamp

**setViewport(zoom, panX, panY):**
- Updates viewport state

**setConnectionState(connected, error?):**
- Tracks WebSocket connection status

### Optimistic Updates

"When the user places a pixel, I update the UI immediately before server confirmation."

**Optimistic Update Flow:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  User clicks    │────▶│  Check local    │────▶│  Optimistic     │
│  to place pixel │     │  cooldown first │     │  UI update      │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Rollback if    │◀────│  Wait for       │◀────│  Send via       │
│  error occurs   │     │  server response│     │  WebSocket      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**On Success:**
- Set cooldown from server response (nextPlacement timestamp)

**On Failure (rate limited):**
- Rollback to previous color
- Set cooldown from error response
- Show toast notification

---

## 5. Deep Dive: WebSocket Management (8 minutes)

### WebSocket Manager Architecture

**State:**
- `ws`: WebSocket | null (the connection)
- `reconnectAttempts`: number (for exponential backoff)
- `maxReconnectAttempts`: 10
- `messageQueue`: PixelUpdate[] (incoming updates buffer)
- `batchInterval`: number | null (processing interval ID)
- `pendingRequests`: Map<requestId, { resolve, reject }> (for request/response matching)

### Connection Lifecycle

**connect():**
- Create WebSocket with dynamic protocol (wss: for https:, ws: for http:)
- Set up event handlers (onopen, onmessage, onclose, onerror)
- On open: reset reconnect attempts, update connection state, start batch processing

**Reconnection with Exponential Backoff:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Connection     │────▶│  Calculate      │────▶│  Wait delay     │
│  lost/closed    │     │  delay + jitter │     │  then reconnect │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Delay Formula:**
- Base delay: 1000ms * 2^attempt
- Cap at 30 seconds
- Add random jitter (0-1000ms) to prevent thundering herd

### Message Handling

**Message Types from Server:**

| Type | Description | Action |
|------|-------------|--------|
| `canvas` | Initial canvas data (base64) | Decode and set canvasData |
| `pixels` | Batch of pixel updates | Queue for batch processing |
| `welcome` | Connection established | Set userId, initial cooldown |
| `error` | Server error | Handle based on error code |

**Batch Processing:**
- Every 50ms, process all queued pixel updates
- Call `updatePixelsBatch` with accumulated updates
- Clear queue after processing

### Sending Pixel Placements

**placePixel(x, y, color) -> Promise<PlaceResult>:**
- Generate unique requestId (UUID)
- Store resolve/reject callbacks in pendingRequests map
- Send JSON message: `{ type: 'place', x, y, color, requestId }`
- Set 5-second timeout, reject if no response
- On response: match by requestId, resolve or reject accordingly

### Connection Status Indicator

**Visual States:**

| State | Indicator | Text |
|-------|-----------|------|
| Connected | Green pulsing dot | "Connected" |
| Disconnected | Red static dot | Error message or "Reconnecting..." |

---

## 6. Deep Dive: UI Components (5 minutes)

### Color Palette Component

**Layout:**
- Flex wrap container with 1px gap
- Dark background (gray-800) with rounded corners
- Max width to create 4x4 grid of colors

**Each Color Button:**
- 32x32 pixel square with rounded border
- Border: 2px white when selected, transparent otherwise
- Transform: scale(1.1) when selected, scale(1.05) on hover
- Shadow on selected color
- Background: RGB from palette
- Accessibility: title and aria-label with color name

### Cooldown Timer Component

**States:**

```
┌─────────────────────────────────────────────────────────────┐
│  Ready State:                                                │
│  [Green Check Icon] "Ready to place!"                       │
├─────────────────────────────────────────────────────────────┤
│  Cooldown State:                                             │
│  "Next pixel in:" [Remaining Seconds]                       │
│  [Progress Bar: fills as cooldown expires]                  │
└─────────────────────────────────────────────────────────────┘
```

**Timer Logic:**
- useEffect hook with cleanup
- Update remaining seconds every 100ms
- Calculate progress as percentage of 5-second cooldown
- Clear interval when cooldownEnd is null or expired

### Pixel Info Tooltip

**Trigger:** Hover over canvas with delay

**Display:**
- Position: (x, y) coordinates
- Color: Small square preview + color name
- Placed by: Username (if available)
- When: Relative time (e.g., "2 minutes ago")

**Fetch Logic:**
- API call to `/api/v1/history/pixel?x={x}&y={y}`
- Only fetch when visible changes
- Show loading state while fetching

---

## 7. Performance Optimizations

### Canvas Rendering Optimizations

**OffscreenCanvas for Non-blocking Rendering:**
- Check for OffscreenCanvas support
- Create Web Worker for rendering if available
- Post canvas data to worker, receive rendered result
- Falls back to main thread if unsupported

**Viewport Culling:**
- Calculate visible region based on zoom and pan
- Only process updates within visible bounds for rendering
- Still update internal state for off-screen pixels

**Visible Region Calculation:**

| Parameter | Formula |
|-----------|---------|
| startX | max(0, floor(-panX / zoom)) |
| startY | max(0, floor(-panY / zoom)) |
| endX | min(CANVAS_WIDTH, ceil((viewportWidth - panX) / zoom)) |
| endY | min(CANVAS_HEIGHT, ceil((viewportHeight - panY) / zoom)) |

### Request Animation Frame Batching

"Batch visual updates to match display refresh rate."

**Implementation:**
- Maintain pendingUpdates array
- On each update, push to array and schedule RAF if not already scheduled
- In RAF callback: process all pending updates, clear array
- Prevents multiple renders per frame during high-frequency updates

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

### Keyboard Navigation

**Arrow Keys:** Move cursor position by 1 pixel

| Key | Action |
|-----|--------|
| ArrowUp | y = max(0, y - 1) |
| ArrowDown | y = min(height - 1, y + 1) |
| ArrowLeft | x = max(0, x - 1) |
| ArrowRight | x = min(width - 1, x + 1) |
| Enter / Space | Place pixel at cursor position |

**Component Attributes:**
- `tabIndex={0}` for focus
- `role="application"` for proper screen reader context
- Dynamic `aria-label` announcing current position

---

## 10. Future Enhancements

1. **WebGL Renderer** - GPU-accelerated rendering for larger canvases
2. **Viewport-Only Updates** - Request only visible region updates from server
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
