# Scale AI - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design the frontend for a crowdsourced data labeling platform with three user interfaces: a drawing game for data collection, an admin dashboard for dataset management, and an implementor portal for model testing."

This is a **frontend-focused problem** requiring expertise in:
- Canvas-based drawing with touch and mouse support
- Game-like UX with visual feedback and progress tracking
- Admin dashboard with data tables, charts, and filtering
- Real-time model inference visualization
- Multi-portal application architecture

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- Drawing canvas with stroke capture (pressure, timing)
- Clear visual instructions and shape prompts
- Admin dashboard with statistics, gallery, and training controls
- Implementor portal for model testing with confidence display
- Session persistence for anonymous users

### Non-Functional Requirements
- **Touch Support**: Work on tablets and phones
- **Responsiveness**: Canvas adapts to screen size
- **Performance**: Smooth 60fps drawing experience
- **Feedback**: Immediate visual confirmation on actions

### Frontend-Specific Clarifications
- "Canvas library?" - Native Canvas 2D API (simple shapes, better control)
- "State management?" - React useState for local, context for shared
- "Routing?" - Hash-based routing for simplicity (SPA)
- "Styling?" - Plain CSS with component-specific files

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND APP                                   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                         App.tsx (Router)                            ││
│  │     /              │    /#admin           │    /#implement          ││
│  └─────┬──────────────┴────────┬─────────────┴─────────┬───────────────┘│
│        │                       │                       │                 │
│        ▼                       ▼                       ▼                 │
│  ┌───────────────┐     ┌───────────────┐     ┌───────────────┐         │
│  │  Drawing Game │     │ Admin Portal  │     │  Implementor  │         │
│  │               │     │               │     │    Portal     │         │
│  │ ┌───────────┐ │     │ ┌───────────┐ │     │ ┌───────────┐ │         │
│  │ │PostItCanvas│ │     │ │ AdminLogin│ │     │ │TestCanvas │ │         │
│  │ └───────────┘ │     │ └───────────┘ │     │ └───────────┘ │         │
│  │ ┌───────────┐ │     │ ┌───────────┐ │     │ ┌───────────┐ │         │
│  │ │ShapePrompt│ │     │ │OverviewTab│ │     │ │ModelInfo  │ │         │
│  │ └───────────┘ │     │ └───────────┘ │     │ └───────────┘ │         │
│  │ ┌───────────┐ │     │ ┌───────────┐ │     │ ┌───────────┐ │         │
│  │ │ Progress  │ │     │ │DrawingsTab│ │     │ │Predictions│ │         │
│  │ └───────────┘ │     │ └───────────┘ │     │ └───────────┘ │         │
│  └───────────────┘     │ ┌───────────┐ │     └───────────────┘         │
│                        │ │TrainingTab│ │                                │
│                        │ └───────────┘ │                                │
│                        └───────────────┘                                │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                        Shared Components                            ││
│  │  DrawingCard  │  StrokeThumbnail  │  StatCard  │  LoadingSpinner   ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────┐
                        │   API Service     │
                        │   (api.ts)        │
                        └───────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| PostItCanvas | Capture strokes, handle touch/mouse, render drawing |
| ShapePrompt | Display target shape with instructions |
| AdminDashboard | Container for admin tabs, manages auth and data |
| DrawingsTab | Gallery view with filtering and pagination |
| TrainingTab | Model list, training controls, progress monitoring |
| TestCanvas | Draw for inference, display predictions |

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: Drawing Canvas with Stroke Capture (8 minutes)

**Challenge**: Capture smooth strokes with pressure and timing data on both touch and mouse devices.

**PostItCanvas Component Architecture**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     PostItCanvas Component                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     State Management                         ││
│  │  strokes: Stroke[]          Current completed strokes        ││
│  │  currentStroke: Stroke      Active stroke being drawn        ││
│  │  isDrawing: boolean         Currently in drawing mode        ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Stroke Data Model                       ││
│  │  points: Array of {x, y, pressure, timestamp}               ││
│  │  color: string (e.g., '#2d3436')                            ││
│  │  width: number (default: 3)                                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     Event Handlers                           ││
│  │  onPointerDown ──▶ Start new stroke, capture pointer        ││
│  │  onPointerMove ──▶ Add point, draw segment immediately      ││
│  │  onPointerUp   ──▶ Finalize stroke, release pointer         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Pointer Position Calculation**:
- Get canvas bounding rectangle
- Calculate scale factors: scaleX = canvas.width / rect.width
- Transform client coordinates: x = (clientX - rect.left) * scaleX
- Capture pressure from PointerEvent (defaults to 0.5 for mouse)
- Store timestamp for timing analysis

**Drawing Segment Rendering**:
- Use Canvas 2D context for immediate rendering
- Apply pressure-based line width: width * point.pressure
- Set lineCap and lineJoin to 'round' for smooth curves
- Draw line segment from previous point to current point

**Touch Support**:
- Set style `touchAction: 'none'` on canvas to prevent scrolling
- Use setPointerCapture for smooth tracking across element boundaries
- Handle pointerLeave same as pointerUp for edge cases

**Stroke Simplification (Ramer-Douglas-Peucker Algorithm)**:

```
┌─────────────────────────────────────────────────────────────────┐
│              Stroke Simplification Pipeline                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Raw Points (100+)                                               │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  1. Find point with max perpendicular distance from line    ││
│  │  2. If distance > tolerance, recursively simplify           ││
│  │  3. If distance <= tolerance, keep only endpoints           ││
│  └─────────────────────────────────────────────────────────────┘│
│       │                                                          │
│       ▼                                                          │
│  Simplified Points (10-20)                                       │
│                                                                  │
│  Benefits:                                                       │
│  - Smaller payload for API submission                           │
│  - Preserves shape fidelity                                     │
│  - Configurable tolerance (default: 2 pixels)                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### Deep Dive 2: Drawing Game Flow with Progress (6 minutes)

**Challenge**: Create engaging game-like experience with progress tracking.

**Game State Machine**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Drawing Game State Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    Draw     ┌──────────┐   Submit   ┌──────────┐  │
│  │  PROMPT  │────────────▶│ DRAWING  │───────────▶│SUBMITTING│  │
│  │          │             │          │            │          │  │
│  └──────────┘             └──────────┘            └────┬─────┘  │
│       ▲                        │                       │        │
│       │                        │ Clear                 │        │
│       │                        ▼                       │        │
│       │                   ┌──────────┐                 │        │
│       │                   │  CLEARED │                 │        │
│       │                   └──────────┘                 │        │
│       │                                                │        │
│       │                   ┌──────────┐                 │        │
│       └───────────────────│ SUCCESS  │◀────────────────┘        │
│         Next Shape        └──────────┘                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Game Configuration**:
- Shapes array: ['line', 'circle', 'square', 'triangle', 'heart']
- Drawings per session: 10
- Session ID stored in localStorage for anonymous users

**Drawing Submission Flow**:
1. User completes drawing and clicks Submit
2. Set isSubmitting = true, show loading overlay
3. Call API with stroke data, canvas dimensions, duration, device type
4. On success: show checkmark animation for 1 second
5. Increment completedCount, advance to next shape
6. Reset canvas with new key prop

**Progress Bar Component**:
- Visual fill width: (current / total) * 100%
- Text overlay showing "X / Y" format
- Smooth transition animation on progress updates

**Shape Prompt Component**:
- Large icon representation (ASCII: ─ ○ □ △ ♡)
- Shape name heading
- Instructional text (e.g., "Draw a complete circle in one stroke")

---

### Deep Dive 3: Admin Dashboard with Data Management (6 minutes)

**Challenge**: Build a comprehensive admin interface for managing training data.

**Admin Dashboard Architecture**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Admin Dashboard Structure                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    Authentication Gate                       ││
│  │  isAuthenticated = false ──▶ Show AdminLogin component      ││
│  │  isAuthenticated = true  ──▶ Show Dashboard                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Tab Navigation                          ││
│  │  overview  │  drawings  │  quality  │  training             ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     Data Loading                             ││
│  │  On auth success: fetch stats, drawings, models in parallel ││
│  │  Promise.all([getStats, getDrawings, getModels])            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Tab Components**:

| Tab | Purpose | Key Features |
|-----|---------|--------------|
| Overview | High-level statistics | StatCards with counts, charts |
| Drawings | Gallery management | Grid view, filtering, flagging |
| Quality | Data quality metrics | Quality score distribution |
| Training | Model management | Start training, view progress |

**Drawings Tab Filtering**:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Filter Configuration                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Shape Filter:                                                   │
│  ├─ all (default)                                               │
│  ├─ line, circle, square, triangle, heart                      │
│                                                                  │
│  Quality Filter:                                                 │
│  ├─ all (default)                                               │
│  ├─ high (quality_score >= 0.7)                                 │
│  ├─ low (quality_score <= 0.3)                                  │
│                                                                  │
│  Show Flagged: checkbox (default: false)                        │
│                                                                  │
│  Filter Logic:                                                   │
│  useMemo(() => drawings.filter(d =>                             │
│    matchesShapeFilter(d) &&                                     │
│    matchesQualityFilter(d) &&                                   │
│    (showFlagged || !d.is_flagged)                               │
│  ), [drawings, shapeFilter, qualityFilter, showFlagged])        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Flag Drawing Action**:
- Admin clicks flag button on DrawingCard
- API call: flagDrawing(drawingId)
- Optimistic update: set is_flagged = true in local state
- Flagged drawings excluded from training

---

### Deep Dive 4: Implementor Portal for Model Testing (5 minutes)

**Challenge**: Allow testing drawings against trained model with clear feedback.

**Implementor Portal Flow**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   Implementor Portal Layout                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Portal Header                          │ │
│  │  Model v{version} • Accuracy: {accuracy}%                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   Test Section  │  │ Results Section │  │ History Section │  │
│  │                 │  │                 │  │                 │  │
│  │  PostItCanvas   │  │ PredictionDisp  │  │ Recent 10 preds │  │
│  │  (targetShape:  │  │ - Shape name    │  │ - Shape         │  │
│  │   "anything")   │  │ - Confidence %  │  │ - Confidence    │  │
│  │                 │  │ - Color coding  │  │ - Latency       │  │
│  │                 │  │ - Latency ms    │  │                 │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Classification Flow**:
1. User draws on canvas and triggers onComplete
2. Set isClassifying = true, clear previous prediction
3. Call inference API with stroke data
4. Display prediction with confidence visualization
5. Add to history (keep last 10)

**Confidence Display Color Coding**:
- High (> 80%): Green
- Medium (50-80%): Yellow/Orange
- Low (< 50%): Red

**Prediction Display Components**:
- Predicted shape name with icon
- Confidence bar with percentage fill
- Metadata: latency in ms, model version

---

## 5. Stroke Thumbnail Rendering (2 minutes)

**Challenge**: Display stroke data as thumbnails in gallery views.

**Thumbnail Rendering Pipeline**:

```
┌─────────────────────────────────────────────────────────────────┐
│                   StrokeThumbnail Component                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Input: strokes[], width (default: 100), height (default: 100)  │
│                                                                  │
│  Step 1: Calculate Bounding Box                                  │
│  ├─ Find minX, minY, maxX, maxY across all stroke points        │
│                                                                  │
│  Step 2: Calculate Scale Factor                                  │
│  ├─ contentWidth = maxX - minX                                  │
│  ├─ contentHeight = maxY - minY                                 │
│  ├─ scale = min((width - padding) / contentWidth,               │
│  │              (height - padding) / contentHeight)             │
│                                                                  │
│  Step 3: Calculate Offset for Centering                         │
│  ├─ offsetX = (width - contentWidth * scale) / 2 - minX * scale │
│  ├─ offsetY = (height - contentHeight * scale) / 2 - minY * scale│
│                                                                  │
│  Step 4: Generate SVG Paths                                      │
│  ├─ For each stroke: create <path> with transformed points      │
│  ├─ Apply stroke color, scaled width, round caps/joins          │
│                                                                  │
│  Output: SVG element with post-it background and scaled strokes │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**SVG Benefits**:
- Scalable without pixelation
- Memoized with useMemo for performance
- Works at any thumbnail size
- Preserves stroke styling

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Pointer Events API | Less browser support | Unified touch/mouse/pen handling |
| Hash routing | No SSR | Simpler SPA, no server config needed |
| Container + tabs pattern | Props drilling | Clear data flow, easier debugging |
| Canvas 2D over WebGL | Less performant for complex scenes | Simpler for stroke drawing, sufficient for shapes |
| Session ID in localStorage | No cross-device sync | Simplest anonymous user tracking |

---

## 7. Future Enhancements

1. **Undo/Redo**: Track stroke history for corrections
2. **Stroke Replay**: Animate how drawings were created
3. **Leaderboards**: Gamification with top contributors
4. **Offline Mode**: Service worker for drawing without connection
5. **Accessibility**: Keyboard navigation for admin portal
