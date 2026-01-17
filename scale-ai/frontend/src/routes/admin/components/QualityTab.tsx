/**
 * QualityTab component - Batch quality analysis and statistics.
 * Provides controls for running quality analysis on drawings and
 * displays quality distribution and per-shape quality metrics.
 * @module routes/admin/components/QualityTab
 */

import { useState } from 'react'
import {
  getQualityStats,
  analyzeBatchQuality,
  type QualityStats,
  type BatchAnalysisResult,
} from '../../../services/api'

/**
 * Options for batch quality analysis.
 */
export interface QualityOptions {
  /** Maximum number of drawings to analyze */
  limit: number
  /** Minimum score threshold for auto-flagging */
  minScore: number
  /** Whether to save scores to the database */
  updateScores: boolean
}

/**
 * Props for the QualityTab component.
 */
interface QualityTabProps {
  /** Callback when an error occurs */
  onError: (message: string) => void
}

/**
 * Quality analysis tab for the admin dashboard.
 * Provides batch analysis controls and displays quality statistics.
 * Includes quality distribution chart and per-shape quality table.
 *
 * @param props - Component props
 */
export function QualityTab({ onError }: QualityTabProps) {
  const [qualityStats, setQualityStats] = useState<QualityStats | null>(null)
  const [analysisResult, setAnalysisResult] = useState<BatchAnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [qualityOptions, setQualityOptions] = useState<QualityOptions>({
    limit: 100,
    minScore: 50,
    updateScores: false,
  })

  /**
   * Loads quality statistics from the API.
   */
  const handleRefreshStats = async () => {
    try {
      const stats = await getQualityStats()
      setQualityStats(stats)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load quality stats')
    }
  }

  /**
   * Runs batch quality analysis with current options.
   * Updates both analysis result and quality statistics.
   */
  const handleRunAnalysis = async () => {
    setAnalyzing(true)
    setAnalysisResult(null)
    try {
      const result = await analyzeBatchQuality(qualityOptions)
      setAnalysisResult(result)
      // Also refresh quality stats
      const stats = await getQualityStats()
      setQualityStats(stats)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }

  /**
   * Updates a quality option field.
   *
   * @param field - The option field to update
   * @param value - The new value
   */
  const updateOption = <K extends keyof QualityOptions>(
    field: K,
    value: QualityOptions[K]
  ) => {
    setQualityOptions((o) => ({ ...o, [field]: value }))
  }

  return (
    <div className="quality-section">
      <div className="quality-header">
        <h2>Data Quality</h2>
        <button onClick={handleRefreshStats} className="refresh-btn">
          Refresh Stats
        </button>
      </div>

      <QualityControlsCard
        options={qualityOptions}
        onOptionsChange={updateOption}
        onRunAnalysis={handleRunAnalysis}
        analyzing={analyzing}
        analysisResult={analysisResult}
      />

      {qualityStats && <QualityStatsDisplay stats={qualityStats} />}

      {!qualityStats && (
        <div className="quality-empty card">
          <p>Click "Refresh Stats" to load quality statistics.</p>
        </div>
      )}
    </div>
  )
}

/**
 * Props for the QualityControlsCard component.
 */
interface QualityControlsCardProps {
  /** Current quality options */
  options: QualityOptions
  /** Callback when an option changes */
  onOptionsChange: <K extends keyof QualityOptions>(
    field: K,
    value: QualityOptions[K]
  ) => void
  /** Callback to run analysis */
  onRunAnalysis: () => void
  /** Whether analysis is currently running */
  analyzing: boolean
  /** Result from the last analysis run */
  analysisResult: BatchAnalysisResult | null
}

/**
 * Card with controls for batch quality analysis.
 * Displays options for limit, min score, and whether to save results.
 *
 * @param props - Component props
 */
function QualityControlsCard({
  options,
  onOptionsChange,
  onRunAnalysis,
  analyzing,
  analysisResult,
}: QualityControlsCardProps) {
  return (
    <div className="quality-controls card">
      <h3>Batch Quality Analysis</h3>
      <p className="description">
        Analyze drawing quality and optionally auto-flag low quality submissions.
      </p>

      <div className="quality-form">
        <div className="form-row">
          <div className="form-group">
            <label>Limit (drawings to analyze)</label>
            <input
              type="number"
              value={options.limit}
              onChange={(e) =>
                onOptionsChange('limit', parseInt(e.target.value) || 100)
              }
              min={1}
              max={1000}
            />
          </div>

          <div className="form-group">
            <label>Min Score (for auto-flag)</label>
            <input
              type="number"
              value={options.minScore}
              onChange={(e) =>
                onOptionsChange('minScore', parseInt(e.target.value) || 50)
              }
              min={0}
              max={100}
            />
          </div>
        </div>

        <div className="form-group-checkbox">
          <label>
            <input
              type="checkbox"
              checked={options.updateScores}
              onChange={(e) => onOptionsChange('updateScores', e.target.checked)}
            />
            <span>Save scores to database (uncheck for dry run)</span>
          </label>
        </div>

        <div className="quality-actions">
          <button
            className="analyze-btn"
            onClick={onRunAnalysis}
            disabled={analyzing}
          >
            {analyzing ? 'Analyzing...' : 'Run Analysis'}
          </button>
        </div>
      </div>

      {analysisResult && <AnalysisResultDisplay result={analysisResult} />}
    </div>
  )
}

/**
 * Props for the AnalysisResultDisplay component.
 */
interface AnalysisResultDisplayProps {
  /** The batch analysis result to display */
  result: BatchAnalysisResult
}

/**
 * Displays the results of a batch quality analysis.
 *
 * @param props - Component props
 */
function AnalysisResultDisplay({ result }: AnalysisResultDisplayProps) {
  return (
    <div className="analysis-result">
      <h4>Analysis Results</h4>
      <p className="result-message">{result.message}</p>
      <div className="result-stats">
        <div className="result-stat">
          <span className="label">Analyzed</span>
          <span className="value">{result.analyzed}</span>
        </div>
        <div className="result-stat">
          <span className="label">Passed</span>
          <span className="value good">{result.passed}</span>
        </div>
        <div className="result-stat">
          <span className="label">Avg Score</span>
          <span className="value">{result.avgScore}</span>
        </div>
        <div className="result-stat">
          <span className="label">Flagged</span>
          <span className="value bad">{result.flagged}</span>
        </div>
        <div className="result-stat">
          <span className="label">Errors</span>
          <span className="value">{result.failed}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Props for the QualityStatsDisplay component.
 */
interface QualityStatsDisplayProps {
  /** Quality statistics to display */
  stats: QualityStats
}

/**
 * Displays quality statistics including distribution and per-shape metrics.
 *
 * @param props - Component props
 */
function QualityStatsDisplay({ stats }: QualityStatsDisplayProps) {
  return (
    <div className="quality-stats-grid">
      <QualityDistributionCard distribution={stats.distribution} />
      <QualityByShapeCard
        perShape={stats.perShape}
        unscoredCount={stats.unscoredCount}
      />
    </div>
  )
}

/**
 * Color mapping for quality tiers.
 */
const TIER_COLORS: Record<string, string> = {
  high: '#22c55e',
  medium: '#f59e0b',
  low: '#ef4444',
  unscored: '#94a3b8',
}

/**
 * Props for the QualityDistributionCard component.
 */
interface QualityDistributionCardProps {
  /** Array of quality tier counts */
  distribution: Array<{ quality_tier: string; count: string }>
}

/**
 * Card showing quality distribution as a bar chart.
 *
 * @param props - Component props
 */
function QualityDistributionCard({ distribution }: QualityDistributionCardProps) {
  const maxCount = Math.max(...distribution.map((t) => parseInt(t.count)), 1)

  return (
    <div className="card quality-distribution">
      <h3>Quality Distribution</h3>
      <div className="distribution-bars">
        {distribution.map((tier) => (
          <div key={tier.quality_tier} className="tier-bar">
            <span className="tier-label">{tier.quality_tier}</span>
            <div className="bar-container">
              <div
                className="bar-fill"
                style={{
                  width: `${(parseInt(tier.count) / maxCount) * 100}%`,
                  backgroundColor: TIER_COLORS[tier.quality_tier] || '#94a3b8',
                }}
              />
            </div>
            <span className="tier-count">{tier.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Per-shape quality metrics.
 */
interface ShapeQuality {
  shape: string
  avgScore: number | null
  count: number
}

/**
 * Props for the QualityByShapeCard component.
 */
interface QualityByShapeCardProps {
  /** Array of per-shape quality metrics */
  perShape: ShapeQuality[]
  /** Number of unscored drawings */
  unscoredCount: number
}

/**
 * Card showing quality metrics per shape in a table format.
 *
 * @param props - Component props
 */
function QualityByShapeCard({ perShape, unscoredCount }: QualityByShapeCardProps) {
  /**
   * Returns CSS class based on score value.
   *
   * @param score - The quality score
   */
  const getScoreClass = (score: number | null): string => {
    if (score === null) return ''
    if (score >= 70) return 'score-high'
    if (score >= 50) return 'score-medium'
    return 'score-low'
  }

  return (
    <div className="card quality-by-shape">
      <h3>Quality by Shape</h3>
      <table>
        <thead>
          <tr>
            <th>Shape</th>
            <th>Avg Score</th>
            <th>Scored</th>
          </tr>
        </thead>
        <tbody>
          {perShape.map((s) => (
            <tr key={s.shape}>
              <td className="shape-name">{s.shape}</td>
              <td className={getScoreClass(s.avgScore)}>
                {s.avgScore !== null ? `${s.avgScore}` : '-'}
              </td>
              <td>{s.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="unscored-note">{unscoredCount} drawings not yet scored</p>
    </div>
  )
}
