/**
 * AdminDashboard component - Data management and model training interface.
 * Provides tabs for:
 * - Overview: Statistics and recent training jobs
 * - Drawings: Gallery with filtering, flag, and delete capabilities
 * - Quality: Batch quality analysis and statistics
 * - Training: Model training and activation
 *
 * Requires authentication - shows login form if not logged in.
 * @module routes/admin/AdminDashboard
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getAdminStats,
  getDrawings,
  startTraining,
  getModels,
  activateModel,
  flagDrawing,
  deleteDrawing,
  restoreDrawing,
  adminLogin,
  adminLogout,
  getAdminUser,
  getQualityStats,
  analyzeBatchQuality,
  type AdminStats,
  type Drawing,
  type Model,
  type AdminUser,
  type QualityStats,
  type BatchAnalysisResult,
} from '../../services/api'
import { DrawingCard } from '../../components/DrawingCard'
import './AdminDashboard.css'

/**
 * Login form component for admin authentication.
 * Validates email format and password length before submission.
 *
 * @param props - Component props
 * @param props.onLogin - Callback when login succeeds with user data
 */
function AdminLogin({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [touched, setTouched] = useState<{ email: boolean; password: boolean }>({
    email: false,
    password: false,
  })

  /** Check if email has valid format */
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  /** Check if password meets minimum length */
  const passwordValid = password.length >= 6
  /** Form is valid when both fields pass validation */
  const formValid = emailValid && passwordValid

  /**
   * Returns email validation error message, if any.
   */
  const getEmailError = () => {
    if (!touched.email) return null
    if (!email) return 'Email is required'
    if (!emailValid) return 'Please enter a valid email address'
    return null
  }

  /**
   * Returns password validation error message, if any.
   */
  const getPasswordError = () => {
    if (!touched.password) return null
    if (!password) return 'Password is required'
    if (!passwordValid) return 'Password must be at least 6 characters'
    return null
  }

  /**
   * Handles form submission - validates and attempts login.
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched({ email: true, password: true })

    if (!formValid) return

    setError(null)
    setLoading(true)

    try {
      const { user } = await adminLogin(email, password, rememberMe)
      onLogin(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const emailError = getEmailError()
  const passwordError = getPasswordError()

  return (
    <div className="admin-login">
      <div className="login-card">
        <h1>Admin Dashboard</h1>
        <p className="subtitle">Sign in to manage your data</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className={`form-group ${emailError ? 'has-error' : ''}`}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              placeholder="admin@scaleai.local"
              className={emailError ? 'input-error' : ''}
            />
            {emailError && <span className="field-error">{emailError}</span>}
          </div>

          <div className={`form-group ${passwordError ? 'has-error' : ''}`}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              placeholder="Enter password"
              className={passwordError ? 'input-error' : ''}
            />
            {passwordError && <span className="field-error">{passwordError}</span>}
          </div>

          <div className="form-group-checkbox">
            <label>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>Remember me for 30 days</span>
            </label>
          </div>

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="login-hint">
          Default: <code>admin@scaleai.local</code> / <code>admin123</code>
        </div>
      </div>
    </div>
  )
}

/**
 * Main admin dashboard component.
 * Manages authentication state and provides tabbed interface for data management.
 */
export function AdminDashboard() {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'drawings' | 'quality' | 'training'>('overview')
  const [trainingInProgress, setTrainingInProgress] = useState(false)

  // Quality state
  const [qualityStats, setQualityStats] = useState<QualityStats | null>(null)
  const [analysisResult, setAnalysisResult] = useState<BatchAnalysisResult | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [qualityOptions, setQualityOptions] = useState({
    limit: 100,
    minScore: 50,
    updateScores: false,
  })

  // Filter state
  const [filters, setFilters] = useState({
    shape: '',
    startDate: '',
    endDate: '',
    includeDeleted: false,
  })

  // Check if user is already logged in
  useEffect(() => {
    getAdminUser()
      .then((u) => {
        setUser(u)
        setAuthChecked(true)
      })
      .catch(() => setAuthChecked(true))
  }, [])

  /**
   * Loads all dashboard data (stats, drawings, models).
   */
  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const [statsData, drawingsData, modelsData] = await Promise.all([
        getAdminStats(),
        getDrawings(1, 20),
        getModels(),
      ])
      setStats(statsData)
      setDrawings(drawingsData.drawings)
      setModels(modelsData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) {
      loadData()
    }
  }, [user, loadData])

  /** Logs out the current admin user */
  const handleLogout = async () => {
    await adminLogout()
    setUser(null)
  }

  /** Starts a new training job */
  const handleStartTraining = async () => {
    try {
      setTrainingInProgress(true)
      await startTraining({ epochs: 10, batch_size: 32 })
      // Refresh data after starting training
      setTimeout(loadData, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start training')
    } finally {
      setTrainingInProgress(false)
    }
  }

  /** Activates a trained model for inference */
  const handleActivateModel = async (modelId: string) => {
    try {
      await activateModel(modelId)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate model')
    }
  }

  /** Flags or unflags a drawing */
  const handleFlagDrawing = async (drawingId: string, flagged: boolean) => {
    try {
      await flagDrawing(drawingId, flagged)
      setDrawings((prev) =>
        prev.map((d) => (d.id === drawingId ? { ...d, is_flagged: flagged } : d))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to flag drawing')
    }
  }

  /** Soft-deletes a drawing */
  const handleDeleteDrawing = async (drawingId: string) => {
    try {
      await deleteDrawing(drawingId)
      setDrawings((prev) =>
        prev.map((d) => (d.id === drawingId ? { ...d, deleted_at: new Date().toISOString() } : d))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete drawing')
    }
  }

  /** Restores a soft-deleted drawing */
  const handleRestoreDrawing = async (drawingId: string) => {
    try {
      await restoreDrawing(drawingId)
      setDrawings((prev) =>
        prev.map((d) => (d.id === drawingId ? { ...d, deleted_at: null } : d))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore drawing')
    }
  }

  /** Loads drawings with current filter settings */
  const loadFilteredDrawings = async () => {
    try {
      const data = await getDrawings(1, 20, {
        shape: filters.shape || undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
        includeDeleted: filters.includeDeleted,
      })
      setDrawings(data.drawings)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drawings')
    }
  }

  /** Resets all filters and reloads data */
  const clearFilters = () => {
    setFilters({
      shape: '',
      startDate: '',
      endDate: '',
      includeDeleted: false,
    })
    loadData()
  }

  // Show loading while checking auth
  if (!authChecked) {
    return (
      <div className="admin-loading">
        <div className="spinner" />
        <p>Checking authentication...</p>
      </div>
    )
  }

  // Show login page if not authenticated
  if (!user) {
    return <AdminLogin onLogin={setUser} />
  }

  if (loading) {
    return (
      <div className="admin-loading">
        <div className="spinner" />
        <p>Loading dashboard...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="admin-error">
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={loadData}>Retry</button>
      </div>
    )
  }

  return (
    <div className="admin-dashboard">
      <header className="admin-header">
        <h1>Admin Dashboard</h1>
        <div className="user-menu">
          <span className="user-email">{user.email}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>
      <nav className="admin-nav" style={{ padding: '0 2rem', background: 'white', borderBottom: '1px solid #e2e8f0' }}>
        <button
            className={activeTab === 'overview' ? 'active' : ''}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            className={activeTab === 'drawings' ? 'active' : ''}
            onClick={() => setActiveTab('drawings')}
          >
            Drawings
          </button>
          <button
            className={activeTab === 'quality' ? 'active' : ''}
            onClick={() => setActiveTab('quality')}
          >
            Quality
          </button>
          <button
            className={activeTab === 'training' ? 'active' : ''}
            onClick={() => setActiveTab('training')}
          >
            Training
          </button>
        </nav>

      <main className="admin-content">
        {activeTab === 'overview' && stats && (
          <div className="overview-grid">
            <StatCard
              title="Total Drawings"
              value={stats.total_drawings}
              subtitle={`${stats.today_count} today`}
              color="blue"
            />
            <StatCard
              title="Total Users"
              value={stats.total_users}
              color="green"
            />
            <StatCard
              title="Flagged"
              value={stats.flagged_count}
              color="red"
            />
            <StatCard
              title="Active Model"
              value={stats.active_model?.version || 'None'}
              subtitle={stats.active_model ? `${(stats.active_model.accuracy * 100).toFixed(1)}% accuracy` : 'Train a model'}
              color="purple"
            />

            <div className="shape-breakdown card">
              <h3>Drawings by Shape</h3>
              <div className="shape-bars">
                {stats.drawings_per_shape.map((shape) => (
                  <div key={shape.name} className="shape-bar">
                    <span className="shape-name">{shape.name}</span>
                    <div className="bar-container">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${(shape.count / Math.max(...stats.drawings_per_shape.map((s) => s.count), 1)) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="shape-count">{shape.count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="recent-jobs card">
              <h3>Recent Training Jobs</h3>
              <ul>
                {stats.recent_jobs.map((job) => (
                  <li key={job.id} className={`job-${job.status}`}>
                    <span className="job-status">{job.status}</span>
                    <span className="job-date">
                      {new Date(job.created_at).toLocaleDateString()}
                    </span>
                    {job.accuracy && (
                      <span className="job-accuracy">{parseFloat(job.accuracy) * 100}%</span>
                    )}
                  </li>
                ))}
                {stats.recent_jobs.length === 0 && (
                  <li className="empty">No training jobs yet</li>
                )}
              </ul>
            </div>
          </div>
        )}

        {activeTab === 'drawings' && (
          <div className="drawings-section">
            <div className="drawings-header">
              <h2>Drawings</h2>
              <button onClick={loadData} className="refresh-btn">
                Refresh
              </button>
            </div>

            <div className="drawings-filters">
              <div className="filter-group">
                <label>Shape</label>
                <select
                  value={filters.shape}
                  onChange={(e) => setFilters((f) => ({ ...f, shape: e.target.value }))}
                >
                  <option value="">All Shapes</option>
                  {stats?.drawings_per_shape.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={filters.startDate}
                  onChange={(e) => setFilters((f) => ({ ...f, startDate: e.target.value }))}
                />
              </div>

              <div className="filter-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={filters.endDate}
                  onChange={(e) => setFilters((f) => ({ ...f, endDate: e.target.value }))}
                />
              </div>

              <div className="filter-group">
                <label>
                  <input
                    type="checkbox"
                    checked={filters.includeDeleted}
                    onChange={(e) => setFilters((f) => ({ ...f, includeDeleted: e.target.checked }))}
                  />
                  {' '}Include Deleted
                </label>
              </div>

              <div className="filter-actions">
                <button className="apply-filter-btn" onClick={loadFilteredDrawings}>
                  Apply
                </button>
                <button className="clear-filter-btn" onClick={clearFilters}>
                  Clear
                </button>
              </div>
            </div>

            <div className="drawings-grid">
              {drawings.map((drawing) => (
                <DrawingCard
                  key={drawing.id}
                  id={drawing.id}
                  shape={drawing.shape}
                  createdAt={drawing.created_at}
                  isFlagged={drawing.is_flagged}
                  isDeleted={!!drawing.deleted_at}
                  onFlag={handleFlagDrawing}
                  onDelete={handleDeleteDrawing}
                  onRestore={handleRestoreDrawing}
                />
              ))}
              {drawings.length === 0 && (
                <p style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#94a3b8' }}>
                  No drawings found
                </p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'quality' && (
          <div className="quality-section">
            <div className="quality-header">
              <h2>Data Quality</h2>
              <button
                onClick={async () => {
                  try {
                    const stats = await getQualityStats()
                    setQualityStats(stats)
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to load quality stats')
                  }
                }}
                className="refresh-btn"
              >
                Refresh Stats
              </button>
            </div>

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
                      value={qualityOptions.limit}
                      onChange={(e) =>
                        setQualityOptions((o) => ({
                          ...o,
                          limit: parseInt(e.target.value) || 100,
                        }))
                      }
                      min={1}
                      max={1000}
                    />
                  </div>

                  <div className="form-group">
                    <label>Min Score (for auto-flag)</label>
                    <input
                      type="number"
                      value={qualityOptions.minScore}
                      onChange={(e) =>
                        setQualityOptions((o) => ({
                          ...o,
                          minScore: parseInt(e.target.value) || 50,
                        }))
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
                      checked={qualityOptions.updateScores}
                      onChange={(e) =>
                        setQualityOptions((o) => ({
                          ...o,
                          updateScores: e.target.checked,
                        }))
                      }
                    />
                    <span>Save scores to database (uncheck for dry run)</span>
                  </label>
                </div>

                <div className="quality-actions">
                  <button
                    className="analyze-btn"
                    onClick={async () => {
                      setAnalyzing(true)
                      setAnalysisResult(null)
                      try {
                        const result = await analyzeBatchQuality(qualityOptions)
                        setAnalysisResult(result)
                        // Also refresh quality stats
                        const stats = await getQualityStats()
                        setQualityStats(stats)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Analysis failed')
                      } finally {
                        setAnalyzing(false)
                      }
                    }}
                    disabled={analyzing}
                  >
                    {analyzing ? 'Analyzing...' : 'Run Analysis'}
                  </button>
                </div>
              </div>

              {analysisResult && (
                <div className="analysis-result">
                  <h4>Analysis Results</h4>
                  <p className="result-message">{analysisResult.message}</p>
                  <div className="result-stats">
                    <div className="result-stat">
                      <span className="label">Analyzed</span>
                      <span className="value">{analysisResult.analyzed}</span>
                    </div>
                    <div className="result-stat">
                      <span className="label">Passed</span>
                      <span className="value good">{analysisResult.passed}</span>
                    </div>
                    <div className="result-stat">
                      <span className="label">Avg Score</span>
                      <span className="value">{analysisResult.avgScore}</span>
                    </div>
                    <div className="result-stat">
                      <span className="label">Flagged</span>
                      <span className="value bad">{analysisResult.flagged}</span>
                    </div>
                    <div className="result-stat">
                      <span className="label">Errors</span>
                      <span className="value">{analysisResult.failed}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {qualityStats && (
              <div className="quality-stats-grid">
                <div className="card quality-distribution">
                  <h3>Quality Distribution</h3>
                  <div className="distribution-bars">
                    {qualityStats.distribution.map((tier) => {
                      const tierColors: Record<string, string> = {
                        high: '#22c55e',
                        medium: '#f59e0b',
                        low: '#ef4444',
                        unscored: '#94a3b8',
                      }
                      return (
                        <div key={tier.quality_tier} className="tier-bar">
                          <span className="tier-label">{tier.quality_tier}</span>
                          <div className="bar-container">
                            <div
                              className="bar-fill"
                              style={{
                                width: `${
                                  (parseInt(tier.count) /
                                    Math.max(
                                      ...qualityStats.distribution.map((t) => parseInt(t.count)),
                                      1
                                    )) *
                                  100
                                }%`,
                                backgroundColor: tierColors[tier.quality_tier] || '#94a3b8',
                              }}
                            />
                          </div>
                          <span className="tier-count">{tier.count}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>

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
                      {qualityStats.perShape.map((s) => (
                        <tr key={s.shape}>
                          <td className="shape-name">{s.shape}</td>
                          <td
                            className={
                              s.avgScore !== null
                                ? s.avgScore >= 70
                                  ? 'score-high'
                                  : s.avgScore >= 50
                                    ? 'score-medium'
                                    : 'score-low'
                                : ''
                            }
                          >
                            {s.avgScore !== null ? `${s.avgScore}` : '-'}
                          </td>
                          <td>{s.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="unscored-note">
                    {qualityStats.unscoredCount} drawings not yet scored
                  </p>
                </div>
              </div>
            )}

            {!qualityStats && (
              <div className="quality-empty card">
                <p>Click "Refresh Stats" to load quality statistics.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'training' && (
          <div className="training-section">
            <div className="training-header">
              <h2>Model Training</h2>
              <button
                className="train-btn"
                onClick={handleStartTraining}
                disabled={trainingInProgress || (stats?.total_drawings || 0) < 10}
              >
                {trainingInProgress ? 'Starting...' : 'Start Training'}
              </button>
            </div>

            {(stats?.total_drawings || 0) < 10 && (
              <div className="training-warning">
                Need at least 10 drawings to train. Current: {stats?.total_drawings || 0}
              </div>
            )}

            <div className="models-list">
              <h3>Trained Models</h3>
              {models.length === 0 ? (
                <p className="empty">No models trained yet</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Accuracy</th>
                      <th>Created</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((model) => (
                      <tr key={model.id} className={model.is_active ? 'active-model' : ''}>
                        <td>{model.version}</td>
                        <td>{(model.accuracy * 100).toFixed(1)}%</td>
                        <td>{new Date(model.created_at).toLocaleDateString()}</td>
                        <td>{model.is_active ? '✓ Active' : '-'}</td>
                        <td>
                          {!model.is_active && (
                            <button
                              className="activate-btn"
                              onClick={() => handleActivateModel(model.id)}
                            >
                              Activate
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

/**
 * StatCard component - Displays a single statistic with title and value.
 *
 * @param props - Component props
 * @param props.title - Label for the statistic
 * @param props.value - The statistic value
 * @param props.subtitle - Optional secondary text
 * @param props.color - Color theme (blue, green, red, purple)
 */
function StatCard({
  title,
  value,
  subtitle,
  color,
}: {
  title: string
  value: string | number
  subtitle?: string
  color: 'blue' | 'green' | 'red' | 'purple'
}) {
  return (
    <div className={`stat-card card ${color}`}>
      <h3>{title}</h3>
      <div className="stat-value">{value}</div>
      {subtitle && <div className="stat-subtitle">{subtitle}</div>}
    </div>
  )
}

export default AdminDashboard
