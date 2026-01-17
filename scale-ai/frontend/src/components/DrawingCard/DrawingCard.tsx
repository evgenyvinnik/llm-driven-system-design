import { useState, useEffect } from 'react'
import { StrokeThumbnail, StrokeThumbnailPlaceholder } from '../StrokeThumbnail'
import { getDrawingStrokes, type StrokeData } from '../../services/api'
import './DrawingCard.css'

interface DrawingCardProps {
  id: string
  shape: string
  createdAt: string
  isFlagged: boolean
  onFlag: (id: string, flagged: boolean) => void
}

export function DrawingCard({ id, shape, createdAt, isFlagged, onFlag }: DrawingCardProps) {
  const [strokeData, setStrokeData] = useState<StrokeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false

    const loadStrokes = async () => {
      try {
        setLoading(true)
        setError(false)
        const data = await getDrawingStrokes(id)
        if (!cancelled) {
          setStrokeData(data)
        }
      } catch {
        if (!cancelled) {
          setError(true)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadStrokes()

    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <div className={`drawing-card ${isFlagged ? 'flagged' : ''}`}>
      <div className="drawing-preview">
        {loading && (
          <div className="loading-thumbnail">
            <div className="spinner-small" />
          </div>
        )}
        {!loading && error && <StrokeThumbnailPlaceholder size={100} shape={shape} />}
        {!loading && !error && strokeData && (
          <StrokeThumbnail
            strokes={strokeData.strokes}
            canvasSize={strokeData.canvas}
            size={100}
          />
        )}
      </div>
      <div className="drawing-info">
        <span className="shape-label">{shape}</span>
        <span className="drawing-date">
          {new Date(createdAt).toLocaleDateString()}
        </span>
      </div>
      <button
        className={`flag-btn ${isFlagged ? 'unflag' : ''}`}
        onClick={() => onFlag(id, !isFlagged)}
      >
        {isFlagged ? 'Unflag' : 'Flag'}
      </button>
    </div>
  )
}
