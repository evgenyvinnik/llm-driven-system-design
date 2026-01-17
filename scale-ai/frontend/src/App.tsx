import { useState, useCallback } from 'react'
import { PostItCanvas } from './components/PostItCanvas'
import './App.css'

type Shape = 'line' | 'heart' | 'circle' | 'square' | 'triangle'

const SHAPES: Shape[] = ['line', 'heart', 'circle', 'square', 'triangle']

interface DrawingData {
  shape: Shape
  strokes: Array<{
    points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
    color: string
    width: number
  }>
  duration_ms: number
  submittedAt: number
}

function App() {
  const [currentShapeIndex, setCurrentShapeIndex] = useState(0)
  const [completedDrawings, setCompletedDrawings] = useState<DrawingData[]>([])
  const [showSuccess, setShowSuccess] = useState(false)

  const currentShape = SHAPES[currentShapeIndex]
  const totalCompleted = completedDrawings.length

  const handleComplete = useCallback(
    (strokeData: { strokes: DrawingData['strokes']; duration_ms: number }) => {
      const drawing: DrawingData = {
        shape: currentShape,
        strokes: strokeData.strokes,
        duration_ms: strokeData.duration_ms,
        submittedAt: Date.now(),
      }

      setCompletedDrawings((prev) => [...prev, drawing])

      // Show success animation
      setShowSuccess(true)
      setTimeout(() => setShowSuccess(false), 1500)

      // Move to next shape
      setCurrentShapeIndex((prev) => (prev + 1) % SHAPES.length)

      // In a real app, we'd send this to the API
      console.log('Drawing submitted:', drawing)
    },
    [currentShape]
  )

  return (
    <div className="app">
      {/* Stats header */}
      <header className="app-header">
        <div className="logo">
          <span className="logo-icon">✏️</span>
          <span className="logo-text">Doodle Trainer</span>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="stat-value">{totalCompleted}</span>
            <span className="stat-label">Doodles</span>
          </div>
          <div className="stat">
            <span className="stat-value">{currentShapeIndex + 1}</span>
            <span className="stat-label">/ {SHAPES.length}</span>
          </div>
        </div>
      </header>

      {/* Main drawing area */}
      <main className="app-main">
        <PostItCanvas
          shape={currentShape}
          onComplete={handleComplete}
        />
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
