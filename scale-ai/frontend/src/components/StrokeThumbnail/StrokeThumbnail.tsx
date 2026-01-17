import { useRef, useEffect } from 'react'

interface Point {
  x: number
  y: number
  pressure?: number
  timestamp?: number
}

interface Stroke {
  points: Point[]
  color: string
  width: number
}

interface StrokeThumbnailProps {
  strokes: Stroke[]
  canvasSize?: { width: number; height: number }
  size?: number
  backgroundColor?: string
}

/**
 * Renders stroke data as a canvas thumbnail
 */
export function StrokeThumbnail({
  strokes,
  canvasSize = { width: 400, height: 400 },
  size = 100,
  backgroundColor = '#fffef0',
}: StrokeThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !strokes || strokes.length === 0) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear and fill background
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, size, size)

    // Calculate scale to fit strokes in thumbnail
    const scale = size / Math.max(canvasSize.width, canvasSize.height)

    // Draw each stroke
    strokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length < 2) return

      ctx.beginPath()
      ctx.strokeStyle = stroke.color || '#1a1a1a'
      ctx.lineWidth = Math.max(1, stroke.width * scale)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      const firstPoint = stroke.points[0]
      ctx.moveTo(firstPoint.x * scale, firstPoint.y * scale)

      for (let i = 1; i < stroke.points.length; i++) {
        const point = stroke.points[i]
        ctx.lineTo(point.x * scale, point.y * scale)
      }

      ctx.stroke()
    })
  }, [strokes, canvasSize, size, backgroundColor])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      }}
    />
  )
}

/**
 * Placeholder when stroke data is not available
 */
export function StrokeThumbnailPlaceholder({
  size = 100,
  shape,
}: {
  size?: number
  shape?: string
}) {
  const getShapeIcon = (s: string): string => {
    const icons: Record<string, string> = {
      line: '—',
      circle: '○',
      square: '□',
      triangle: '△',
      heart: '♡',
    }
    return icons[s] || '?'
  }

  return (
    <div
      style={{
        width: size,
        height: size,
        backgroundColor: '#f8fafc',
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.5,
        color: '#94a3b8',
      }}
    >
      {shape ? getShapeIcon(shape) : '?'}
    </div>
  )
}
