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

**PostItCanvas Component**:

```tsx
// frontend/src/components/PostItCanvas/PostItCanvas.tsx
interface Stroke {
  points: Array<{
    x: number;
    y: number;
    pressure: number;
    timestamp: number;
  }>;
  color: string;
  width: number;
}

interface PostItCanvasProps {
  targetShape: string;
  onComplete: (strokes: Stroke[]) => void;
  onClear: () => void;
}

export function PostItCanvas({ targetShape, onComplete, onClear }: PostItCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);

  // Get pointer position relative to canvas
  const getPointerPosition = useCallback((
    e: React.PointerEvent<HTMLCanvasElement>
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
      pressure: e.pressure || 0.5,
      timestamp: Date.now()
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const point = getPointerPosition(e);
    if (!point) return;

    setIsDrawing(true);
    setCurrentStroke({
      points: [point],
      color: '#2d3436',
      width: 3
    });

    // Capture pointer for smooth tracking
    canvasRef.current?.setPointerCapture(e.pointerId);
  }, [getPointerPosition]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentStroke) return;

    const point = getPointerPosition(e);
    if (!point) return;

    // Add point to current stroke
    setCurrentStroke(prev => ({
      ...prev!,
      points: [...prev!.points, point]
    }));

    // Draw immediately for responsiveness
    drawStrokeSegment(
      currentStroke.points[currentStroke.points.length - 1],
      point
    );
  }, [isDrawing, currentStroke, getPointerPosition]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentStroke) return;

    setIsDrawing(false);
    canvasRef.current?.releasePointerCapture(e.pointerId);

    // Finalize stroke
    if (currentStroke.points.length > 1) {
      setStrokes(prev => [...prev, currentStroke]);
    }
    setCurrentStroke(null);
  }, [isDrawing, currentStroke]);

  const drawStrokeSegment = useCallback((from: Point, to: Point) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = currentStroke?.color || '#2d3436';
    ctx.lineWidth = (currentStroke?.width || 3) * to.pressure;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }, [currentStroke]);

  const handleClear = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
    setStrokes([]);
    setCurrentStroke(null);
    onClear();
  }, [onClear]);

  const handleSubmit = useCallback(() => {
    if (strokes.length === 0) return;
    onComplete(strokes);
  }, [strokes, onComplete]);

  return (
    <div className="postit-canvas-container">
      {/* Skeuomorphic post-it note design */}
      <div className="postit-note">
        <div className="postit-header">
          <span className="shape-label">Draw a {targetShape}</span>
        </div>

        <canvas
          ref={canvasRef}
          width={400}
          height={400}
          className="drawing-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          style={{ touchAction: 'none' }} // Prevent scroll on touch
        />

        <div className="postit-actions">
          <button onClick={handleClear} className="btn-clear">
            Clear
          </button>
          <button
            onClick={handleSubmit}
            className="btn-submit"
            disabled={strokes.length === 0}
          >
            Submit Drawing
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Stroke Simplification for Smaller Payloads**:

```typescript
// Reduce point count while preserving shape
function simplifyStroke(points: Point[], tolerance: number = 2): Point[] {
  if (points.length < 3) return points;

  // Ramer-Douglas-Peucker algorithm
  const first = points[0];
  const last = points[points.length - 1];

  let maxDistance = 0;
  let maxIndex = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], first, last);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyStroke(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyStroke(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}
```

---

### Deep Dive 2: Drawing Game Flow with Progress (6 minutes)

**Challenge**: Create engaging game-like experience with progress tracking.

```tsx
// frontend/src/routes/DrawingGame.tsx
const SHAPES = ['line', 'circle', 'square', 'triangle', 'heart'];
const DRAWINGS_PER_SESSION = 10;

export function DrawingGame() {
  const [currentShapeIndex, setCurrentShapeIndex] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const currentShape = SHAPES[currentShapeIndex];

  const handleComplete = async (strokes: Stroke[]) => {
    setIsSubmitting(true);

    try {
      await api.submitDrawing({
        shapeId: currentShapeIndex + 1,
        strokes,
        metadata: {
          canvas: { width: 400, height: 400 },
          duration_ms: calculateDuration(strokes),
          device: detectDevice()
        }
      });

      // Show success animation
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 1000);

      // Progress to next shape
      setCompletedCount(prev => prev + 1);
      setCurrentShapeIndex((prev) => (prev + 1) % SHAPES.length);

    } catch (error) {
      console.error('Submission failed:', error);
      // Show error toast
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="drawing-game">
      <header className="game-header">
        <h1>Shape Drawing Game</h1>
        <ProgressBar
          current={completedCount}
          total={DRAWINGS_PER_SESSION}
        />
      </header>

      <div className="game-content">
        <ShapePrompt shape={currentShape} />

        <PostItCanvas
          key={currentShapeIndex} // Reset canvas on shape change
          targetShape={currentShape}
          onComplete={handleComplete}
          onClear={() => {}}
        />

        {showSuccess && (
          <div className="success-overlay">
            <span className="checkmark">✓</span>
            <span>Great job!</span>
          </div>
        )}

        {isSubmitting && (
          <div className="submitting-overlay">
            <LoadingSpinner />
            <span>Saving...</span>
          </div>
        )}
      </div>

      <footer className="game-footer">
        <div className="session-stats">
          <span>Drawings this session: {completedCount}</span>
        </div>
      </footer>
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const percentage = (current / total) * 100;

  return (
    <div className="progress-bar">
      <div
        className="progress-fill"
        style={{ width: `${percentage}%` }}
      />
      <span className="progress-text">{current} / {total}</span>
    </div>
  );
}

function ShapePrompt({ shape }: { shape: string }) {
  const instructions: Record<string, string> = {
    line: 'Draw a straight line from left to right',
    circle: 'Draw a complete circle in one stroke',
    square: 'Draw a square with 4 corners',
    triangle: 'Draw a triangle with 3 corners',
    heart: 'Draw a heart shape'
  };

  const icons: Record<string, string> = {
    line: '─',
    circle: '○',
    square: '□',
    triangle: '△',
    heart: '♡'
  };

  return (
    <div className="shape-prompt">
      <div className="shape-icon">{icons[shape]}</div>
      <h2>Draw a {shape}</h2>
      <p className="shape-instruction">{instructions[shape]}</p>
    </div>
  );
}
```

---

### Deep Dive 3: Admin Dashboard with Data Management (6 minutes)

**Challenge**: Build a comprehensive admin interface for managing training data.

```tsx
// frontend/src/routes/admin/AdminDashboard.tsx
type TabId = 'overview' | 'drawings' | 'quality' | 'training';

export function AdminDashboard() {
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated) {
      loadDashboardData();
    }
  }, [isAuthenticated]);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      const [statsData, drawingsData, modelsData] = await Promise.all([
        api.admin.getStats(),
        api.admin.getDrawings({ limit: 50 }),
        api.admin.getModels()
      ]);

      setStats(statsData);
      setDrawings(drawingsData);
      setModels(modelsData);
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFlag = async (drawingId: string) => {
    await api.admin.flagDrawing(drawingId);
    setDrawings(prev =>
      prev.map(d => d.id === drawingId ? { ...d, is_flagged: true } : d)
    );
  };

  const handleStartTraining = async (config: TrainingConfig) => {
    const job = await api.admin.startTraining(config);
    // Poll for status updates
    pollTrainingStatus(job.id);
  };

  if (!isAuthenticated) {
    return <AdminLogin onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <div className="admin-dashboard">
      <header className="admin-header">
        <h1>Data Labeling Admin</h1>
        <button onClick={() => setAuthenticated(false)}>Logout</button>
      </header>

      <nav className="admin-nav">
        {(['overview', 'drawings', 'quality', 'training'] as TabId[]).map(tab => (
          <button
            key={tab}
            className={`nav-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      <main className="admin-content">
        {isLoading ? (
          <LoadingSpinner />
        ) : (
          <>
            {activeTab === 'overview' && (
              <OverviewTab stats={stats!} />
            )}
            {activeTab === 'drawings' && (
              <DrawingsTab
                drawings={drawings}
                onFlag={handleFlag}
                onRefresh={loadDashboardData}
              />
            )}
            {activeTab === 'quality' && (
              <QualityTab drawings={drawings} />
            )}
            {activeTab === 'training' && (
              <TrainingTab
                models={models}
                onStartTraining={handleStartTraining}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
```

**Drawings Gallery with Filtering**:

```tsx
// frontend/src/routes/admin/components/DrawingsTab.tsx
interface DrawingsTabProps {
  drawings: Drawing[];
  onFlag: (id: string) => void;
  onRefresh: () => void;
}

export function DrawingsTab({ drawings, onFlag, onRefresh }: DrawingsTabProps) {
  const [shapeFilter, setShapeFilter] = useState<string>('all');
  const [qualityFilter, setQualityFilter] = useState<string>('all');
  const [showFlagged, setShowFlagged] = useState(false);

  const filteredDrawings = useMemo(() => {
    return drawings.filter(d => {
      if (shapeFilter !== 'all' && d.shape_name !== shapeFilter) return false;
      if (qualityFilter === 'high' && (d.quality_score || 0) < 0.7) return false;
      if (qualityFilter === 'low' && (d.quality_score || 1) > 0.3) return false;
      if (!showFlagged && d.is_flagged) return false;
      return true;
    });
  }, [drawings, shapeFilter, qualityFilter, showFlagged]);

  return (
    <div className="drawings-tab">
      <div className="filter-bar">
        <select
          value={shapeFilter}
          onChange={(e) => setShapeFilter(e.target.value)}
        >
          <option value="all">All Shapes</option>
          <option value="line">Line</option>
          <option value="circle">Circle</option>
          <option value="square">Square</option>
          <option value="triangle">Triangle</option>
          <option value="heart">Heart</option>
        </select>

        <select
          value={qualityFilter}
          onChange={(e) => setQualityFilter(e.target.value)}
        >
          <option value="all">All Quality</option>
          <option value="high">High Quality (70%+)</option>
          <option value="low">Low Quality (30%-)</option>
        </select>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showFlagged}
            onChange={(e) => setShowFlagged(e.target.checked)}
          />
          Show Flagged
        </label>

        <button onClick={onRefresh} className="btn-refresh">
          Refresh
        </button>
      </div>

      <div className="drawings-grid">
        {filteredDrawings.map(drawing => (
          <DrawingCard
            key={drawing.id}
            drawing={drawing}
            onFlag={() => onFlag(drawing.id)}
          />
        ))}
      </div>

      {filteredDrawings.length === 0 && (
        <div className="empty-state">
          No drawings match your filters.
        </div>
      )}
    </div>
  );
}
```

---

### Deep Dive 4: Implementor Portal for Model Testing (5 minutes)

**Challenge**: Allow testing drawings against trained model with clear feedback.

```tsx
// frontend/src/routes/implement/ImplementorPortal.tsx
export function ImplementorPortal() {
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [isClassifying, setClassifying] = useState(false);
  const [history, setHistory] = useState<PredictionHistory[]>([]);

  useEffect(() => {
    loadModelInfo();
  }, []);

  const loadModelInfo = async () => {
    try {
      const info = await api.inference.getModelInfo();
      setModelInfo(info);
    } catch (error) {
      console.error('Failed to load model info:', error);
    }
  };

  const handleClassify = async (strokes: Stroke[]) => {
    setClassifying(true);
    setPrediction(null);

    try {
      const result = await api.inference.classify({ strokes });

      setPrediction(result);
      setHistory(prev => [
        { timestamp: Date.now(), ...result },
        ...prev.slice(0, 9) // Keep last 10
      ]);

    } catch (error) {
      console.error('Classification failed:', error);
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="implementor-portal">
      <header className="portal-header">
        <h1>Model Testing Portal</h1>
        {modelInfo && (
          <div className="model-badge">
            Model v{modelInfo.version} • Accuracy: {(modelInfo.accuracy * 100).toFixed(1)}%
          </div>
        )}
      </header>

      <div className="portal-content">
        <div className="test-section">
          <h2>Draw to Test</h2>
          <PostItCanvas
            targetShape="anything"
            onComplete={handleClassify}
            onClear={() => setPrediction(null)}
          />
        </div>

        <div className="results-section">
          <h2>Prediction</h2>

          {isClassifying && (
            <div className="classifying-state">
              <LoadingSpinner />
              <span>Classifying...</span>
            </div>
          )}

          {prediction && !isClassifying && (
            <PredictionDisplay prediction={prediction} />
          )}

          {!prediction && !isClassifying && (
            <div className="empty-state">
              Draw something to see the prediction
            </div>
          )}
        </div>

        <div className="history-section">
          <h2>Recent Predictions</h2>
          <ul className="history-list">
            {history.map((item, index) => (
              <li key={index} className="history-item">
                <span className="shape">{item.shape}</span>
                <span className="confidence">
                  {(item.confidence * 100).toFixed(0)}%
                </span>
                <span className="latency">{item.latencyMs}ms</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PredictionDisplay({ prediction }: { prediction: Prediction }) {
  const confidenceColor =
    prediction.confidence > 0.8 ? 'high' :
    prediction.confidence > 0.5 ? 'medium' : 'low';

  return (
    <div className="prediction-display">
      <div className="predicted-shape">
        <span className="shape-name">{prediction.shape}</span>
        <span className="shape-icon">{getShapeIcon(prediction.shape)}</span>
      </div>

      <div className={`confidence-bar ${confidenceColor}`}>
        <div
          className="confidence-fill"
          style={{ width: `${prediction.confidence * 100}%` }}
        />
        <span className="confidence-text">
          {(prediction.confidence * 100).toFixed(1)}% confident
        </span>
      </div>

      <div className="metadata">
        <span>Latency: {prediction.latencyMs}ms</span>
        <span>Model: v{prediction.modelVersion}</span>
      </div>
    </div>
  );
}
```

---

## 5. Stroke Thumbnail Rendering (2 minutes)

**Challenge**: Display stroke data as thumbnails in gallery views.

```tsx
// frontend/src/components/StrokeThumbnail/StrokeThumbnail.tsx
interface StrokeThumbnailProps {
  strokes: Stroke[];
  width?: number;
  height?: number;
}

export function StrokeThumbnail({
  strokes,
  width = 100,
  height = 100
}: StrokeThumbnailProps) {
  const svgContent = useMemo(() => {
    if (!strokes || strokes.length === 0) return null;

    // Find bounding box
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    strokes.forEach(stroke => {
      stroke.points.forEach(point => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });
    });

    // Calculate scale to fit thumbnail
    const padding = 10;
    const contentWidth = maxX - minX || 1;
    const contentHeight = maxY - minY || 1;
    const scale = Math.min(
      (width - padding * 2) / contentWidth,
      (height - padding * 2) / contentHeight
    );

    const offsetX = (width - contentWidth * scale) / 2 - minX * scale;
    const offsetY = (height - contentHeight * scale) / 2 - minY * scale;

    return strokes.map((stroke, i) => {
      const d = stroke.points
        .map((p, j) => {
          const x = p.x * scale + offsetX;
          const y = p.y * scale + offsetY;
          return j === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
        })
        .join(' ');

      return (
        <path
          key={i}
          d={d}
          stroke={stroke.color}
          strokeWidth={Math.max(1, stroke.width * scale * 0.5)}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      );
    });
  }, [strokes, width, height]);

  return (
    <svg
      width={width}
      height={height}
      className="stroke-thumbnail"
      viewBox={`0 0 ${width} ${height}`}
    >
      <rect width={width} height={height} fill="#fffef0" rx={4} />
      {svgContent}
    </svg>
  );
}
```

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
