/**
 * Main App component for the Doodle Trainer application.
 * Provides a simple hash-based router for three views:
 * - Drawing game (default): Users draw shapes to generate training data
 * - Admin dashboard: Data management and model training
 * - Implementor portal: Test trained models with live inference
 * @module App
 */

import { useState, useCallback, useEffect } from 'react'
import { PostItCanvas } from './components/PostItCanvas'
import { AdminDashboard } from './routes/admin/AdminDashboard'
import { ImplementorPortal } from './routes/implement/ImplementorPortal'
import { submitDrawing, getUserStats } from './services/api'
import { sounds, isSoundEnabled, setSoundEnabled } from './utils/sounds'
import './App.css'

/** Available shape types for the drawing game */
type Shape = 'line' | 'heart' | 'circle' | 'square' | 'triangle'

/** Available views in the application */
type View = 'draw' | 'admin' | 'implement'

/** Ordered list of shapes for the drawing cycle */
const SHAPES: Shape[] = ['line', 'heart', 'circle', 'square', 'triangle']

/** Drawing count thresholds that trigger celebration animations */
const MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000]

/**
 * Root application component.
 * Manages routing, game state, and user statistics.
 */
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
  const [streakDays, setStreakDays] = useState(0)
  const [level, setLevel] = useState(1)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showMilestone, setShowMilestone] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [soundOn, setSoundOn] = useState(isSoundEnabled())

  /** Current shape to draw in the cycle */
  const currentShape = SHAPES[currentShapeIndex]

  /** Listen to hash changes for navigation */
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

  /** Load user stats on mount */
  useEffect(() => {
    const loadStats = async () => {
      try {
        const stats = await getUserStats()
        setTotalDrawings(stats.total_drawings)
        setTodayDrawings(stats.today_count)
        setStreakDays(stats.streak_days)
        setLevel(stats.level)
      } catch (err) {
        // Stats might fail if backend is not running, that's ok
        console.log('Could not load user stats:', err)
      }
    }
    loadStats()
  }, [])

  /** Toggle sound effects on/off */
  const toggleSound = () => {
    const newValue = !soundOn
    setSoundOn(newValue)
    setSoundEnabled(newValue)
    if (newValue) sounds.click()
  }

  /**
   * Handles drawing submission.
   * Submits to backend, updates stats, plays sounds, and cycles to next shape.
   */
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

        const newTotal = totalDrawings + 1

        // Check for milestone
        if (MILESTONES.includes(newTotal)) {
          setShowMilestone(newTotal)
          sounds.levelUp()
          setTimeout(() => setShowMilestone(null), 3000)
        } else {
          sounds.success()
        }

        // Update local counts
        setTotalDrawings(newTotal)
        setTodayDrawings((prev) => prev + 1)
        setLevel(Math.floor(newTotal / 10) + 1)

        // Show success animation
        setShowSuccess(true)
        setTimeout(() => setShowSuccess(false), 1500)

        // Move to next shape
        setCurrentShapeIndex((prev) => (prev + 1) % SHAPES.length)
      } catch (err) {
        console.error('Failed to submit drawing:', err)
        setError('Failed to save drawing. Is the backend running?')
        sounds.error()
        setTimeout(() => setError(null), 3000)
      } finally {
        setSubmitting(false)
      }
    },
    [currentShape, submitting, totalDrawings]
  )

  /**
   * Navigates to a different view using hash routing.
   */
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
        <button className="sound-toggle" onClick={toggleSound} title={soundOn ? 'Mute sounds' : 'Enable sounds'}>
          {soundOn ? '🔊' : '🔇'}
        </button>
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
          {streakDays > 0 && (
            <div className="stat streak">
              <span className="stat-value">🔥 {streakDays}</span>
              <span className="stat-label">Streak</span>
            </div>
          )}
          <div className="stat level">
            <span className="stat-value">Lv.{level}</span>
            <span className="stat-label">{level * 10 - totalDrawings} to next</span>
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

      {/* Milestone celebration */}
      {showMilestone && (
        <div className="milestone-toast">
          <span className="milestone-icon">🎉</span>
          <span className="milestone-text">{showMilestone} drawings!</span>
          <span className="milestone-sub">You're on fire!</span>
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
