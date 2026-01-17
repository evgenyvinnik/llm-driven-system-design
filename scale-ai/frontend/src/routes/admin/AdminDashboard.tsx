import { useState, useEffect, useCallback } from 'react'
import {
  getAdminStats,
  getDrawings,
  startTraining,
  getModels,
  activateModel,
  flagDrawing,
  adminLogin,
  adminLogout,
  getAdminUser,
  type AdminStats,
  type Drawing,
  type Model,
  type AdminUser,
} from '../../services/api'
import { DrawingCard } from '../../components/DrawingCard'
import './AdminDashboard.css'

// Login Component
function AdminLogin({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const { user } = await adminLogin(email, password)
      onLogin(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-login">
      <div className="login-card">
        <h1>Admin Dashboard</h1>
        <p className="subtitle">Sign in to manage your data</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@scaleai.local"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />
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

export function AdminDashboard() {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'drawings' | 'training'>('overview')
  const [trainingInProgress, setTrainingInProgress] = useState(false)

  // Check if user is already logged in
  useEffect(() => {
    getAdminUser()
      .then((u) => {
        setUser(u)
        setAuthChecked(true)
      })
      .catch(() => setAuthChecked(true))
  }, [])

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

  const handleLogout = async () => {
    await adminLogout()
    setUser(null)
  }

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

  const handleActivateModel = async (modelId: string) => {
    try {
      await activateModel(modelId)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate model')
    }
  }

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
              <h2>Recent Drawings</h2>
              <button onClick={loadData} className="refresh-btn">
                Refresh
              </button>
            </div>
            <div className="drawings-grid">
              {drawings.map((drawing) => (
                <DrawingCard
                  key={drawing.id}
                  id={drawing.id}
                  shape={drawing.shape}
                  createdAt={drawing.created_at}
                  isFlagged={drawing.is_flagged}
                  onFlag={handleFlagDrawing}
                />
              ))}
            </div>
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
