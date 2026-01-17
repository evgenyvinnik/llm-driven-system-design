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
  adminLogout,
  getAdminUser,
  type AdminStats,
  type Drawing,
  type Model,
  type AdminUser,
} from '../../services/api'
import {
  AdminLogin,
  OverviewTab,
  DrawingsTab,
  QualityTab,
  TrainingTab,
} from './components'
import './AdminDashboard.css'

/**
 * Tab identifiers for the admin dashboard navigation.
 */
type TabId = 'overview' | 'drawings' | 'quality' | 'training'

/**
 * Navigation tabs configuration.
 */
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'drawings', label: 'Drawings' },
  { id: 'quality', label: 'Quality' },
  { id: 'training', label: 'Training' },
]

/**
 * Main admin dashboard component.
 * Manages authentication state and provides tabbed interface for data management.
 * Handles all API interactions and passes data to child components.
 */
export function AdminDashboard() {
  // Authentication state
  const [user, setUser] = useState<AdminUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  // Data state
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [models, setModels] = useState<Model[]>([])

  // UI state
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [trainingInProgress, setTrainingInProgress] = useState(false)

  /**
   * Check if user is already logged in on component mount.
   */
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
   * Called after login and when refresh is requested.
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

  /**
   * Load data when user logs in.
   */
  useEffect(() => {
    if (user) {
      loadData()
    }
  }, [user, loadData])

  /**
   * Logs out the current admin user.
   */
  const handleLogout = async () => {
    await adminLogout()
    setUser(null)
  }

  /**
   * Starts a new training job.
   * Refreshes data after a short delay to show the new job.
   */
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

  /**
   * Activates a trained model for inference.
   *
   * @param modelId - The model ID to activate
   */
  const handleActivateModel = async (modelId: string) => {
    try {
      await activateModel(modelId)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate model')
    }
  }

  /**
   * Flags or unflags a drawing.
   * Updates local state optimistically.
   *
   * @param drawingId - The drawing ID to flag
   * @param flagged - Whether to flag or unflag
   */
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

  /**
   * Soft-deletes a drawing.
   * Updates local state optimistically.
   *
   * @param drawingId - The drawing ID to delete
   */
  const handleDeleteDrawing = async (drawingId: string) => {
    try {
      await deleteDrawing(drawingId)
      setDrawings((prev) =>
        prev.map((d) =>
          d.id === drawingId ? { ...d, deleted_at: new Date().toISOString() } : d
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete drawing')
    }
  }

  /**
   * Restores a soft-deleted drawing.
   * Updates local state optimistically.
   *
   * @param drawingId - The drawing ID to restore
   */
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

  /**
   * Sets an error message to display.
   *
   * @param message - The error message
   */
  const handleError = (message: string) => {
    setError(message)
  }

  // Show loading while checking auth
  if (!authChecked) {
    return <LoadingState message="Checking authentication..." />
  }

  // Show login page if not authenticated
  if (!user) {
    return <AdminLogin onLogin={setUser} />
  }

  if (loading) {
    return <LoadingState message="Loading dashboard..." />
  }

  if (error) {
    return <ErrorState error={error} onRetry={loadData} />
  }

  return (
    <div className="admin-dashboard">
      <DashboardHeader user={user} onLogout={handleLogout} />

      <DashboardNav
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <main className="admin-content">
        {activeTab === 'overview' && stats && <OverviewTab stats={stats} />}

        {activeTab === 'drawings' && (
          <DrawingsTab
            drawings={drawings}
            shapeOptions={stats?.drawings_per_shape || []}
            onRefresh={loadData}
            onDrawingsUpdate={setDrawings}
            onFlagDrawing={handleFlagDrawing}
            onDeleteDrawing={handleDeleteDrawing}
            onRestoreDrawing={handleRestoreDrawing}
          />
        )}

        {activeTab === 'quality' && <QualityTab onError={handleError} />}

        {activeTab === 'training' && (
          <TrainingTab
            models={models}
            totalDrawings={stats?.total_drawings || 0}
            trainingInProgress={trainingInProgress}
            onStartTraining={handleStartTraining}
            onActivateModel={handleActivateModel}
          />
        )}
      </main>
    </div>
  )
}

/**
 * Props for the LoadingState component.
 */
interface LoadingStateProps {
  /** Message to display while loading */
  message: string
}

/**
 * Loading spinner with message.
 *
 * @param props - Component props
 */
function LoadingState({ message }: LoadingStateProps) {
  return (
    <div className="admin-loading">
      <div className="spinner" />
      <p>{message}</p>
    </div>
  )
}

/**
 * Props for the ErrorState component.
 */
interface ErrorStateProps {
  /** Error message to display */
  error: string
  /** Callback to retry the failed operation */
  onRetry: () => void
}

/**
 * Error display with retry button.
 *
 * @param props - Component props
 */
function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <div className="admin-error">
      <h2>Error</h2>
      <p>{error}</p>
      <button onClick={onRetry}>Retry</button>
    </div>
  )
}

/**
 * Props for the DashboardHeader component.
 */
interface DashboardHeaderProps {
  /** Currently logged in user */
  user: AdminUser
  /** Callback for logout action */
  onLogout: () => void
}

/**
 * Dashboard header with title and user menu.
 *
 * @param props - Component props
 */
function DashboardHeader({ user, onLogout }: DashboardHeaderProps) {
  return (
    <header className="admin-header">
      <h1>Admin Dashboard</h1>
      <div className="user-menu">
        <span className="user-email">{user.email}</span>
        <button className="logout-btn" onClick={onLogout}>
          Logout
        </button>
      </div>
    </header>
  )
}

/**
 * Props for the DashboardNav component.
 */
interface DashboardNavProps {
  /** Array of tab configurations */
  tabs: Array<{ id: TabId; label: string }>
  /** Currently active tab */
  activeTab: TabId
  /** Callback when tab changes */
  onTabChange: (tab: TabId) => void
}

/**
 * Tab navigation for the dashboard.
 *
 * @param props - Component props
 */
function DashboardNav({ tabs, activeTab, onTabChange }: DashboardNavProps) {
  return (
    <nav
      className="admin-nav"
      style={{
        padding: '0 2rem',
        background: 'white',
        borderBottom: '1px solid #e2e8f0',
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}

export default AdminDashboard
