# Scale AI - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a crowdsourced data labeling platform similar to Scale AI. The system enables users to contribute training data through a drawing game, administrators to manage datasets and trigger model training, and implementors to test trained models for shape recognition.

---

## Requirements Clarification (3 minutes)

### End-to-End Flows
1. **Drawing Collection Flow**: User draws shape on canvas, stroke data submitted to backend, stored in MinIO with metadata in PostgreSQL
2. **Training Flow**: Admin triggers training, job queued in RabbitMQ, worker processes drawings and saves model
3. **Inference Flow**: Implementor submits test drawing, inference service classifies using active model

### Integration Requirements
- Seamless handoff between canvas drawing and backend storage
- Real-time feedback on submission success/failure
- Session management for anonymous users
- Admin authentication with protected API routes
- Model hot-reloading without service restart

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React + Canvas)                          │
├────────────────────┬────────────────────────┬───────────────────────────────┤
│   Drawing Game     │    Admin Dashboard     │      Implementor Portal       │
│   (PostItCanvas)   │    (Session Auth)      │      (Model Testing)          │
└─────────┬──────────┴───────────┬────────────┴──────────────┬────────────────┘
          │                      │                            │
          │ POST /api/drawings   │ Session Cookie             │ POST /api/inference
          │ X-Idempotency-Key    │ Admin APIs                 │
          ▼                      ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API LAYER                                       │
├─────────────────────┬────────────────────────┬──────────────────────────────┤
│  Collection Service │     Admin Service      │      Inference Service       │
│     (Port 3001)     │     (Port 3002)        │        (Port 3003)           │
│                     │                         │                              │
│ - Idempotency MW    │ - Session Auth         │ - Model Loader               │
│ - Circuit Breakers  │ - Training Job Queue   │ - Stroke-to-Image            │
│ - Retry Logic       │ - Drawing Management   │ - Prediction API             │
└─────────┬───────────┴──────────┬─────────────┴──────────────┬───────────────┘
          │                      │                             │
          │                      │ RabbitMQ                    │
          │                      ▼                             │
          │           ┌──────────────────┐                     │
          │           │  Training Worker │                     │
          │           │    (Python)      │                     │
          │           └────────┬─────────┘                     │
          │                    │                               │
          ▼                    ▼                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DATA LAYER                                        │
├─────────────────────┬────────────────────────┬──────────────────────────────┤
│     PostgreSQL      │        MinIO           │          Redis               │
│   (Metadata)        │   (Stroke Data +       │    (Sessions + Cache)        │
│                     │    Trained Models)     │                              │
└─────────────────────┴────────────────────────┴──────────────────────────────┘
```

---

## Deep Dive 1: Drawing Submission Flow (10 minutes)

### End-to-End Sequence

```
┌─────────┐        ┌──────────────┐        ┌───────────────────┐
│ Canvas  │        │  Collection  │        │    PostgreSQL     │
│ (React) │        │   Service    │        │ + MinIO + Redis   │
└────┬────┘        └──────┬───────┘        └─────────┬─────────┘
     │                     │                          │
     │ User draws shape    │                          │
     │ (capture strokes)   │                          │
     │                     │                          │
     │ POST /api/drawings  │                          │
     │ X-Idempotency-Key   │                          │
     │ {strokeData}        │                          │
     │────────────────────>│                          │
     │                     │                          │
     │                     │ Check idempotency (Redis)│
     │                     │─────────────────────────>│
     │                     │                          │
     │                     │ If duplicate, return     │
     │                     │<─────────────────────────│
     │                     │                          │
     │                     │ Upload strokes (MinIO)   │
     │                     │─────────────────────────>│
     │                     │                          │
     │                     │ Insert metadata (PG)     │
     │                     │─────────────────────────>│
     │                     │                          │
     │                     │ Mark processed (Redis)   │
     │                     │─────────────────────────>│
     │                     │                          │
     │ 201 Created         │                          │
     │ {drawingId, next}   │                          │
     │<────────────────────│                          │
     │                     │                          │
     │ Show success +      │                          │
     │ next shape prompt   │                          │
     └─────────────────────┴──────────────────────────┘
```

### Frontend: Stroke Capture and Submission

```typescript
// hooks/useDrawingSubmit.ts
interface SubmissionState {
  status: 'idle' | 'submitting' | 'success' | 'error';
  drawingId?: string;
  nextShape?: Shape;
  error?: string;
}

function useDrawingSubmit() {
  const [state, setState] = useState<SubmissionState>({ status: 'idle' });
  const sessionId = useSessionId(); // From localStorage or generated

  const submit = useCallback(async (
    shapeId: number,
    strokeData: StrokeData
  ) => {
    setState({ status: 'submitting' });

    // Generate client-side idempotency key
    const idempotencyKey = `${sessionId}:${shapeId}:${Date.now()}`;

    try {
      const response = await fetch('/api/drawings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
          'X-Session-Id': sessionId,
        },
        body: JSON.stringify({
          shapeId,
          strokeData: {
            canvas: strokeData.canvas,
            strokes: strokeData.strokes,
            duration_ms: strokeData.duration,
            device: strokeData.device,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Submission failed');
      }

      const result = await response.json();
      setState({
        status: 'success',
        drawingId: result.id,
        nextShape: result.nextShape,
      });

      return result;
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      throw err;
    }
  }, [sessionId]);

  const reset = useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { ...state, submit, reset };
}
```

### Backend: Idempotency Middleware

```typescript
// shared/idempotency.ts
import { Request, Response, NextFunction } from 'express';
import { redis } from './cache.js';
import { logger } from './logger.js';

interface IdempotencyConfig {
  keyPrefix: string;
  ttlSeconds: number;
}

export function idempotencyMiddleware(config: IdempotencyConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers['x-idempotency-key'] as string;

    if (!idempotencyKey) {
      // Allow requests without idempotency key (backwards compatibility)
      return next();
    }

    const cacheKey = `idem:${config.keyPrefix}:${idempotencyKey}`;

    try {
      // Check if already processed
      const cached = await redis.get(cacheKey);
      if (cached) {
        const response = JSON.parse(cached);
        logger.info({
          idempotencyKey,
          msg: 'Returning cached response for idempotent request'
        });
        return res.status(response.status).json(response.body);
      }

      // Mark as in-progress to prevent race conditions
      const acquired = await redis.set(
        cacheKey,
        JSON.stringify({ status: 'processing' }),
        'EX',
        config.ttlSeconds,
        'NX'
      );

      if (!acquired) {
        // Another request is processing this key
        return res.status(409).json({
          error: 'Request already being processed'
        });
      }

      // Capture response to cache it
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        // Cache the successful response
        redis.setex(
          cacheKey,
          config.ttlSeconds,
          JSON.stringify({ status: res.statusCode, body })
        ).catch(err => {
          logger.error({ err, msg: 'Failed to cache idempotent response' });
        });
        return originalJson(body);
      };

      next();
    } catch (err) {
      logger.error({ err, msg: 'Idempotency check failed' });
      next(); // Continue without idempotency on cache failure
    }
  };
}
```

### API Contract: Drawing Submission

```typescript
// Request
POST /api/drawings
Headers:
  Content-Type: application/json
  X-Idempotency-Key: <session-id>:<shape-id>:<timestamp>
  X-Session-Id: <uuid>

Body:
{
  "shapeId": 2,
  "strokeData": {
    "canvas": { "width": 400, "height": 400 },
    "strokes": [
      {
        "points": [
          { "x": 100, "y": 100, "pressure": 0.5, "timestamp": 1704067200000 },
          { "x": 150, "y": 120, "pressure": 0.6, "timestamp": 1704067200016 }
        ],
        "color": "#1e1e1e",
        "width": 3
      }
    ],
    "duration_ms": 2500,
    "device": "mouse"
  }
}

// Response - Success
201 Created
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "shape": "circle",
  "qualityScore": 0.85,
  "nextShape": {
    "id": 3,
    "name": "triangle",
    "description": "A shape with 3 sides"
  },
  "userStats": {
    "totalDrawings": 15,
    "sessionDrawings": 5
  }
}

// Response - Already Processed (Idempotent)
201 Created
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Drawing already submitted"
}

// Response - Validation Error
400 Bad Request
{
  "error": "Invalid stroke data",
  "details": [
    { "field": "strokes", "message": "At least one stroke required" }
  ]
}

// Response - Service Unavailable
503 Service Unavailable
Headers:
  Retry-After: 30
{
  "error": "Storage service temporarily unavailable",
  "retryAfter": 30
}
```

---

## Deep Dive 2: Admin Authentication and Training Flow (10 minutes)

### Session Management Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        Admin Authentication Flow                           │
└───────────────────────────────────────────────────────────────────────────┘

  ┌─────────────┐        ┌───────────────┐        ┌─────────────────────────┐
  │ Admin Login │        │ Admin Service │        │ Redis (Sessions) + PG   │
  │  (React)    │        │  (Express)    │        │   (Admin Users)         │
  └──────┬──────┘        └───────┬───────┘        └───────────┬─────────────┘
         │                       │                            │
         │ POST /api/admin/login │                            │
         │ {email, password}     │                            │
         │──────────────────────>│                            │
         │                       │                            │
         │                       │ Lookup admin by email      │
         │                       │───────────────────────────>│ (PostgreSQL)
         │                       │                            │
         │                       │ Verify bcrypt hash         │
         │                       │                            │
         │                       │ Create session in Redis    │
         │                       │───────────────────────────>│ (Redis)
         │                       │ Key: session:<uuid>        │
         │                       │ TTL: 24 hours              │
         │                       │                            │
         │ 200 OK                │                            │
         │ Set-Cookie: sid=<uuid>│                            │
         │ {admin: {name, email}}│                            │
         │<──────────────────────│                            │
         │                       │                            │
         │                       │                            │
         │ Subsequent requests   │                            │
         │ Cookie: sid=<uuid>    │                            │
         │──────────────────────>│                            │
         │                       │                            │
         │                       │ Validate session           │
         │                       │───────────────────────────>│ (Redis)
         │                       │                            │
         │                       │ Attach admin to req        │
         │                       │                            │
         └───────────────────────┴────────────────────────────┘
```

### Frontend: Admin Session Hook

```typescript
// hooks/useAdminAuth.ts
interface AdminSession {
  isAuthenticated: boolean;
  admin: { id: string; name: string; email: string } | null;
  isLoading: boolean;
  error: string | null;
}

interface AuthActions {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

function useAdminAuth(): AdminSession & AuthActions {
  const [session, setSession] = useState<AdminSession>({
    isAuthenticated: false,
    admin: null,
    isLoading: true,
    error: null,
  });

  const checkSession = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/session', {
        credentials: 'include', // Include cookies
      });

      if (response.ok) {
        const data = await response.json();
        setSession({
          isAuthenticated: true,
          admin: data.admin,
          isLoading: false,
          error: null,
        });
      } else {
        setSession({
          isAuthenticated: false,
          admin: null,
          isLoading: false,
          error: null,
        });
      }
    } catch (err) {
      setSession(prev => ({
        ...prev,
        isLoading: false,
        error: 'Failed to check session',
      }));
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setSession(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Login failed');
      }

      const data = await response.json();
      setSession({
        isAuthenticated: true,
        admin: data.admin,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      setSession({
        isAuthenticated: false,
        admin: null,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Login failed',
      });
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      setSession({
        isAuthenticated: false,
        admin: null,
        isLoading: false,
        error: null,
      });
    }
  }, []);

  // Check session on mount
  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return { ...session, login, logout, checkSession };
}
```

### Backend: Session Middleware

```typescript
// shared/auth.ts
import { Request, Response, NextFunction } from 'express';
import { redis } from './cache.js';
import { pool } from './db.js';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

const SESSION_TTL = 24 * 60 * 60; // 24 hours

interface AdminUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminUser;
    }
  }
}

export async function login(email: string, password: string): Promise<{
  sessionId: string;
  admin: AdminUser;
}> {
  // Lookup admin user
  const result = await pool.query(
    'SELECT id, email, name, password_hash FROM admin_users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid credentials');
  }

  const admin = result.rows[0];

  // Verify password
  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    throw new Error('Invalid credentials');
  }

  // Create session
  const sessionId = randomUUID();
  await redis.setex(
    `session:${sessionId}`,
    SESSION_TTL,
    JSON.stringify({
      adminId: admin.id,
      email: admin.email,
      name: admin.name,
      createdAt: Date.now(),
    })
  );

  return {
    sessionId,
    admin: { id: admin.id, email: admin.email, name: admin.name },
  };
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const sessionId = req.cookies?.sid;

  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const session = await redis.get(`session:${sessionId}`);
    if (!session) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const data = JSON.parse(session);
    req.admin = {
      id: data.adminId,
      email: data.email,
      name: data.name,
    };

    // Refresh session TTL on activity
    await redis.expire(`session:${sessionId}`, SESSION_TTL);

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}
```

### Training Job Trigger Flow

```typescript
// admin/routes/training.ts
import { Router } from 'express';
import { pool } from '../../shared/db.js';
import { publishTrainingJob } from '../../shared/queue.js';
import { requireAdmin } from '../../shared/auth.js';
import crypto from 'crypto';

const router = Router();

router.post('/training/start', requireAdmin, async (req, res) => {
  const { config } = req.body;
  const adminId = req.admin!.id;

  // Generate config hash for idempotency
  const configHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex')
    .slice(0, 16);

  // Check for existing pending/running job with same config (today)
  const existing = await pool.query(`
    SELECT id, status FROM training_jobs
    WHERE status IN ('pending', 'queued', 'running')
      AND config->>'hash' = $1
      AND created_at > NOW() - INTERVAL '24 hours'
  `, [configHash]);

  if (existing.rows.length > 0) {
    return res.status(200).json({
      jobId: existing.rows[0].id,
      status: existing.rows[0].status,
      message: 'Training job already exists for this configuration',
    });
  }

  // Create new training job
  const jobConfig = {
    ...config,
    hash: configHash,
    triggeredBy: adminId,
  };

  const result = await pool.query(`
    INSERT INTO training_jobs (status, config, created_by)
    VALUES ('pending', $1, $2)
    RETURNING id, status, created_at
  `, [JSON.stringify(jobConfig), adminId]);

  const job = result.rows[0];

  // Publish to RabbitMQ
  await publishTrainingJob({
    jobId: job.id,
    config: jobConfig,
  });

  // Update status to queued
  await pool.query(
    'UPDATE training_jobs SET status = $1 WHERE id = $2',
    ['queued', job.id]
  );

  res.status(201).json({
    jobId: job.id,
    status: 'queued',
    createdAt: job.created_at,
  });
});
```

---

## Deep Dive 3: Inference Integration (10 minutes)

### Model Loading and Hot-Reload

```typescript
// inference/modelLoader.ts
import { getActiveModel, downloadModel } from '../shared/storage.js';
import { pool } from '../shared/db.js';
import { logger } from '../shared/logger.js';

interface LoadedModel {
  id: string;
  version: string;
  accuracy: number;
  predict: (image: Float32Array) => Promise<PredictionResult>;
}

interface PredictionResult {
  shape: string;
  confidence: number;
  allPredictions: Array<{ shape: string; confidence: number }>;
}

class ModelManager {
  private currentModel: LoadedModel | null = null;
  private modelPath: string | null = null;
  private checkInterval: NodeJS.Timer | null = null;

  async initialize() {
    await this.loadActiveModel();

    // Check for model updates every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkForUpdates().catch(err => {
        logger.error({ err, msg: 'Model update check failed' });
      });
    }, 30_000);
  }

  async loadActiveModel() {
    const result = await pool.query(`
      SELECT id, version, accuracy, model_path
      FROM models
      WHERE is_active = true
    `);

    if (result.rows.length === 0) {
      logger.warn({ msg: 'No active model found' });
      return;
    }

    const model = result.rows[0];

    if (model.model_path === this.modelPath) {
      return; // Same model, no reload needed
    }

    logger.info({
      modelId: model.id,
      version: model.version,
      msg: 'Loading model'
    });

    // Download model from MinIO
    const modelBuffer = await downloadModel(model.model_path);

    // Load into TensorFlow.js (or ONNX Runtime)
    const loadedModel = await this.loadModelFromBuffer(modelBuffer);

    this.currentModel = {
      id: model.id,
      version: model.version,
      accuracy: model.accuracy,
      predict: loadedModel.predict.bind(loadedModel),
    };
    this.modelPath = model.model_path;

    logger.info({
      modelId: model.id,
      version: model.version,
      msg: 'Model loaded successfully'
    });
  }

  private async checkForUpdates() {
    const result = await pool.query(`
      SELECT model_path FROM models WHERE is_active = true
    `);

    if (result.rows.length > 0 && result.rows[0].model_path !== this.modelPath) {
      await this.loadActiveModel();
    }
  }

  async predict(strokeData: StrokeData): Promise<PredictionResult> {
    if (!this.currentModel) {
      throw new Error('No model loaded');
    }

    // Convert strokes to image
    const image = renderStrokesToImage(strokeData, 128, 128);

    // Run prediction
    return this.currentModel.predict(image);
  }

  getModelInfo() {
    if (!this.currentModel) {
      return null;
    }
    return {
      id: this.currentModel.id,
      version: this.currentModel.version,
      accuracy: this.currentModel.accuracy,
    };
  }

  shutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  private async loadModelFromBuffer(buffer: Buffer): Promise<{ predict: Function }> {
    // Implementation depends on model format (TensorFlow.js, ONNX, etc.)
    // This is a placeholder
    return {
      predict: async (image: Float32Array) => ({
        shape: 'circle',
        confidence: 0.95,
        allPredictions: [
          { shape: 'circle', confidence: 0.95 },
          { shape: 'heart', confidence: 0.03 },
          { shape: 'square', confidence: 0.02 },
        ],
      }),
    };
  }
}

export const modelManager = new ModelManager();
```

### Frontend: Implementor Portal Integration

```typescript
// routes/implement/ImplementorPortal.tsx
interface PredictionState {
  isLoading: boolean;
  result: PredictionResult | null;
  error: string | null;
  modelInfo: ModelInfo | null;
}

function ImplementorPortal() {
  const [strokeData, setStrokeData] = useState<StrokeData | null>(null);
  const [prediction, setPrediction] = useState<PredictionState>({
    isLoading: false,
    result: null,
    error: null,
    modelInfo: null,
  });

  // Fetch model info on mount
  useEffect(() => {
    fetch('/api/inference/model/info')
      .then(res => res.json())
      .then(data => setPrediction(prev => ({ ...prev, modelInfo: data })))
      .catch(console.error);
  }, []);

  const handleDrawingComplete = useCallback(async (strokes: StrokeData) => {
    setStrokeData(strokes);
    setPrediction(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const response = await fetch('/api/inference/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strokeData: strokes }),
      });

      if (!response.ok) {
        throw new Error('Classification failed');
      }

      const result = await response.json();
      setPrediction(prev => ({
        ...prev,
        isLoading: false,
        result: result,
      }));
    } catch (err) {
      setPrediction(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }));
    }
  }, []);

  return (
    <div className="implementor-portal">
      <header className="portal-header">
        <h1>Model Testing Portal</h1>
        {prediction.modelInfo && (
          <ModelInfoBadge
            version={prediction.modelInfo.version}
            accuracy={prediction.modelInfo.accuracy}
          />
        )}
      </header>

      <div className="portal-content">
        <section className="drawing-section">
          <h2>Draw a Shape</h2>
          <PostItCanvas
            onComplete={handleDrawingComplete}
            width={400}
            height={400}
          />
        </section>

        <section className="results-section">
          <h2>Classification Result</h2>
          {prediction.isLoading && <LoadingSpinner />}
          {prediction.error && (
            <ErrorMessage message={prediction.error} />
          )}
          {prediction.result && (
            <PredictionDisplay
              result={prediction.result}
              strokeData={strokeData}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function PredictionDisplay({
  result,
  strokeData
}: {
  result: PredictionResult;
  strokeData: StrokeData | null;
}) {
  return (
    <div className="prediction-display">
      <div className="main-prediction">
        <div className="predicted-shape">
          <ShapeIcon shape={result.shape} size={64} />
          <span className="shape-name">{result.shape}</span>
        </div>
        <div className="confidence-bar">
          <div
            className="confidence-fill"
            style={{ width: `${result.confidence * 100}%` }}
          />
          <span className="confidence-value">
            {(result.confidence * 100).toFixed(1)}%
          </span>
        </div>
      </div>

      <div className="all-predictions">
        <h4>All Predictions</h4>
        {result.allPredictions.map(pred => (
          <div key={pred.shape} className="prediction-row">
            <span className="shape">{pred.shape}</span>
            <div className="mini-bar">
              <div
                className="mini-fill"
                style={{ width: `${pred.confidence * 100}%` }}
              />
            </div>
            <span className="value">{(pred.confidence * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>

      {strokeData && (
        <div className="stroke-preview">
          <h4>Your Drawing</h4>
          <StrokeThumbnail strokes={strokeData.strokes} size={120} />
        </div>
      )}
    </div>
  );
}
```

### API Contract: Inference Endpoints

```typescript
// GET /api/inference/model/info
// Returns information about the currently loaded model

Response - Success:
200 OK
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "version": "v1.2.0",
  "accuracy": 0.943,
  "loadedAt": "2024-01-15T10:30:00.000Z"
}

Response - No Model:
503 Service Unavailable
{
  "error": "No model loaded",
  "message": "Model is still loading or no active model is set"
}

// POST /api/inference/classify
// Classify a drawing

Request:
{
  "strokeData": {
    "canvas": { "width": 400, "height": 400 },
    "strokes": [...],
    "duration_ms": 2500,
    "device": "mouse"
  }
}

Response - Success:
200 OK
{
  "shape": "circle",
  "confidence": 0.953,
  "allPredictions": [
    { "shape": "circle", "confidence": 0.953 },
    { "shape": "heart", "confidence": 0.025 },
    { "shape": "square", "confidence": 0.012 },
    { "shape": "triangle", "confidence": 0.007 },
    { "shape": "line", "confidence": 0.003 }
  ],
  "inferenceTimeMs": 23,
  "modelVersion": "v1.2.0"
}

Response - Validation Error:
400 Bad Request
{
  "error": "Invalid stroke data",
  "details": "Strokes array cannot be empty"
}

Response - Model Not Ready:
503 Service Unavailable
Headers:
  Retry-After: 5
{
  "error": "Model not ready",
  "retryAfter": 5
}
```

---

## Deep Dive 4: Error Handling Strategy (5 minutes)

### Unified Error Response Format

```typescript
// shared/errors.ts
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details, false);
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(401, 'AUTH_ERROR', message, undefined, false);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(service: string, retryAfter: number = 30) {
    super(
      503,
      'SERVICE_UNAVAILABLE',
      `${service} is temporarily unavailable`,
      { retryAfter },
      true
    );
  }
}

// Error handling middleware
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = req.headers['x-request-id'] as string;

  if (err instanceof AppError) {
    logger.warn({
      requestId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });

    const response: ErrorResponse = {
      error: err.code,
      message: err.message,
      requestId,
    };

    if (err.details) {
      response.details = err.details;
    }

    if (err.retryable && err.details?.retryAfter) {
      res.set('Retry-After', String(err.details.retryAfter));
    }

    return res.status(err.statusCode).json(response);
  }

  // Unexpected errors
  logger.error({
    requestId,
    err,
    msg: 'Unexpected error',
  });

  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    requestId,
  });
}
```

### Frontend: Error Display Component

```typescript
// components/ErrorDisplay.tsx
interface ErrorDisplayProps {
  error: string | null;
  onRetry?: () => void;
  retryable?: boolean;
}

function ErrorDisplay({ error, onRetry, retryable }: ErrorDisplayProps) {
  if (!error) return null;

  return (
    <div
      className="error-display"
      role="alert"
      aria-live="polite"
    >
      <div className="error-icon">
        <AlertCircleIcon />
      </div>
      <div className="error-content">
        <p className="error-message">{error}</p>
        {retryable && onRetry && (
          <button
            className="retry-button"
            onClick={onRetry}
          >
            Try Again
          </button>
        )}
      </div>
    </div>
  );
}
```

---

## Trade-offs Summary

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Session storage | Redis with cookies | JWT tokens | Revocation support, server-controlled expiry, simpler CSRF protection |
| Idempotency | Redis with TTL | Database table | Faster lookups, automatic expiry, no cleanup needed |
| Model loading | Hot-reload with polling | Webhook notification | Simpler implementation, acceptable 30s delay for model updates |
| Error format | Structured with codes | HTTP status only | Better client-side handling, internationalization support |
| Stroke format | JSON with all metadata | Rendered images | Preserves temporal data, flexible training preprocessing |

---

## Future Enhancements

1. **WebSocket for Training Progress**: Real-time training job updates instead of polling
2. **Pre-signed Upload URLs**: Direct browser-to-MinIO upload for large drawings
3. **Client-side Model**: TensorFlow.js for instant browser-based inference
4. **A/B Testing Framework**: Compare model versions with statistical significance
5. **Collaborative Drawing**: Multiple users contributing to single complex drawing
