/**
 * API client for Scale AI backend services
 */

const COLLECTION_API = import.meta.env.VITE_COLLECTION_API || 'http://localhost:3001'
const ADMIN_API = import.meta.env.VITE_ADMIN_API || 'http://localhost:3002'
const INFERENCE_API = import.meta.env.VITE_INFERENCE_API || 'http://localhost:3003'

// Admin token for development
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN || 'admin-secret-token'

// Session ID management
function getSessionId(): string {
  let sessionId = localStorage.getItem('scale-ai-session-id')
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    localStorage.setItem('scale-ai-session-id', sessionId)
  }
  return sessionId
}

// ============================================
// Collection API (Port 3001)
// ============================================

export interface Shape {
  id: number
  name: string
  description: string
  difficulty: number
}

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

export async function getShapes(): Promise<Shape[]> {
  const response = await fetch(`${COLLECTION_API}/api/shapes`)
  if (!response.ok) throw new Error('Failed to fetch shapes')
  return response.json()
}

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
// Admin API (Port 3002)
// ============================================

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

export interface Drawing {
  id: string
  stroke_data_path: string
  metadata: Record<string, unknown>
  quality_score: number | null
  is_flagged: boolean
  created_at: string
  shape: string
}

export interface TrainingJob {
  id: string
  status: string
  config: Record<string, unknown>
  started_at: string | null
  completed_at: string | null
  accuracy: string | null
}

export interface Model {
  id: string
  version: string
  is_active: boolean
  accuracy: number
  model_path: string
  created_at: string
}

async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${ADMIN_API}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })
  return response
}

export async function getAdminStats(): Promise<AdminStats> {
  const response = await adminFetch('/api/admin/stats')
  if (!response.ok) throw new Error('Failed to fetch admin stats')
  return response.json()
}

export async function getDrawings(
  page = 1,
  limit = 20,
  filters: { shape?: string; flagged?: boolean } = {}
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

  const response = await adminFetch(`/api/admin/drawings?${params}`)
  if (!response.ok) throw new Error('Failed to fetch drawings')
  return response.json()
}

export async function flagDrawing(id: string, flagged = true): Promise<void> {
  const response = await adminFetch(`/api/admin/drawings/${id}/flag`, {
    method: 'POST',
    body: JSON.stringify({ flagged }),
  })
  if (!response.ok) throw new Error('Failed to flag drawing')
}

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

export async function getDrawingStrokes(id: string): Promise<StrokeData> {
  const response = await adminFetch(`/api/admin/drawings/${id}/strokes`)
  if (!response.ok) throw new Error('Failed to fetch stroke data')
  return response.json()
}

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

export async function getTrainingJob(id: string): Promise<TrainingJob & { metrics?: Record<string, unknown> }> {
  const response = await adminFetch(`/api/admin/training/${id}`)
  if (!response.ok) throw new Error('Failed to fetch training job')
  return response.json()
}

export async function getTrainingJobs(): Promise<TrainingJob[]> {
  const response = await adminFetch('/api/admin/training')
  if (!response.ok) throw new Error('Failed to fetch training jobs')
  return response.json()
}

export async function getModels(): Promise<Model[]> {
  const response = await adminFetch('/api/admin/models')
  if (!response.ok) throw new Error('Failed to fetch models')
  return response.json()
}

export async function activateModel(id: string): Promise<void> {
  const response = await adminFetch(`/api/admin/models/${id}/activate`, {
    method: 'POST',
  })
  if (!response.ok) throw new Error('Failed to activate model')
}

// ============================================
// Inference API (Port 3003)
// ============================================

export interface ModelInfo {
  id: string
  version: string
  accuracy: number
  created_at: string
  class_names: string[]
}

export interface ClassificationResult {
  prediction: string
  confidence: number
  all_probabilities: Array<{ class: string; probability: number }>
  class_names: string[]
  model_version: string
  inference_time_ms: number
}

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
