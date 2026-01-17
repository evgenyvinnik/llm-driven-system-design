/**
 * GenerateMode component - Generates shapes using the trained model.
 * Allows users to select a shape class and see the AI draw it.
 * Uses prototypes computed from training data or procedural fallbacks.
 * @module routes/implement/GenerateMode
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { generateShape, getModelInfo, type GenerationResult, type ModelInfo } from '../../services/api'
import './GenerateMode.css'

/** Available shape classes */
const SHAPES = ['circle', 'heart', 'line', 'square', 'triangle'] as const
type ShapeType = (typeof SHAPES)[number]

/** Unicode symbols for each shape */
const SHAPE_ICONS: Record<string, string> = {
  line: '—',
  circle: '○',
  square: '□',
  triangle: '△',
  heart: '♡',
}

/**
 * The Generate mode panel for the model tester.
 * Users select a shape and the AI generates a drawing.
 */
export function GenerateMode() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selectedShape, setSelectedShape] = useState<ShapeType>('circle')
  const [result, setResult] = useState<GenerationResult | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isAnimating, setIsAnimating] = useState(false)

  /**
   * Loads model info on mount.
   */
  useEffect(() => {
    const loadModel = async () => {
      try {
        const info = await getModelInfo()
        setModelInfo(info)
      } catch (err) {
        // Model info will be loaded on first generation
      }
    }
    loadModel()
  }, [])

  /**
   * Draws strokes on the canvas with animation.
   */
  const drawStrokes = useCallback(
    (
      strokes: GenerationResult['strokes'],
      animate: boolean = true
    ) => {
      const canvas = canvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      if (!animate) {
        // Draw all strokes immediately
        strokes.forEach((stroke) => {
          drawStroke(ctx, stroke.points, stroke.color, stroke.width)
        })
        return
      }

      // Animate drawing
      setIsAnimating(true)
      let currentStrokeIndex = 0
      let currentPointIndex = 0
      const speed = 3 // Points per frame

      const animateFrame = () => {
        if (currentStrokeIndex >= strokes.length) {
          setIsAnimating(false)
          return
        }

        const stroke = strokes[currentStrokeIndex]
        const endPoint = Math.min(currentPointIndex + speed, stroke.points.length)

        // Draw partial stroke
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Draw completed strokes
        for (let i = 0; i < currentStrokeIndex; i++) {
          drawStroke(ctx, strokes[i].points, strokes[i].color, strokes[i].width)
        }

        // Draw current stroke up to current point
        if (endPoint > 1) {
          drawStroke(
            ctx,
            stroke.points.slice(0, endPoint),
            stroke.color,
            stroke.width
          )
        }

        currentPointIndex = endPoint

        if (currentPointIndex >= stroke.points.length) {
          currentStrokeIndex++
          currentPointIndex = 0
        }

        requestAnimationFrame(animateFrame)
      }

      requestAnimationFrame(animateFrame)
    },
    []
  )

  /**
   * Draws a single stroke with marker-like effect.
   */
  const drawStroke = (
    ctx: CanvasRenderingContext2D,
    points: Array<{ x: number; y: number }>,
    color: string,
    width: number
  ) => {
    if (points.length < 2) return

    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = color

    // Draw multiple passes for marker effect
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

    ctx.restore()
  }

  /**
   * Handles generating a shape.
   */
  const handleGenerate = async () => {
    try {
      setLoading(true)
      setError(null)
      setResult(null)

      // Clear canvas
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }

      const generation = await generateShape(selectedShape)
      setResult(generation)

      // Load model info if not loaded
      if (!modelInfo) {
        try {
          const info = await getModelInfo()
          setModelInfo(info)
        } catch {
          // Ignore
        }
      }

      // Animate the drawing
      drawStrokes(generation.strokes, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Regenerates the current shape.
   */
  const handleRegenerate = () => {
    if (!isAnimating) {
      handleGenerate()
    }
  }

  return (
    <div className="generate-mode">
      <div className="generate-controls">
        <h2>Select a Shape</h2>
        <div className="shape-selector">
          {SHAPES.map((shape) => (
            <button
              key={shape}
              className={`shape-btn ${selectedShape === shape ? 'active' : ''}`}
              onClick={() => setSelectedShape(shape)}
              disabled={loading || isAnimating}
            >
              <span className="shape-icon">{SHAPE_ICONS[shape]}</span>
              <span className="shape-name">{shape}</span>
            </button>
          ))}
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={loading || isAnimating}
        >
          {loading ? 'Generating...' : 'Generate Shape'}
        </button>
      </div>

      <div className="generate-canvas-section">
        <div className="canvas-wrapper">
          <div className="canvas-postit">
            <div className="postit-shadow" />
            <div className="postit-paper">
              <div className="paper-texture" />
              <canvas
                ref={canvasRef}
                width={400}
                height={400}
                className="display-canvas"
              />
              <div className="postit-curl" />
            </div>
          </div>
        </div>

        {error && (
          <div className="generate-error">
            <p>{error}</p>
          </div>
        )}

        {result && !loading && !isAnimating && (
          <div className="generate-result">
            <div className="result-info">
              <span className="result-shape">
                {SHAPE_ICONS[result.shape]} {result.shape}
              </span>
              <span className="result-time">
                Generated in {result.generation_time_ms}ms
              </span>
            </div>
            <button
              className="regenerate-btn"
              onClick={handleRegenerate}
            >
              Regenerate
            </button>
          </div>
        )}

        {!result && !loading && !error && (
          <div className="generate-hint">
            <p>Select a shape and click "Generate" to see the AI draw it!</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default GenerateMode
