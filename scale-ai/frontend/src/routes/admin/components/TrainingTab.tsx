/**
 * TrainingTab component - Model training and activation interface.
 * Allows admins to start training jobs and manage trained models.
 * Displays training job status with auto-refresh and trained models list.
 * @module routes/admin/components/TrainingTab
 */

import { useState, useEffect, useCallback } from 'react'
import { getTrainingJobs, type Model, type TrainingJob } from '../../../services/api'

/**
 * Props for the TrainingTab component.
 */
interface TrainingTabProps {
  /** Array of trained models */
  models: Model[]
  /** Total number of drawings available for training */
  totalDrawings: number
  /** Whether a training job is currently being started */
  trainingInProgress: boolean
  /** Callback to start a new training job */
  onStartTraining: () => void
  /** Callback to activate a specific model */
  onActivateModel: (modelId: string) => void
  /** Callback to refresh data after job completes */
  onRefresh?: () => void
}

/** Minimum number of drawings required to start training */
const MIN_DRAWINGS_FOR_TRAINING = 10

/** Auto-refresh interval for active jobs (in milliseconds) */
const REFRESH_INTERVAL = 3000

/**
 * Training management tab for the admin dashboard.
 * Provides controls to start training and manage trained models.
 * Shows training job status with auto-refresh for active jobs.
 *
 * @param props - Component props
 */
export function TrainingTab({
  models,
  totalDrawings,
  trainingInProgress,
  onStartTraining,
  onActivateModel,
  onRefresh,
}: TrainingTabProps) {
  const [jobs, setJobs] = useState<TrainingJob[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState<string | null>(null)

  const canTrain = totalDrawings >= MIN_DRAWINGS_FOR_TRAINING

  /**
   * Fetches training jobs from the API.
   */
  const loadJobs = useCallback(async () => {
    try {
      const jobsData = await getTrainingJobs()
      setJobs(jobsData)
      setJobsError(null)
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setJobsLoading(false)
    }
  }, [])

  // Load jobs on mount
  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  // Check if there are any active jobs (pending, queued, or running)
  const hasActiveJobs = jobs.some((job) =>
    ['pending', 'queued', 'running'].includes(job.status)
  )

  // Auto-refresh while jobs are active
  useEffect(() => {
    if (!hasActiveJobs) return

    const interval = setInterval(() => {
      loadJobs()
      // Also refresh parent data to get new models when job completes
      onRefresh?.()
    }, REFRESH_INTERVAL)

    return () => clearInterval(interval)
  }, [hasActiveJobs, loadJobs, onRefresh])

  // Refresh jobs when training is started
  useEffect(() => {
    if (!trainingInProgress) {
      // Small delay to ensure job is created
      setTimeout(loadJobs, 500)
    }
  }, [trainingInProgress, loadJobs])

  return (
    <div className="training-section">
      <div className="training-header">
        <h2>Model Training</h2>
        <button
          className="train-btn"
          onClick={onStartTraining}
          disabled={trainingInProgress || !canTrain || hasActiveJobs}
        >
          {trainingInProgress
            ? 'Starting...'
            : hasActiveJobs
              ? 'Training in Progress...'
              : 'Start Training'}
        </button>
      </div>

      {!canTrain && (
        <TrainingWarning
          currentCount={totalDrawings}
          requiredCount={MIN_DRAWINGS_FOR_TRAINING}
        />
      )}

      <JobsSection jobs={jobs} loading={jobsLoading} error={jobsError} />

      <ModelsTable models={models} onActivate={onActivateModel} />
    </div>
  )
}

/**
 * Props for the JobsSection component.
 */
interface JobsSectionProps {
  /** Array of training jobs */
  jobs: TrainingJob[]
  /** Whether jobs are loading */
  loading: boolean
  /** Error message if loading failed */
  error: string | null
}

/**
 * Section displaying training jobs with their status.
 *
 * @param props - Component props
 */
function JobsSection({ jobs, loading, error }: JobsSectionProps) {
  if (loading) {
    return (
      <div className="jobs-section">
        <h3>Training Jobs</h3>
        <p className="loading-text">Loading jobs...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="jobs-section">
        <h3>Training Jobs</h3>
        <p className="error-text">{error}</p>
      </div>
    )
  }

  return (
    <div className="jobs-section">
      <h3>Training Jobs</h3>
      {jobs.length === 0 ? (
        <p className="empty">No training jobs yet. Click "Start Training" to begin.</p>
      ) : (
        <div className="jobs-list">
          {jobs.slice(0, 10).map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Props for the JobCard component.
 */
interface JobCardProps {
  /** The training job to display */
  job: TrainingJob
}

/**
 * Card displaying a single training job with status.
 *
 * @param props - Component props
 */
function JobCard({ job }: JobCardProps) {
  const statusInfo = getStatusInfo(job.status)

  return (
    <div className={`job-card status-${job.status}`}>
      <div className="job-header">
        <span className={`job-status ${job.status}`}>
          {statusInfo.icon} {statusInfo.label}
        </span>
        <span className="job-date">{formatDate(job.created_at)}</span>
      </div>

      <div className="job-details">
        {job.status === 'running' && (
          <div className="job-progress">
            <div className="progress-bar">
              <div className="progress-fill running" />
            </div>
            <span className="progress-text">Training in progress...</span>
          </div>
        )}

        {job.status === 'completed' && job.accuracy && (
          <div className="job-result">
            <span className="result-label">Accuracy:</span>
            <span className="result-value">{formatAccuracy(job.accuracy)}</span>
          </div>
        )}

        {job.status === 'failed' && (
          <div className="job-error">
            <span className="error-label">Error:</span>
            <span className="error-message">Training failed. Check worker logs.</span>
          </div>
        )}

        {(job.status === 'pending' || job.status === 'queued') && (
          <div className="job-waiting">
            <span className="waiting-text">Waiting for worker to pick up job...</span>
          </div>
        )}
      </div>

      {job.completed_at && (
        <div className="job-footer">
          <span className="job-completed">
            Completed: {formatDate(job.completed_at)}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Returns status display info (icon and label) for a job status.
 *
 * @param status - Job status string
 */
function getStatusInfo(status: string): { icon: string; label: string } {
  switch (status) {
    case 'pending':
      return { icon: '⏳', label: 'Pending' }
    case 'queued':
      return { icon: '📥', label: 'Queued' }
    case 'running':
      return { icon: '⚙️', label: 'Running' }
    case 'completed':
      return { icon: '✓', label: 'Completed' }
    case 'failed':
      return { icon: '✗', label: 'Failed' }
    default:
      return { icon: '?', label: status }
  }
}

/**
 * Formats accuracy value (handles string or number).
 *
 * @param accuracy - Accuracy value
 */
function formatAccuracy(accuracy: string | null): string {
  if (!accuracy) return 'N/A'
  const num = parseFloat(accuracy)
  if (isNaN(num)) return accuracy
  return `${(num * 100).toFixed(1)}%`
}

/**
 * Formats date as localized string.
 *
 * @param dateString - ISO date string
 */
function formatDate(dateString: string | null): string {
  if (!dateString) return ''
  return new Date(dateString).toLocaleString()
}

/**
 * Props for the TrainingWarning component.
 */
interface TrainingWarningProps {
  /** Current number of drawings */
  currentCount: number
  /** Required number of drawings for training */
  requiredCount: number
}

/**
 * Warning message displayed when there are not enough drawings to train.
 *
 * @param props - Component props
 */
function TrainingWarning({ currentCount, requiredCount }: TrainingWarningProps) {
  return (
    <div className="training-warning">
      Need at least {requiredCount} drawings to train. Current: {currentCount}
    </div>
  )
}

/**
 * Props for the ModelsTable component.
 */
interface ModelsTableProps {
  /** Array of trained models */
  models: Model[]
  /** Callback to activate a model */
  onActivate: (modelId: string) => void
}

/**
 * Table displaying all trained models with their metrics and actions.
 * Shows version, accuracy, creation date, active status, and activate button.
 *
 * @param props - Component props
 */
function ModelsTable({ models, onActivate }: ModelsTableProps) {
  return (
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
              <ModelRow key={model.id} model={model} onActivate={onActivate} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * Props for the ModelRow component.
 */
interface ModelRowProps {
  /** The model to display */
  model: Model
  /** Callback to activate this model */
  onActivate: (modelId: string) => void
}

/**
 * A single row in the models table.
 * Shows model details and an activate button for inactive models.
 *
 * @param props - Component props
 */
function ModelRow({ model, onActivate }: ModelRowProps) {
  return (
    <tr className={model.is_active ? 'active-model' : ''}>
      <td>{model.version}</td>
      <td>{(model.accuracy * 100).toFixed(1)}%</td>
      <td>{new Date(model.created_at).toLocaleDateString()}</td>
      <td>{model.is_active ? 'Active' : '-'}</td>
      <td>
        {!model.is_active && (
          <button className="activate-btn" onClick={() => onActivate(model.id)}>
            Activate
          </button>
        )}
      </td>
    </tr>
  )
}
