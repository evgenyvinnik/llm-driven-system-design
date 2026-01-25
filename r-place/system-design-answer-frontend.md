# r/place - Collaborative Real-time Pixel Canvas - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing r/place, Reddit's collaborative pixel art canvas where millions of users place colored pixels on a shared canvas in real-time, with rate limiting to encourage collaboration. As a frontend engineer, I'll focus on efficient canvas rendering, real-time WebSocket updates, zoom/pan interactions, cooldown UI, and ensuring smooth performance even with thousands of updates per second. Let me clarify the requirements."

---

## 🎯 1. Requirements Clarification (4 minutes)

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
- **Memory Efficient** - Handle 500×500+ canvas without browser lag
- **Mobile Support** - Touch gestures for zoom/pan, responsive layout

### Frontend-Specific Considerations

- Efficient canvas rendering with HTML5 Canvas API
- WebSocket reconnection with exponential backoff
- Optimistic UI updates with rollback on failure
- Responsive design for mobile and desktop

---

## 🏗️ 2. High-Level Architecture (5 minutes)

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

## 🔧 3. Deep Dive: Canvas Rendering (10 minutes)

### HTML5 Canvas Architecture

"The core rendering uses a single HTML5 canvas element with the 2D context. The key insight is using ImageData for efficient bulk pixel updates."

**Canvas Configuration:**

| Setting | Value | Purpose |
|---------|-------|---------|
| `getContext('2d', { alpha: false })` | Disable alpha | Performance boost (no compositing) |
| `ctx.imageSmoothingEnabled = false` | Disable smoothing | Crisp pixel edges when zoomed |
| CSS `image-rendering: pixelated` | Pixelated | Sharp scaling at all zoom levels |

### Canvas State Structure

| Property | Type | Description |
|----------|------|-------------|
| canvasData | Uint8Array | Color indices (1 byte per pixel) |
| canvasWidth | number | Grid width (e.g., 500) |
| canvasHeight | number | Grid height (e.g., 500) |
| imageDataRef | ImageData | Reusable buffer for rendering |

### Render Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Uint8Array     │────▶│  Convert to     │────▶│  putImageData   │
│  (color indices)│     │  RGBA ImageData │     │  (draw to ctx)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Full canvas render:**
1. For each pixel index in Uint8Array
2. Look up RGB values from color palette
3. Write R, G, B, 255 (alpha) to ImageData buffer
4. Call putImageData once for entire canvas

### Color Palette (16 colors)

| Index | Hex | Name | Index | Hex | Name |
|-------|-----|------|-------|-----|------|
| 0 | #FFFFFF | White | 8 | #E5D900 | Yellow |
| 1 | #E4E4E4 | Light Gray | 9 | #94E044 | Light Green |
| 2 | #888888 | Gray | 10 | #02BE01 | Green |
| 3 | #222222 | Black | 11 | #00D3DD | Cyan |
| 4 | #FFA7D1 | Pink | 12 | #0083C7 | Light Blue |
| 5 | #E50000 | Red | 13 | #0000EA | Blue |
| 6 | #E59500 | Orange | 14 | #CF6EE4 | Light Purple |
| 7 | #A06A42 | Brown | 15 | #820080 | Purple |

### Efficient Partial Updates

"Instead of redrawing the entire canvas for each incoming pixel, I draw only the changed pixels using fillRect."

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Receive batch  │────▶│  Update internal│────▶│  fillRect for   │
│  of PixelUpdate │     │  Uint8Array     │     │  each pixel     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**For each update:** Look up color from palette → set fillStyle → call fillRect(x, y, 1, 1)

### Zoom and Pan Implementation

**State:**

| Property | Type | Range | Description |
|----------|------|-------|-------------|
| zoom | number | 0.5 - 32 | Current zoom level |
| panX, panY | number | — | Viewport offset in pixels |
| isPanning | boolean | — | Drag state |

**Mouse Wheel Zoom:**
1. Calculate zoom delta (×0.9 for out, ×1.1 for in)
2. Clamp to range [0.5, 32]
3. Adjust pan to keep cursor position stable
4. Formula: newPan = cursorPos - (cursorPos - oldPan) × (newZoom / oldZoom)

**Mouse Drag Pan:**
- Track position on mousedown
- Calculate delta on mousemove
- Update pan by delta
- Works with middle click, right click, or Ctrl+left click

**Touch Gestures (Mobile):**

| Gesture | Action |
|---------|--------|
| Two-finger pinch | Zoom in/out based on finger distance change |
| Single finger drag | Pan canvas |

**CSS Transform Approach:**

```
┌─────────────────────────────────────────────────────────────────┐
│  style={{                                                        │
│    transform: `scale(${zoom}) translate(${-panX}px, ${-panY}px)`,│
│    transformOrigin: 'top left',                                  │
│    imageRendering: 'pixelated'                                   │
│  }}                                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 4. Deep Dive: Zustand State Management (8 minutes)

### Store Structure

**Canvas Data:**

| Property | Type | Description |
|----------|------|-------------|
| canvasData | Uint8Array \| null | The pixel grid |
| canvasWidth | number | Grid width |
| canvasHeight | number | Grid height |

**User State:**

| Property | Type | Description |
|----------|------|-------------|
| selectedColor | number | Palette index (0-15) |
| cooldownEnd | number \| null | Timestamp when user can place again |
| userId | string \| null | Current user ID |

**Viewport State:**

| Property | Type | Description |
|----------|------|-------------|
| zoom | number | Current zoom level |
| panX, panY | number | Viewport offset |

**Connection State:**

| Property | Type | Description |
|----------|------|-------------|
| isConnected | boolean | WebSocket connected |
| connectionError | string \| null | Error message if any |

### Store Actions

| Action | Parameters | Description |
|--------|------------|-------------|
| setCanvasData | data: Uint8Array | Initial canvas load |
| updatePixel | x, y, color | Single pixel update |
| updatePixelsBatch | updates[] | Efficient batch update |
| setSelectedColor | color | Change palette selection |
| setCooldown | endTime | Set cooldown timer |
| setViewport | zoom, panX, panY | Update viewport |
| setConnectionState | connected, error? | Track WebSocket status |

### Optimistic Updates

"When the user places a pixel, I update the UI immediately before server confirmation."

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

**On Success:** Set cooldown from server response (nextPlacement timestamp)

**On Failure (rate limited):**
1. Rollback to previous color
2. Set cooldown from error response
3. Show toast notification

---

## 🔧 5. Deep Dive: WebSocket Management (8 minutes)

### WebSocket Manager State

| Property | Type | Description |
|----------|------|-------------|
| ws | WebSocket \| null | The connection |
| reconnectAttempts | number | For exponential backoff |
| maxReconnectAttempts | 10 | Give up threshold |
| messageQueue | PixelUpdate[] | Incoming updates buffer |
| pendingRequests | Map | Request/response matching |

### Connection Lifecycle

**connect():**
1. Create WebSocket with dynamic protocol (wss: for https:, ws: for http:)
2. Set up event handlers (onopen, onmessage, onclose, onerror)
3. On open: reset reconnect attempts, update connection state, start batch processing

**Reconnection with Exponential Backoff:**

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Connection     │────▶│  Calculate      │────▶│  Wait delay     │
│  lost/closed    │     │  delay + jitter │     │  then reconnect │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Delay Formula:**
- Base delay: 1000ms × 2^attempt
- Cap at 30 seconds
- Add random jitter (0-1000ms) to prevent thundering herd

### Message Types from Server

| Type | Description | Action |
|------|-------------|--------|
| `canvas` | Initial canvas data (base64) | Decode and set canvasData |
| `pixels` | Batch of pixel updates | Queue for batch processing |
| `welcome` | Connection established | Set userId, initial cooldown |
| `success` | Placement confirmed | Resolve pending request |
| `error` | Server error | Handle based on error code |

### Batch Processing

"Every 50ms, process all queued pixel updates together."

1. Collect incoming `pixels` messages in queue
2. Every 50ms interval:
   - Call updatePixelsBatch with accumulated updates
   - Clear queue
3. Trigger single re-render for all updates

### Sending Pixel Placements

**placePixel(x, y, color) → Promise:**
1. Generate unique requestId (UUID)
2. Store resolve/reject callbacks in pendingRequests map
3. Send JSON message: `{ type: 'place', x, y, color, requestId }`
4. Set 5-second timeout, reject if no response
5. On response: match by requestId, resolve or reject

---

## 🎨 6. Deep Dive: UI Components (5 minutes)

### Color Palette Component

**Layout:**
- Flex wrap container with 4×4 grid
- Dark background with rounded corners
- Clear visual selection state

**Each Color Button:**

| Property | Selected | Unselected | Hover |
|----------|----------|------------|-------|
| Border | 2px white | Transparent | — |
| Transform | scale(1.1) | scale(1.0) | scale(1.05) |
| Shadow | Yes | No | — |

**Accessibility:**
- title and aria-label with color name
- Keyboard navigation support

### Cooldown Timer Component

**States:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Ready State:                                                    │
│  [Green Check Icon] "Ready to place!"                           │
├─────────────────────────────────────────────────────────────────┤
│  Cooldown State:                                                 │
│  "Next pixel in:" [Remaining Seconds]                           │
│  [Progress Bar: fills as cooldown expires]                      │
└─────────────────────────────────────────────────────────────────┘
```

**Timer Logic:**
- useEffect hook with cleanup
- Update remaining seconds every 100ms
- Calculate progress as percentage of cooldown
- Clear interval when cooldownEnd is null or expired

### Connection Status Indicator

| State | Indicator | Text |
|-------|-----------|------|
| Connected | Green pulsing dot | "Connected" |
| Disconnected | Red static dot | Error message or "Reconnecting..." |

### Pixel Info Tooltip

**Trigger:** Hover over canvas with 500ms delay

**Display:**
- Position: (x, y) coordinates
- Color: Small square preview + color name
- Placed by: Username (if available)
- When: Relative time (e.g., "2 minutes ago")

---
up
## ⚡ 7. Performance Optimizations

### Canvas Rendering Optimizations

**OffscreenCanvas (when supported):**
- Create Web Worker for rendering
- Post canvas data to worker
- Receive rendered ImageData
- Non-blocking main thread

**Viewport Culling:**

| Parameter | Formula |
|-----------|---------|
| startX | max(0, floor(-panX / zoom)) |
| startY | max(0, floor(-panY / zoom)) |
| endX | min(CANVAS_WIDTH, ceil((viewportWidth - panX) / zoom)) |
| endY | min(CANVAS_HEIGHT, ceil((viewportHeight - panY) / zoom)) |

"Only process updates within visible bounds for rendering. Still update internal state for off-screen pixels."

### RequestAnimationFrame Batching

"Batch visual updates to match display refresh rate."

1. Maintain pendingUpdates array
2. On each update, push to array and schedule RAF if not scheduled
3. In RAF callback: process all pending updates, clear array
4. Prevents multiple renders per frame during high-frequency updates

### Memory Management

| Optimization | Technique |
|--------------|-----------|
| Reuse ImageData | Keep single ImageData object, overwrite pixels |
| Avoid allocations in hot path | Pre-allocate color lookup arrays |
| TypedArray for canvas | Uint8Array instead of regular array |

---

## 📡 8. API Design (Frontend Perspective)

### WebSocket Message Handling

**Incoming Messages:**

| Type | Handler | Store Update |
|------|---------|--------------|
| `welcome` | Extract userId, cooldown | setUserId, setCooldown |
| `canvas` | Base64 decode to Uint8Array | setCanvasData |
| `pixels` | Queue updates | updatePixelsBatch (on interval) |
| `success` | Match requestId | setCooldown(nextPlacement) |
| `error` | Match requestId, handle code | Rollback, show toast |

**Outgoing Messages:**

| Type | Trigger | Payload |
|------|---------|---------|
| `place` | User clicks canvas | `{ x, y, color, requestId }` |
| `ping` | 30s interval | `{}` |

### REST API Endpoints Used

| Method | Endpoint | When | Response Handling |
|--------|----------|------|-------------------|
| GET | `/api/v1/auth/me` | App load | Set user state |
| POST | `/api/v1/auth/login` | Login form | Set user, refresh WS |
| POST | `/api/v1/auth/logout` | Logout button | Clear user, refresh WS |
| GET | `/api/v1/history/pixel?x=&y=` | Hover tooltip | Display in tooltip |

---

## ⚖️ 9. Trade-offs Analysis

### Trade-off 1: HTML5 Canvas 2D vs. WebGL

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Canvas 2D | Simple API, works everywhere, sufficient for 500×500 | No GPU acceleration |
| ❌ WebGL | GPU-accelerated, handles millions of pixels | Complex shader setup, overkill for our scale |

> "We chose Canvas 2D because our 500×500 canvas (250K pixels) renders comfortably at 60 FPS with putImageData. WebGL would require writing shaders, managing GPU buffers, and handling WebGL context loss—significant complexity for marginal benefit. The breakpoint where WebGL becomes necessary is around 2000×2000+ pixels where CPU-based rendering struggles. For our scale, the simplicity of ctx.fillRect() and putImageData() wins. The trade-off is we can't easily add effects like glow or blur that WebGL handles trivially, but r/place doesn't need those."

### Trade-off 2: Optimistic Updates vs. Wait for Confirmation

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Optimistic update | Instant feedback, feels responsive | May show incorrect state briefly |
| ❌ Wait for server | Always accurate | 50-200ms delay feels sluggish |

> "We update the UI immediately on click because perceived latency directly impacts user satisfaction. Waiting 100ms for server confirmation makes the app feel broken—users expect their click to register instantly. The trade-off is that if the server rejects (rate limited, coordinates changed), we must rollback. We mitigate this by checking local cooldown state first (preventing most rejections) and making rollback visually smooth. In practice, rejections are rare (<1% of placements), so optimistic updates are correct 99% of the time."

### Trade-off 3: Single Canvas vs. Tile-Based Rendering

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Single canvas | Simple viewport math, no seams | Must render/transform entire canvas |
| ❌ Tile-based | Only render visible tiles, infinite canvas possible | Tile boundary handling, complex virtualization |

> "We render the entire canvas as a single HTML5 canvas element because our 500×500 pixel grid is small enough that CSS transforms handle zoom/pan smoothly. Tile-based rendering would require calculating which tiles are visible, loading tiles on demand, and handling seams between tiles during zoom. For canvases larger than ~4000×4000, tiles become necessary because a single canvas exceeds browser memory limits. Our 500×500 canvas at 4 bytes per pixel is only 1MB—well within limits. The trade-off is we can't support truly massive (100K×100K) canvases without a major refactor."

---

## ♿ 10. Accessibility Considerations

### Keyboard Navigation

| Key | Action |
|-----|--------|
| Arrow keys | Move cursor position by 1 pixel |
| Enter / Space | Place pixel at cursor position |
| Tab | Cycle through color palette |
| +/- | Zoom in/out |

### Component Attributes

| Attribute | Value | Purpose |
|-----------|-------|---------|
| tabIndex | 0 | Enable focus on canvas |
| role | "application" | Proper screen reader context |
| aria-label | Dynamic | Announce current position and color |

---

## 📝 Summary

"To summarize, I've designed r/place's frontend with:

1. **HTML5 Canvas rendering** using ImageData for efficient pixel manipulation with CSS `image-rendering: pixelated` for crisp scaling
2. **Zustand state management** storing the canvas as a Uint8Array with optimistic updates and rollback on failure
3. **WebSocket manager** with automatic reconnection, exponential backoff, and message batching
4. **Zoom/pan interactions** supporting mouse wheel, drag, and touch gestures with smooth 60 FPS performance
5. **Cooldown timer UI** with visual countdown and progress bar
6. **Performance optimizations** including requestAnimationFrame batching and viewport culling

The key insight is that even a 500×500 canvas (250K pixels) can be efficiently rendered using the Canvas 2D API when we leverage ImageData for bulk updates and fillRect for incremental updates. The WebSocket batching ensures we can handle thousands of updates per second without overwhelming the render loop."
