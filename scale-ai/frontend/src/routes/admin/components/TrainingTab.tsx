/**
 * TrainingTab component - Model training and activation interface.
 * Allows admins to start training jobs and manage trained models.
 * Displays a list of trained models with version, accuracy, and status.
 * @module routes/admin/components/TrainingTab
 */

import { type Model } from '../../../services/api'

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
}

/** Minimum number of drawings required to start training */
const MIN_DRAWINGS_FOR_TRAINING = 10

/**
 * Training management tab for the admin dashboard.
 * Provides controls to start training and manage trained models.
 * Shows a warning if there are not enough drawings for training.
 *
 * @param props - Component props
 */
export function TrainingTab({
  models,
  totalDrawings,
  trainingInProgress,
  onStartTraining,
  onActivateModel,
}: TrainingTabProps) {
  const canTrain = totalDrawings >= MIN_DRAWINGS_FOR_TRAINING

  return (
    <div className="training-section">
      <div className="training-header">
        <h2>Model Training</h2>
        <button
          className="train-btn"
          onClick={onStartTraining}
          disabled={trainingInProgress || !canTrain}
        >
          {trainingInProgress ? 'Starting...' : 'Start Training'}
        </button>
      </div>

      {!canTrain && (
        <TrainingWarning
          currentCount={totalDrawings}
          requiredCount={MIN_DRAWINGS_FOR_TRAINING}
        />
      )}

      <ModelsTable models={models} onActivate={onActivateModel} />
    </div>
  )
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
              <ModelRow
                key={model.id}
                model={model}
                onActivate={onActivate}
              />
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
  /**
   * Formats accuracy as a percentage string.
   *
   * @param accuracy - Accuracy value between 0 and 1
   */
  const formatAccuracy = (accuracy: number): string => {
    return `${(accuracy * 100).toFixed(1)}%`
  }

  /**
   * Formats date as a localized date string.
   *
   * @param dateString - ISO date string
   */
  const formatDate = (dateString: string): string => {
    return new Date(dateString).toLocaleDateString()
  }

  return (
    <tr className={model.is_active ? 'active-model' : ''}>
      <td>{model.version}</td>
      <td>{formatAccuracy(model.accuracy)}</td>
      <td>{formatDate(model.created_at)}</td>
      <td>{model.is_active ? 'Active' : '-'}</td>
      <td>
        {!model.is_active && (
          <button
            className="activate-btn"
            onClick={() => onActivate(model.id)}
          >
            Activate
          </button>
        )}
      </td>
    </tr>
  )
}
