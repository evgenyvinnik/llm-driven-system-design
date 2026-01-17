import { useState, useCallback, useEffect } from 'react'
import { PostItCanvas } from './components/PostItCanvas'
import { AdminDashboard } from './routes/admin/AdminDashboard'
import { ImplementorPortal } from './routes/implement/ImplementorPortal'
import { submitDrawing, getUserStats } from './services/api'
import './App.css'

type Shape = 'line' | 'heart' | 'circle' | 'square' | 'triangle'
type View = 'draw' | 'admin' | 'implement'

const SHAPES: Shape[] = ['line', 'heart', 'circle', 'square', 'triangle']

function App() {
  // Router state (simple hash-based routing)
  const [view, setView] = useState<View>(() => {
    const hash = window.location.hash.slice(1)
    if (hash === 'admin') return 'admin'
    if (hash === 'implement') return 'implement'
    return 'draw'
  })

  // Drawing game state
  const [currentShapeIndex, setCurrentShapeIndex] = useState(0)
  const [totalDrawings, setTotalDrawings] = useState(0)
  const [todayDrawings, setTodayDrawings] = useState(0)
  const [showSuccess, setShowSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentShape = SHAPES[currentShapeIndex]

  // Listen to hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1)
      if (hash === 'admin') setView('admin')
      else if (hash === 'implement') setView('implement')
      else setView('draw')
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Load user stats on mount
  useEffect(() => {
    const loadStats = async () => {
      try {
        const stats = await getUserStats()
        setTotalDrawings(stats.total_drawings)
        setTodayDrawings(stats.today_count)
      } catch (err) {
        // Stats might fail if backend is not running, that's ok
        console.log('Could not load user stats:', err)
      }
    }
    loadStats()
  }, [])

  const handleComplete = useCallback(
    async (strokeData: {
      strokes: Array<{
        points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
        color: string
        width: number
      }>
      duration_ms: number
    }) => {
      if (submitting) return

      try {
        setSubmitting(true)
        setError(null)

        // Submit to backend
        await submitDrawing({
          shape: currentShape,
          canvas: { width: 400, height: 400 },
          strokes: strokeData.strokes,
          duration_ms: strokeData.duration_ms,
          device: 'ontouchstart' in window ? 'touch' : 'mouse',
        })

        // Update local counts
        setTotalDrawings((prev) => prev + 1)
        setTodayDrawings((prev) => prev + 1)

        // Show success animation
        setShowSuccess(true)
        setTimeout(() => setShowSuccess(false), 1500)

        // Move to next shape
        setCurrentShapeIndex((prev) => (prev + 1) % SHAPES.length)
      } catch (err) {
        console.error('Failed to submit drawing:', err)
        setError('Failed to save drawing. Is the backend running?')
        setTimeout(() => setError(null), 3000)
      } finally {
        setSubmitting(false)
      }
    },
    [currentShape, submitting]
  )

  const navigate = (newView: View) => {
    window.location.hash = newView === 'draw' ? '' : newView
    setView(newView)
  }

  // Render different views based on route
  if (view === 'admin') {
    return (
      <div className="app-container">
        <nav className="global-nav">
          <button onClick={() => navigate('draw')}>Draw</button>
          <button className="active" onClick={() => navigate('admin')}>
            Admin
          </button>
          <button onClick={() => navigate('implement')}>Test Model</button>
        </nav>
        <AdminDashboard />
      </div>
    )
  }

  if (view === 'implement') {
    return (
      <div className="app-container">
        <nav className="global-nav dark">
          <button onClick={() => navigate('draw')}>Draw</button>
          <button onClick={() => navigate('admin')}>Admin</button>
          <button className="active" onClick={() => navigate('implement')}>
            Test Model
          </button>
        </nav>
        <ImplementorPortal />
      </div>
    )
  }

  // Default: Drawing game view
  return (
    <div className="app">
      {/* Navigation */}
      <nav className="global-nav">
        <button className="active" onClick={() => navigate('draw')}>
          Draw
        </button>
        <button onClick={() => navigate('admin')}>Admin</button>
        <button onClick={() => navigate('implement')}>Test Model</button>
      </nav>

      {/* Stats header */}
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">✏️</span>
          <span className="logo-text">Doodle Trainer</span>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="stat-value">{totalDrawings}</span>
            <span className="stat-label">Total</span>
          </div>
          <div className="stat">
            <span className="stat-value">{todayDrawings}</span>
            <span className="stat-label">Today</span>
          </div>
        </div>
      </header>

      {/* Error banner */}
      {error && <div className="error-banner">{error}</div>}

      {/* Main drawing area */}
      <main className="app-main">
        <PostItCanvas shape={currentShape} onComplete={handleComplete} />
        {submitting && (
          <div className="submitting-overlay">
            <span>Saving...</span>
          </div>
        )}
      </main>

      {/* Success toast */}
      {showSuccess && (
        <div className="success-toast">
          <span className="success-icon">✓</span>
          <span className="success-text">Nice doodle!</span>
        </div>
      )}

      {/* Progress indicator */}
      <div className="progress-bar">
        {SHAPES.map((shape, index) => (
          <div
            key={shape}
            className={`progress-dot ${
              index < currentShapeIndex
                ? 'completed'
                : index === currentShapeIndex
                  ? 'active'
                  : ''
            }`}
            title={shape}
          />
        ))}
      </div>

      {/* Footer */}
      <footer className="app-footer">
        <p>Help train our AI by drawing simple shapes!</p>
        <p className="footer-sub">Your doodles teach machines to draw</p>
      </footer>
    </div>
  )
}

export default App
