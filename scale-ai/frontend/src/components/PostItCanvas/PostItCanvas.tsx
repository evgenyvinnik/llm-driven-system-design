/**
 * PostItCanvas component - Skeuomorphic drawing canvas styled as a post-it note.
 * Provides a tactile, nostalgic drawing experience with realistic marker strokes.
 * Features a cork board background, decorative Sharpie, and realistic paper textures.
 * @module components/PostItCanvas
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import './PostItCanvas.css'

/**
 * A single point in a stroke with position, pressure, and timing data.
 */
interface Point {
  x: number
  y: number
  pressure: number
  timestamp: number
}

/**
 * A complete stroke containing all points and styling.
 */
interface Stroke {
  points: Point[]
  color: string
  width: number
}

/**
 * Props for the PostItCanvas component.
 */
interface PostItCanvasProps {
  /** The shape the user should draw (use 'freeform' for classify mode) */
  shape: 'line' | 'heart' | 'circle' | 'square' | 'triangle' | 'freeform'
  /** Called when user clicks "Done!" with the stroke data */
  onComplete?: (strokeData: { strokes: Stroke[]; duration_ms: number }) => void
  /** Called when user clicks "Start Over" */
  onClear?: () => void
}

/** Human-readable prompts for each shape */
const SHAPE_PROMPTS: Record<string, string> = {
  line: 'Draw a line',
  heart: 'Draw a heart',
  circle: 'Draw a circle',
  square: 'Draw a square',
  triangle: 'Draw a triangle',
  freeform: 'Draw any shape',
}

/** Unicode symbols as visual hints for each shape */
const SHAPE_HINTS: Record<string, string> = {
  line: '—',
  heart: '♡',
  circle: '○',
  square: '□',
  triangle: '△',
  freeform: '✏️',
}

/**
 * A skeuomorphic drawing canvas styled as a yellow post-it note on a cork board.
 * Captures stroke data including timing and pressure for ML training.
 * Uses multi-pass canvas rendering to create a realistic marker ink effect.
 *
 * @param props - Component props
 * @param props.shape - The shape to prompt the user to draw
 * @param props.onComplete - Callback when user submits their drawing
 * @param props.onClear - Callback when user clears the canvas
 */
export function PostItCanvas({ shape, onComplete, onClear }: PostItCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [currentStroke, setCurrentStroke] = useState<Point[]>([])
  const [startTime, setStartTime] = useState<number | null>(null)
  const [hasDrawn, setHasDrawn] = useState(false)

  /** Marker styling for realistic ink effect */
  const markerColor = '#1a1a1a'
  const markerWidth = 4

  /**
   * Converts a mouse or touch event to canvas coordinates.
   * Handles both mouse and touch input, including pressure from supported devices.
   */
  const getCanvasPoint = useCallback(
    (e: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent): Point | null => {
      const canvas = canvasRef.current
      if (!canvas) return null

      const rect = canvas.getBoundingClientRect()
      const scaleX = canvas.width / rect.width
      const scaleY = canvas.height / rect.height

      let clientX: number, clientY: number, pressure = 0.5

      if ('touches' in e) {
        if (e.touches.length === 0) return null
        const touch = e.touches[0]
        clientX = touch.clientX
        clientY = touch.clientY
        // @ts-expect-error - force property exists on some touch devices
        pressure = touch.force || 0.5
      } else {
        clientX = e.clientX
        clientY = e.clientY
        // Simulate pressure based on movement speed later
        pressure = 0.5
      }

      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
        pressure,
        timestamp: Date.now(),
      }
    },
    []
  )

  /**
   * Draws a stroke with realistic marker ink effect using multiple passes.
   * First pass is dark, subsequent passes add ink bleeding and texture.
   */
  const drawMarkerStroke = useCallback(
    (ctx: CanvasRenderingContext2D, points: Point[], color: string, width: number) => {
      if (points.length < 2) return

      ctx.save()
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.strokeStyle = color

      // Draw multiple passes for marker ink effect
      for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath()
        ctx.globalAlpha = pass === 0 ? 0.8 : pass === 1 ? 0.4 : 0.2
        ctx.lineWidth = width + pass * 1.5

        ctx.moveTo(points[0].x, points[0].y)

        for (let i = 1; i < points.length - 1; i++) {
          const xc = (points[i].x + points[i + 1].x) / 2
          const yc = (points[i].y + points[i + 1].y) / 2
          ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc)
        }

        if (points.length > 1) {
          const last = points[points.length - 1]
          ctx.lineTo(last.x, last.y)
        }

        ctx.stroke()
      }

      // Add slight ink bleeding effect at random points
      ctx.globalAlpha = 0.1
      for (let i = 0; i < points.length; i += 5) {
        const p = points[i]
        const bleedSize = Math.random() * 2 + 1
        ctx.beginPath()
        ctx.arc(p.x + (Math.random() - 0.5) * 2, p.y + (Math.random() - 0.5) * 2, bleedSize, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }

      ctx.restore()
    },
    []
  )

  /**
   * Redraws the entire canvas including all completed strokes and current stroke.
   */
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear with paper texture background
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Draw all completed strokes
    strokes.forEach((stroke) => {
      drawMarkerStroke(ctx, stroke.points, stroke.color, stroke.width)
    })

    // Draw current stroke
    if (currentStroke.length > 0) {
      drawMarkerStroke(ctx, currentStroke, markerColor, markerWidth)
    }
  }, [strokes, currentStroke, drawMarkerStroke])

  useEffect(() => {
    redrawCanvas()
  }, [redrawCanvas])

  /** Handles starting a new stroke on mouse/touch down */
  const handleStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      const point = getCanvasPoint(e)
      if (!point) return

      if (!startTime) {
        setStartTime(Date.now())
      }

      setIsDrawing(true)
      setCurrentStroke([point])
      setHasDrawn(true)
    },
    [getCanvasPoint, startTime]
  )

  /** Handles adding points to the current stroke on move */
  const handleMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!isDrawing) return
      e.preventDefault()

      const point = getCanvasPoint(e)
      if (!point) return

      setCurrentStroke((prev) => [...prev, point])
    },
    [isDrawing, getCanvasPoint]
  )

  /** Handles completing the current stroke on mouse/touch up */
  const handleEnd = useCallback(() => {
    if (!isDrawing) return

    if (currentStroke.length > 1) {
      setStrokes((prev) => [
        ...prev,
        { points: currentStroke, color: markerColor, width: markerWidth },
      ])
    }

    setCurrentStroke([])
    setIsDrawing(false)
  }, [isDrawing, currentStroke])

  /** Clears all strokes and resets the canvas */
  const handleClear = () => {
    setStrokes([])
    setCurrentStroke([])
    setStartTime(null)
    setHasDrawn(false)
    onClear?.()
  }

  /** Submits the drawing and resets for the next one */
  const handleSubmit = () => {
    if (!hasDrawn || strokes.length === 0) return

    const duration = startTime ? Date.now() - startTime : 0
    onComplete?.({
      strokes,
      duration_ms: duration,
    })

    // Reset for next drawing
    handleClear()
  }

  return (
    <div className="postit-workspace">
      {/* Cork board background */}
      <div className="cork-board">
        {/* Prompt post-it */}
        <div className="prompt-postit">
          <div className="prompt-pin" />
          <span className="prompt-text">{SHAPE_PROMPTS[shape]}</span>
          <span className="prompt-hint">{SHAPE_HINTS[shape]}</span>
        </div>

        {/* Main drawing post-it */}
        <div className="main-postit">
          <div className="postit-shadow" />
          <div className="postit-paper">
            <div className="paper-texture" />
            <div className="adhesive-strip" />
            <canvas
              ref={canvasRef}
              width={400}
              height={400}
              className="drawing-canvas"
              onMouseDown={handleStart}
              onMouseMove={handleMove}
              onMouseUp={handleEnd}
              onMouseLeave={handleEnd}
              onTouchStart={handleStart}
              onTouchMove={handleMove}
              onTouchEnd={handleEnd}
            />
            <div className="postit-curl" />
          </div>
        </div>

        {/* Marker decoration */}
        <div className="marker-decoration">
          <div className="marker-body">
            <div className="marker-cap" />
            <div className="marker-label">SHARPIE</div>
            <div className="marker-tip" />
          </div>
        </div>

        {/* Action buttons */}
        <div className="action-buttons">
          <button className="btn-clear" onClick={handleClear} disabled={!hasDrawn}>
            Start Over
          </button>
          <button className="btn-submit" onClick={handleSubmit} disabled={!hasDrawn || strokes.length === 0}>
            Done!
          </button>
        </div>
      </div>
    </div>
  )
}

export default PostItCanvas
