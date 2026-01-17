/**
 * DrawingCard component - Displays a drawing with its metadata and actions.
 * Used in the admin dashboard gallery to show drawing thumbnails with
 * flag, delete, and restore capabilities.
 * @module components/DrawingCard
 */

import { useState, useEffect } from 'react'
import { StrokeThumbnail, StrokeThumbnailPlaceholder } from '../StrokeThumbnail'
import { getDrawingStrokes, type StrokeData } from '../../services/api'
import './DrawingCard.css'

/**
 * Props for the DrawingCard component.
 */
interface DrawingCardProps {
  /** Unique drawing ID */
  id: string
  /** The shape that was drawn */
  shape: string
  /** ISO timestamp when drawing was created */
  createdAt: string
  /** Whether the drawing is flagged for review */
  isFlagged: boolean
  /** Whether the drawing is soft-deleted */
  isDeleted: boolean
  /** Called when flag/unflag button is clicked */
  onFlag: (id: string, flagged: boolean) => void
  /** Called when delete button is clicked */
  onDelete: (id: string) => void
  /** Called when restore button is clicked */
  onRestore: (id: string) => void
}

/**
 * A card component displaying a drawing thumbnail with metadata and action buttons.
 * Lazily loads stroke data from the API for efficient gallery rendering.
 *
 * @param props - Component props
 */
export function DrawingCard({
  id,
  shape,
  createdAt,
  isFlagged,
  isDeleted,
  onFlag,
  onDelete,
  onRestore,
}: DrawingCardProps) {
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

  const cardClass = [
    'drawing-card',
    isFlagged ? 'flagged' : '',
    isDeleted ? 'deleted' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardClass}>
      {isDeleted && <span className="deleted-badge">Deleted</span>}
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
      <div className="drawing-actions">
        {!isDeleted ? (
          <>
            <button
              className={`flag-btn ${isFlagged ? 'unflag' : ''}`}
              onClick={() => onFlag(id, !isFlagged)}
            >
              {isFlagged ? 'Unflag' : 'Flag'}
            </button>
            <button
              className="delete-btn"
              onClick={() => onDelete(id)}
            >
              Delete
            </button>
          </>
        ) : (
          <button
            className="restore-btn"
            onClick={() => onRestore(id)}
          >
            Restore
          </button>
        )}
      </div>
    </div>
  )
}
