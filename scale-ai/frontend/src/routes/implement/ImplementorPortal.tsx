/**
 * ImplementorPortal component - Test interface for ML model predictions.
 * Allows users to draw shapes and see how the trained model classifies them.
 * Displays prediction confidence, all class probabilities, and inference time.
 * @module routes/implement/ImplementorPortal
 */

import { useState, useCallback } from 'react'
import { PostItCanvas } from '../../components/PostItCanvas'
import { classifyDrawing, getModelInfo, type ClassificationResult, type ModelInfo } from '../../services/api'
import './ImplementorPortal.css'

/**
 * The model tester portal for implementors.
 * Provides a canvas for drawing and displays classification results.
 */
export function ImplementorPortal() {
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  const [result, setResult] = useState<ClassificationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Loads model info from the inference service.
   * Called on first drawing interaction.
   */
  const loadModelInfo = useCallback(async () => {
    try {
      const info = await getModelInfo()
      setModelInfo(info)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load model')
    }
  }, [])

  /**
   * Handles drawing completion and runs classification.
   * Sends strokes to inference API and displays results.
   */
  const handleComplete = async (strokeData: {
    strokes: Array<{
      points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
      color: string
      width: number
    }>
    duration_ms: number
  }) => {
    try {
      setLoading(true)
      setError(null)

      // Load model info if not loaded
      if (!modelInfo) {
        await loadModelInfo()
      }

      const classification = await classifyDrawing(strokeData.strokes, { width: 400, height: 400 })
      setResult(classification)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Classification failed')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Clears the current classification result.
   */
  const handleClear = () => {
    setResult(null)
  }

  return (
    <div className="implementor-portal">
      <header className="portal-header">
        <h1>Model Tester</h1>
        <p>Draw a shape and see how the AI classifies it</p>
        {modelInfo && (
          <div className="model-badge">
            Model: {modelInfo.version} ({(modelInfo.accuracy * 100).toFixed(1)}% accuracy)
          </div>
        )}
      </header>

      <div className="portal-content">
        <div className="canvas-section">
          <PostItCanvas
            shape="circle" // Placeholder, not used for prompt in this mode
            onComplete={handleComplete}
            onClear={handleClear}
          />
        </div>

        <div className="results-section">
          {loading && (
            <div className="loading-state">
              <div className="spinner" />
              <p>Analyzing your drawing...</p>
            </div>
          )}

          {error && (
            <div className="error-state">
              <h3>Error</h3>
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && result && (
            <div className="result-card">
              <h2>Prediction</h2>
              <div className="prediction">
                <span className="predicted-shape">{getShapeIcon(result.prediction)}</span>
                <span className="predicted-label">{result.prediction}</span>
              </div>
              <div className="confidence">
                <span className="confidence-label">Confidence:</span>
                <div className="confidence-bar">
                  <div
                    className="confidence-fill"
                    style={{ width: `${result.confidence * 100}%` }}
                  />
                </div>
                <span className="confidence-value">
                  {(result.confidence * 100).toFixed(1)}%
                </span>
              </div>

              <div className="all-probabilities">
                <h3>All Probabilities</h3>
                {result.all_probabilities
                  .sort((a, b) => b.probability - a.probability)
                  .map((prob) => (
                    <div key={prob.class} className="prob-row">
                      <span className="prob-icon">{getShapeIcon(prob.class)}</span>
                      <span className="prob-name">{prob.class}</span>
                      <div className="prob-bar">
                        <div
                          className="prob-fill"
                          style={{ width: `${prob.probability * 100}%` }}
                        />
                      </div>
                      <span className="prob-value">
                        {(prob.probability * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
              </div>

              <div className="inference-time">
                Inference time: {result.inference_time_ms}ms
              </div>
            </div>
          )}

          {!loading && !error && !result && (
            <div className="empty-state">
              <p>Draw something on the post-it note!</p>
              <p className="hint">The AI will try to classify your drawing</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Maps shape names to Unicode symbols for display.
 *
 * @param shape - Shape name to convert
 * @returns Unicode symbol representing the shape
 */
function getShapeIcon(shape: string): string {
  const icons: Record<string, string> = {
    line: '—',
    circle: '○',
    square: '□',
    triangle: '△',
    heart: '♡',
  }
  return icons[shape] || '?'
}

export default ImplementorPortal
