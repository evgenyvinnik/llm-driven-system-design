/**
 * API client for Scale AI backend services.
 * Provides typed functions for communicating with Collection, Admin, and Inference services.
 * Handles session management for anonymous users and admin authentication.
 * @module services/api
 */

/** Base URL for the Collection service (drawing submissions) */
const COLLECTION_API = import.meta.env.VITE_COLLECTION_API || 'http://localhost:3001'

/** Base URL for the Admin service (data management) */
const ADMIN_API = import.meta.env.VITE_ADMIN_API || 'http://localhost:3002'

/** Base URL for the Inference service (model predictions) */
const INFERENCE_API = import.meta.env.VITE_INFERENCE_API || 'http://localhost:3003'

/**
 * Gets or creates a unique session ID for anonymous users.
 * Stored in localStorage for persistence across page loads.
 *
 * @returns The user's session ID (UUID format)
 */
function getSessionId(): string {
  let sessionId = localStorage.getItem('scale-ai-session-id')
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    localStorage.setItem('scale-ai-session-id', sessionId)
  }
  return sessionId
}

// ============================================
// Collection API (Port 3001) - Drawing Game
// ============================================

/**
 * Shape definition from the backend.
 */
export interface Shape {
  id: number
  name: string
  description: string
  difficulty: number
}

/**
 * Data structure for submitting a drawing.
 */
export interface DrawingSubmission {
  shape: string
  canvas: { width: number; height: number }
  strokes: Array<{
    points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
    color: string
    width: number
  }>
  duration_ms: number
  device?: string
}

/**
 * Fetches the list of available shapes to draw.
 *
 * @returns Promise resolving to array of shape definitions
 * @throws Error if fetch fails
 */
export async function getShapes(): Promise<Shape[]> {
  const response = await fetch(`${COLLECTION_API}/api/shapes`)
  if (!response.ok) throw new Error('Failed to fetch shapes')
  return response.json()
}

/**
 * Submits a drawing to the collection service.
 * Automatically attaches the user's session ID.
 *
 * @param data - Drawing data including strokes, shape, and timing
 * @returns Promise resolving to the created drawing ID
 * @throws Error if submission fails
 */
export async function submitDrawing(data: DrawingSubmission): Promise<{ id: string }> {
  const response = await fetch(`${COLLECTION_API}/api/drawings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      sessionId: getSessionId(),
    }),
  })
  if (!response.ok) throw new Error('Failed to submit drawing')
  return response.json()
}

/**
 * Fetches the current user's drawing statistics.
 * Includes total drawings, today's count, streak days, and computed level.
 *
 * @returns Promise resolving to user statistics
 * @throws Error if fetch fails
 */
export async function getUserStats(): Promise<{
  total_drawings: number
  today_count: number
  streak_days: number
  shapes_completed: string[]
  level: number
}> {
  const response = await fetch(
    `${COLLECTION_API}/api/user/stats?sessionId=${getSessionId()}`
  )
  if (!response.ok) throw new Error('Failed to fetch user stats')
  const data = await response.json()
  // Add computed fields if not provided by backend
  return {
    total_drawings: data.total_drawings || 0,
    today_count: data.today_count || 0,
    streak_days: data.streak_days || 0,
    shapes_completed: data.shapes_completed || [],
    level: Math.floor((data.total_drawings || 0) / 10) + 1,
  }
}

// ============================================
// Admin API (Port 3002) - Data Management
// ============================================

/**
 * Admin user profile returned after authentication.
 */
export interface AdminUser {
  id: string
  email: string
  name: string | null
}

/**
 * Dashboard statistics for the admin panel.
 */
export interface AdminStats {
  total_drawings: number
  drawings_per_shape: Array<{ name: string; count: number }>
  flagged_count: number
  today_count: number
  total_users: number
  active_model: {
    id: string
    version: string
    accuracy: number
    created_at: string
  } | null
  recent_jobs: Array<{
    id: string
    status: string
    created_at: string
    completed_at: string | null
    accuracy: string | null
  }>
}

/**
 * Drawing metadata returned by the admin API.
 */
export interface Drawing {
  id: string
  stroke_data_path: string
  metadata: Record<string, unknown>
  quality_score: number | null
  is_flagged: boolean
  deleted_at: string | null
  created_at: string
  shape: string
}

/**
 * Training job status and metadata.
 */
export interface TrainingJob {
  id: string
  status: string
  config: Record<string, unknown>
  started_at: string | null
  completed_at: string | null
  accuracy: string | null
}

/**
 * Trained ML model metadata.
 */
export interface Model {
  id: string
  version: string
  is_active: boolean
  accuracy: number
  model_path: string
  created_at: string
}

/**
 * Internal fetch wrapper for admin API calls.
 * Includes credentials for session cookie auth and JSON content type.
 *
 * @param path - API path relative to admin base URL
 * @param options - Additional fetch options
 * @returns Raw fetch Response
 */
async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${ADMIN_API}${path}`, {
    ...options,
    credentials: 'include', // Include session cookies
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
    },
  })
  return response
}

/**
 * Authenticates an admin user.
 *
 * @param email - Admin email address
 * @param password - Admin password
 * @param rememberMe - Whether to extend session duration to 30 days
 * @returns Promise resolving to the authenticated user
 * @throws Error if credentials are invalid
 */
export async function adminLogin(email: string, password: string, rememberMe = false): Promise<{ user: AdminUser }> {
  const response = await adminFetch('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password, rememberMe }),
  })
  if (!response.ok) {
    const data = await response.json()
    throw new Error(data.error || 'Login failed')
  }
  return response.json()
}

/**
 * Logs out the current admin user by clearing the session.
 */
export async function adminLogout(): Promise<void> {
  await adminFetch('/api/admin/auth/logout', { method: 'POST' })
}

/**
 * Gets the currently authenticated admin user, if any.
 *
 * @returns The admin user or null if not authenticated
 */
export async function getAdminUser(): Promise<AdminUser | null> {
  const response = await adminFetch('/api/admin/auth/me')
  if (!response.ok) return null
  const data = await response.json()
  return data.user
}

/**
 * Fetches aggregated dashboard statistics.
 *
 * @returns Promise resolving to admin statistics
 */
export async function getAdminStats(): Promise<AdminStats> {
  const response = await adminFetch('/api/admin/stats')
  if (!response.ok) throw new Error('Failed to fetch admin stats')
  return response.json()
}

/**
 * Fetches drawings with pagination and optional filters.
 *
 * @param page - Page number (1-indexed)
 * @param limit - Items per page (max 100)
 * @param filters - Optional filters for shape, date range, etc.
 * @returns Promise resolving to drawings and pagination info
 */
export async function getDrawings(
  page = 1,
  limit = 20,
  filters: {
    shape?: string
    flagged?: boolean
    includeDeleted?: boolean
    startDate?: string
    endDate?: string
  } = {}
): Promise<{
  drawings: Drawing[]
  pagination: { page: number; limit: number; total: number; pages: number }
}> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  })
  if (filters.shape) params.set('shape', filters.shape)
  if (filters.flagged) params.set('flagged', 'true')
  if (filters.includeDeleted) params.set('includeDeleted', 'true')
  if (filters.startDate) params.set('startDate', filters.startDate)
  if (filters.endDate) params.set('endDate', filters.endDate)

  const response = await adminFetch(`/api/admin/drawings?${params}`)
  if (!response.ok) throw new Error('Failed to fetch drawings')
  return response.json()
}

/**
 * Flags or unflags a drawing for review.
 *
 * @param id - Drawing ID
 * @param flagged - Whether to flag (true) or unflag (false)
 */
export async function flagDrawing(id: string, flagged = true): Promise<void> {
  const response = await adminFetch(`/api/admin/drawings/${id}/flag`, {
    method: 'POST',
    body: JSON.stringify({ flagged }),
  })
  if (!response.ok) throw new Error('Failed to flag drawing')
}

/**
 * Soft-deletes a drawing (can be restored later).
 *
 * @param id - Drawing ID to delete
 */
export async function deleteDrawing(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/drawings/${id}`, {
    method: 'DELETE',
  })
  if (!response.ok) throw new Error('Failed to delete drawing')
}

/**
 * Restores a soft-deleted drawing.
 *
 * @param id - Drawing ID to restore
 */
export async function restoreDrawing(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/drawings/${id}/restore`, {
    method: 'POST',
  })
  if (!response.ok) throw new Error('Failed to restore drawing')
}

/**
 * Raw stroke data stored in MinIO.
 */
export interface StrokeData {
  id: string
  shape: string
  canvas: { width: number; height: number }
  strokes: Array<{
    points: Array<{ x: number; y: number; pressure: number; timestamp: number }>
    color: string
    width: number
  }>
  duration_ms: number
  device: string
}

/**
 * Fetches the raw stroke data for a drawing.
 *
 * @param id - Drawing ID
 * @returns Promise resolving to stroke data
 */
export async function getDrawingStrokes(id: string): Promise<StrokeData> {
  const response = await adminFetch(`/api/admin/drawings/${id}/strokes`)
  if (!response.ok) throw new Error('Failed to fetch stroke data')
  return response.json()
}

/**
 * Starts a new model training job.
 *
 * @param config - Training configuration (epochs, batch size, etc.)
 * @returns Promise resolving to job ID and initial status
 */
export async function startTraining(
  config: Record<string, unknown> = {}
): Promise<{ id: string; status: string }> {
  const response = await adminFetch('/api/admin/training/start', {
    method: 'POST',
    body: JSON.stringify({ config }),
  })
  if (!response.ok) throw new Error('Failed to start training')
  return response.json()
}

/**
 * Fetches details of a specific training job.
 *
 * @param id - Training job ID
 * @returns Promise resolving to job details including metrics
 */
export async function getTrainingJob(id: string): Promise<TrainingJob & { metrics?: Record<string, unknown> }> {
  const response = await adminFetch(`/api/admin/training/${id}`)
  if (!response.ok) throw new Error('Failed to fetch training job')
  return response.json()
}

/**
 * Fetches all training jobs.
 *
 * @returns Promise resolving to array of training jobs
 */
export async function getTrainingJobs(): Promise<TrainingJob[]> {
  const response = await adminFetch('/api/admin/training')
  if (!response.ok) throw new Error('Failed to fetch training jobs')
  return response.json()
}

/**
 * Fetches all trained models.
 *
 * @returns Promise resolving to array of models
 */
export async function getModels(): Promise<Model[]> {
  const response = await adminFetch('/api/admin/models')
  if (!response.ok) throw new Error('Failed to fetch models')
  return response.json()
}

/**
 * Activates a model for use in inference.
 * Deactivates any previously active model.
 *
 * @param id - Model ID to activate
 */
export async function activateModel(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/models/${id}/activate`, {
    method: 'POST',
  })
  if (!response.ok) throw new Error('Failed to activate model')
}

// ============================================
// Quality Analysis API
// ============================================

/**
 * Individual quality check result.
 */
export interface QualityCheck {
  name: string
  score: number
  message: string
}

/**
 * Complete quality analysis result.
 */
export interface QualityResult {
  score: number
  passed: boolean
  checks: QualityCheck[]
  recommendation: string
  metrics: {
    strokeCount: number
    totalPoints: number
    durationMs: number
    bboxWidth: number
    bboxHeight: number
    totalInk: number
  }
}

/**
 * Quality statistics across all drawings.
 */
export interface QualityStats {
  distribution: Array<{ quality_tier: string; count: string }>
  perShape: Array<{ shape: string; avgScore: number | null; count: number }>
  unscoredCount: number
}

/**
 * Result of batch quality analysis.
 */
export interface BatchAnalysisResult {
  analyzed: number
  failed: number
  passed: number
  avgScore: number
  flagged: number
  results: Array<{
    id: string
    shape: string
    score: number
    passed: boolean
    recommendation: string
  }>
  errors: Array<{ id: string; error: string }>
  message: string
}

/**
 * Gets quality analysis for a single drawing.
 *
 * @param id - Drawing ID
 * @returns Promise resolving to quality analysis result
 */
export async function getDrawingQuality(id: string): Promise<{ drawingId: string; quality: QualityResult }> {
  const response = await adminFetch(`/api/admin/drawings/${id}/quality`)
  if (!response.ok) throw new Error('Failed to get drawing quality')
  return response.json()
}

/**
 * Gets overall quality statistics.
 *
 * @returns Promise resolving to quality stats
 */
export async function getQualityStats(): Promise<QualityStats> {
  const response = await adminFetch('/api/admin/quality/stats')
  if (!response.ok) throw new Error('Failed to fetch quality stats')
  return response.json()
}

/**
 * Runs batch quality analysis on unscored drawings.
 *
 * @param options.limit - Max drawings to analyze
 * @param options.minScore - Score threshold for auto-flagging
 * @param options.updateScores - Whether to save scores (false for dry run)
 * @returns Promise resolving to batch analysis results
 */
export async function analyzeBatchQuality(options: {
  limit?: number
  minScore?: number
  updateScores?: boolean
}): Promise<BatchAnalysisResult> {
  const response = await adminFetch('/api/admin/quality/analyze-batch', {
    method: 'POST',
    body: JSON.stringify(options),
  })
  if (!response.ok) throw new Error('Failed to analyze batch')
  return response.json()
}

// ============================================
// Inference API (Port 3003) - Model Predictions
// ============================================

/**
 * Information about the active ML model.
 */
export interface ModelInfo {
  id: string
  version: string
  accuracy: number
  created_at: string
  class_names: string[]
}

/**
 * Result from classifying a drawing.
 */
export interface ClassificationResult {
  prediction: string
  confidence: number
  all_probabilities: Array<{ class: string; probability: number }>
  class_names: string[]
  model_version: string
  inference_time_ms: number
}

/**
 * Fetches information about the currently active model.
 *
 * @returns Promise resolving to model info
 * @throws Error if no model is active
 */
export async function getModelInfo(): Promise<ModelInfo> {
  const response = await fetch(`${INFERENCE_API}/api/inference/model/info`)
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('No active model. Train and activate a model first.')
    }
    throw new Error('Failed to fetch model info')
  }
  return response.json()
}

/**
 * Classifies a drawing using the active ML model.
 *
 * @param strokes - Array of strokes from the drawing
 * @param canvas - Canvas dimensions
 * @returns Promise resolving to classification result with predictions
 * @throws Error if no model is active or classification fails
 */
export async function classifyDrawing(
  strokes: DrawingSubmission['strokes'],
  canvas: DrawingSubmission['canvas']
): Promise<ClassificationResult> {
  const response = await fetch(`${INFERENCE_API}/api/inference/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strokes, canvas }),
  })
  if (!response.ok) {
    if (response.status === 503) {
      throw new Error('No active model. Train and activate a model first.')
    }
    throw new Error('Failed to classify drawing')
  }
  return response.json()
}
