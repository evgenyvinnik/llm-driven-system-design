# Scale AI - Data Labeling & ML Training Platform

## System Overview

A crowdsourced data collection platform for training machine learning models. Users contribute labeled drawing data through a game interface, administrators manage the dataset and trigger model training, and implementors use trained models for inference. The system is designed to handle millions of concurrent contributors, store billions of labeled samples, and serve low-latency model inference.

## Requirements

### Functional Requirements

**Data Collection Portal (End Users)**
- Draw shapes on a canvas (line, heart, circle, square, triangle)
- Touch and mouse input support with clear visual feedback
- Session tracking (anonymous or authenticated)
- Gamification elements (progress tracking, streaks)

**Admin Portal**
- View collected data statistics (count per shape, quality metrics)
- Browse and filter individual submissions
- Flag/remove low-quality data with soft delete support
- Trigger model training jobs with configurable hyperparameters
- Monitor training progress and model performance
- Compare model versions, activate best model

**Implementor Portal**
- Load trained model and classify drawings
- Generate shapes based on trained prototypes
- View inference latency and confidence scores

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Availability | 99.9% (8.7h downtime/year) | Collection can tolerate brief outages; lost drawings are acceptable |
| Collection throughput | 100,000 concurrent drawing submissions | Flash crowd scenarios (viral campaigns, school assignments) |
| Write latency | < 200ms for drawing submission | User perceives submission as instant |
| Inference latency | < 100ms p99 | Real-time classification feedback |
| Training throughput | Process 10M drawings in < 4 hours | Daily retraining on full dataset |
| Storage efficiency | < 50KB per drawing (stroke data) | Stroke JSON is 10-100x smaller than rasterized images |
| Model accuracy | > 95% on 5-class shape recognition | Simple geometric shapes are well-constrained |

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Active Users | 1M | |
| Drawings per user per session | 10-50 | |
| Drawings per day | 20M | ~230 RPS average, ~2,000 RPS peak |
| Drawing data size | 5-50 KB | Stroke data JSON |
| Total drawings (1 month) | 600M | |
| Raw storage (1 month) | 6-30 TB | Before compression |
| Training job frequency | Daily or on-demand | |
| Model inference QPS | 10,000+ | Real-time classification |
| Metadata storage | ~200 GB/month | PostgreSQL rows for drawings table |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 1-5 |
| Drawings per day | 100-500 |
| Storage growth | ~25 MB/day |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND LAYER                                  │
├─────────────────┬─────────────────────┬──────────────────────────────────────┤
│  Drawing Game   │    Admin Portal     │         Implementor Portal           │
│  (React+Canvas) │   (React+Charts)    │        (React+Canvas)                │
└────────┬────────┴──────────┬──────────┴──────────────────┬───────────────────┘
         │                   │                              │
         ▼                   ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                           │
│              (Rate Limiting, TLS Termination, Routing)                       │
└────────┬───────────────────┬──────────────────────────────┬──────────────────┘
         │                   │                              │
         ▼                   ▼                              ▼
┌─────────────────┐ ┌─────────────────┐           ┌─────────────────┐
│  Collection     │ │  Admin          │           │  Inference      │
│  Service        │ │  Service        │           │  Service        │
│  (Express.js)   │ │  (Express.js)   │           │  (Express.js)   │
│  Stateless,     │ │  Session Auth   │           │  Model Cache    │
│  High Throughput│ │                 │           │                 │
└────────┬────────┘ └────────┬────────┘           └────────┬────────┘
         │                   │                              │
         │                   │                              │
         ▼                   ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              DATA LAYER                                      │
├─────────────────┬─────────────────┬───────────────┬──────────────────────────┤
│   PostgreSQL    │  Object Storage │    Redis      │      RabbitMQ            │
│   (Metadata,    │  (Drawings,     │  (Sessions,   │   (Training Jobs,        │
│    Jobs,        │   Models)       │   Cache,      │    Async Tasks)          │
│    Models)      │                 │   Idempotency)│                          │
└─────────────────┴────────┬────────┴───────────────┴──────────┬───────────────┘
                           │                                    │
                           ▼                                    ▼
                  ┌─────────────────┐                  ┌─────────────────┐
                  │  S3 / Object    │                  │ Training Worker │
                  │  Storage        │                  │ (Python/PyTorch)│
                  │  (Drawings +    │◄─────────────────│ GPU-accelerated │
                  │   Models)       │                  │                 │
                  └─────────────────┘                  └─────────────────┘
```

## Database Schema

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table for session tracking (anonymous or authenticated)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    total_drawings INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_session ON users(session_id);
CREATE INDEX idx_users_role ON users(role);

-- Shape definitions for the drawing game
CREATE TABLE shapes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    difficulty INT DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drawing submissions from users
CREATE TABLE drawings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    shape_id INT REFERENCES shapes(id) ON DELETE CASCADE,
    stroke_data_path VARCHAR(500) NOT NULL,  -- Path in object storage
    metadata JSONB DEFAULT '{}',  -- canvas size, duration, stroke count, device type
    quality_score FLOAT CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
    is_flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL  -- Soft delete support
);
CREATE INDEX idx_drawings_shape ON drawings(shape_id);
CREATE INDEX idx_drawings_user ON drawings(user_id);
CREATE INDEX idx_drawings_created ON drawings(created_at DESC);
CREATE INDEX idx_drawings_quality ON drawings(quality_score) WHERE quality_score IS NOT NULL;
CREATE INDEX idx_drawings_flagged ON drawings(is_flagged) WHERE is_flagged = TRUE;
CREATE INDEX idx_drawings_deleted_at ON drawings(deleted_at);

-- Training job management
CREATE TABLE training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) DEFAULT 'pending'
        CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled')),
    config JSONB DEFAULT '{}',  -- hyperparameters, data filters, epochs
    error_message TEXT,
    progress JSONB DEFAULT '{}',  -- current_epoch, total_epochs, current_loss, phase
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    metrics JSONB,  -- accuracy, loss, confusion matrix
    model_path VARCHAR(500),  -- Path in object storage when completed
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_training_jobs_status ON training_jobs(status);
CREATE INDEX idx_training_jobs_created ON training_jobs(created_at DESC);

-- Trained model versions
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    training_job_id UUID REFERENCES training_jobs(id) ON DELETE CASCADE,
    version VARCHAR(50) NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    accuracy FLOAT CHECK (accuracy IS NULL OR accuracy BETWEEN 0 AND 1),
    model_path VARCHAR(500) NOT NULL,  -- Path in object storage
    config JSONB DEFAULT '{}',  -- Model architecture details, prototype data
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Unique partial index ensures only one active model at a time
CREATE UNIQUE INDEX idx_models_active ON models(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_models_version ON models(version);
CREATE INDEX idx_models_created ON models(created_at DESC);

-- Admin users with email/password authentication
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_admin_users_email ON admin_users(email);

-- Seed data: 5 shapes for the drawing game
INSERT INTO shapes (name, description, difficulty) VALUES
    ('line', 'A straight line from one point to another', 1),
    ('circle', 'A round shape with no corners', 2),
    ('square', 'A shape with 4 equal sides and 4 right angles', 2),
    ('triangle', 'A shape with 3 sides and 3 corners', 2),
    ('heart', 'A classic heart shape symbolizing love', 3);
```

### Drawing Data Format (Stored in Object Storage)

```json
{
  "shape": "circle",
  "canvas": { "width": 400, "height": 400 },
  "strokes": [
    {
      "points": [
        {"x": 100, "y": 100, "pressure": 0.5, "timestamp": 1234567890},
        {"x": 102, "y": 101, "pressure": 0.6, "timestamp": 1234567891}
      ],
      "color": "#000000",
      "width": 3
    }
  ],
  "duration_ms": 2500,
  "device": "mouse"
}
```

**Why stroke data instead of images:** Stroke JSON preserves temporal information (drawing order, speed), pressure data, and device type — all valuable for ML training. It is also 10-100x smaller than rasterized images. Images can be rendered at training time at any resolution (64x64, 128x128) from the same stroke data.

## Core Components

### Collection Service

**Responsibilities:**
- Receive drawing submissions via REST API
- Validate and sanitize input data
- Store stroke data in object storage (MinIO/S3)
- Create metadata record in PostgreSQL
- Idempotency protection against duplicate submissions

**API Endpoints:**
```
POST /api/drawings          Submit a completed drawing
GET  /api/shapes            Get list of available shapes
GET  /api/user/stats        Get user's drawing statistics
GET  /health                Health check (liveness)
GET  /health/ready          Readiness probe (dependencies)
GET  /metrics               Prometheus metrics
```

**Design Considerations:**
- Stateless: scales horizontally behind a load balancer
- Batch writes deferred to future optimization (currently single-insert)
- Pre-signed URLs for direct-to-storage upload at production scale

### Admin Service

**Responsibilities:**
- Aggregate statistics across all drawings
- Data browsing and filtering with pagination
- Quality scoring and flagged data management
- Training job lifecycle (create, monitor, cancel)
- Model comparison and activation

**API Endpoints:**
```
POST /api/admin/auth/login          Admin login
POST /api/admin/auth/logout         Admin logout
GET  /api/admin/auth/me             Current admin user
GET  /api/admin/stats               Dashboard statistics
GET  /api/admin/drawings            Paginated drawing list with filters
POST /api/admin/drawings/:id/flag   Flag low-quality data
DELETE /api/admin/drawings/:id      Soft-delete drawing
POST /api/admin/drawings/:id/restore Restore soft-deleted drawing
GET  /api/admin/quality/analyze     Batch quality analysis
POST /api/admin/training/start      Trigger training job
GET  /api/admin/training/:id        Training job status
GET  /api/admin/models              List trained models
POST /api/admin/models/:id/activate Set active model
POST /api/admin/cleanup/run         Trigger data cleanup
GET  /metrics                       Prometheus metrics
```

### Training Worker (Python)

**Responsibilities:**
- Consume training jobs from RabbitMQ
- Fetch training data from object storage
- Preprocess: convert stroke data to images (64x64 grayscale)
- Augment: rotation, scaling, noise
- Train CNN model (PyTorch)
- Evaluate: accuracy, confusion matrix
- Save model and prototype data to object storage
- Report metrics back to PostgreSQL

**Training Pipeline:**
```
1. Receive job from RabbitMQ
2. Fetch drawings from MinIO/S3 (filtered by job config)
3. Convert stroke JSON → 64x64 grayscale images
4. Apply data augmentation (rotation, flip, noise)
5. Train CNN model (configurable epochs, batch size, learning rate)
6. Evaluate on held-out test set
7. Save model weights + prototype data to object storage
8. Update training_jobs and models tables in PostgreSQL
9. Acknowledge message in RabbitMQ
```

### Inference Service

**Responsibilities:**
- Load active model information from database
- Classify drawings based on stroke data (currently heuristic-based; production uses actual ML model)
- Generate shapes using trained prototypes or procedural fallbacks
- Report inference latency and confidence metrics

**API Endpoints:**
```
POST /api/inference/classify    Classify a drawing (returns shape + confidence)
POST /api/inference/generate    Generate a shape (returns stroke data)
GET  /api/inference/model/info  Current active model info
GET  /metrics                   Prometheus metrics
```

## Key Design Decisions

### 1. Drawing Storage: Stroke Data (JSON) vs. Rasterized Images

**Chosen**: Store stroke data as JSON in object storage, render to images at training time.

**Why stroke data works for ML data collection:**
- Preserves all information: temporal ordering, drawing speed, pressure, device type. This enables future stroke-based models (RNN/Transformer on sequences) in addition to CNN on images.
- 10-100x smaller than PNG images. A typical drawing is 5-50KB as JSON vs. 100KB-1MB as a high-resolution image. At 600M drawings/month, this saves 6-60 TB of storage.
- Flexible training: the same stroke data can be rendered at any resolution (64x64, 128x128, 256x256) without storing multiple copies.

**Why rasterized images fail for this use case:** Storing only images loses temporal information permanently. If a future model architecture benefits from stroke order (e.g., "did the user draw a circle clockwise or counterclockwise?"), that data is gone. Additionally, at 600M samples, image storage costs are prohibitive.

**What we give up:** Training requires a preprocessing step (stroke-to-image rendering) that adds ~30 minutes to each training job. This is acceptable because training runs are infrequent (daily or on-demand) and the rendering step parallelizes trivially.

### 2. Submission Model: REST on Completion vs. WebSocket Streaming

**Chosen**: Submit complete drawing via REST POST on completion.

**Why batch submission works:**
- Simpler client and server implementation. No persistent connection management, no partial-drawing state tracking.
- Lower server load. WebSocket connections consume memory per connected client. At 100K concurrent users, this is 100K persistent connections.
- Natural idempotency boundary. A complete drawing submission is a single atomic operation that can be retried safely with an idempotency key.

**Why WebSocket streaming fails at this scale:**
Streaming every stroke point in real-time generates 50-200 messages per drawing per second. At 100K concurrent users, this is 5-20M messages/s — enormous infrastructure cost for minimal benefit. Real-time stroke streaming would be justified only if the product required live collaborative drawing or immediate feedback during drawing.

**What we give up:** If a user closes the browser mid-drawing, the drawing is lost. This is acceptable for a gamified data collection tool where each drawing takes 3-10 seconds. Users can simply draw again.

### 3. Training Architecture: Message Queue + Python Worker

**Chosen**: Admin triggers training via REST API, job published to RabbitMQ, Python worker consumes and trains.

**Why message queue decoupling works:**
- Training jobs take minutes to hours. Synchronous API calls would timeout. The queue allows fire-and-forget job submission with async progress monitoring.
- Worker can run on GPU hardware separate from the API servers. No need to provision GPUs for every API server instance.
- Natural retry semantics. If the worker crashes mid-training, the unacknowledged message is requeued and picked up by another worker.
- Progress reporting via PostgreSQL updates. The admin portal polls job status without coupling to the worker.

**Why not in-process training:**
Node.js API servers are not suitable for GPU-bound ML training. Python + PyTorch is the standard for ML workflows. Running training in a separate process also isolates failures — a training crash doesn't bring down the API.

### 4. Model Activation: Atomic Single-Active-Model

**Chosen**: PostgreSQL unique partial index ensures only one model can be `is_active = TRUE` at a time. Activation is an atomic transaction: deactivate current, activate new.

```sql
BEGIN;
UPDATE models SET is_active = FALSE WHERE is_active = TRUE;
UPDATE models SET is_active = TRUE WHERE id = $1;
COMMIT;
```

**Why this works:** All inference service instances query the `models` table for the active model. The unique partial index (`CREATE UNIQUE INDEX idx_models_active ON models(is_active) WHERE is_active = TRUE`) guarantees database-level enforcement of the single-active constraint, preventing split-brain scenarios where different inference instances serve different models.

## Consistency and Idempotency

### Write Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Drawing submission | Eventual | Loss of a single drawing is acceptable; high throughput is critical |
| Training job creation | Strong | Must guarantee exactly-once to avoid duplicate training runs |
| Model activation | Strong | Active model must be immediately consistent across all inference instances |
| User stats update | Eventual | Reconciled asynchronously |

**Drawing Submissions:**
- Writes to PostgreSQL and MinIO are not transactional across systems
- If MinIO write succeeds but PostgreSQL fails: orphan detection job cleans up hourly
- If PostgreSQL write succeeds but MinIO fails: drawing row has null path, excluded from training

### Idempotency Implementation

**Drawing Submissions:** Client generates idempotency key from `sessionId:shapeId:timestamp`. Server checks Redis before processing. After successful save, marks as processed with 1-hour TTL. Prevents duplicate drawings from network retries and double-clicks.

**Training Jobs:** Config hash + date serves as natural idempotency key. Server checks for existing pending/running job with same config from the same day before creating a new one.

### Conflict Resolution

- **Drawing submissions**: No conflicts possible — each drawing gets a unique UUID
- **Quality score updates**: Last-write-wins (admin override is final)
- **Model activation**: Atomic PostgreSQL transaction with unique partial index

## Security

### Authentication Model

| Portal | Auth Method | Storage |
|--------|-------------|---------|
| Drawing game | Anonymous session (auto-generated session_id) | PostgreSQL users table |
| Admin portal | Email + password (bcrypt, cost 12) | Redis-backed sessions, httpOnly cookies |
| Inference API | No auth (public) | N/A |

### Rate Limiting

- Drawing submissions: configurable per IP
- Admin API: session-based, authenticated users only
- Inference API: per IP rate limiting

### Input Validation

- Drawing data: validate stroke format, canvas dimensions, enforce size limit
- Sanitize filenames and user inputs
- CORS configuration for API endpoints

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, route, status_code | Request volume and error rate |
| `http_request_duration_seconds` | Histogram | method, route | Latency percentiles |
| `drawings_total` | Counter | shape, status | Drawing submission volume |
| `inference_requests_total` | Counter | model_version, predicted_shape | Inference volume |
| `inference_latency_seconds` | Histogram | model_version | Inference latency |
| `generation_requests_total` | Counter | model_version, shape | Shape generation volume |
| `external_service_calls_total` | Counter | service, operation, status | Dependency health |
| `circuit_breaker_state` | Gauge | service | 0=closed, 1=half-open, 2=open |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Collection API p99 latency | < 200ms | > 500ms for 5m |
| Inference p99 latency | < 100ms | > 200ms for 5m |
| Error rate (5xx) | < 0.5% | > 2% for 5m |
| Training job success rate | > 95% | < 80% for 24h |
| Circuit breaker open | 0 | Any service open > 5min |

### Structured Logging (Pino)

JSON logs with consistent fields: `level`, `time`, `service` (collection/admin/inference), `requestId`, `msg`, plus context-specific fields (drawingId, shape, modelVersion, processingTimeMs). Child loggers inherit request context for correlated log traces.

## Failure Handling

### Retry Strategies

| Component | Retry Policy | Backoff | Max Attempts |
|-----------|-------------|---------|--------------|
| MinIO uploads | Exponential | 100ms, 200ms, 400ms, 800ms | 4 |
| PostgreSQL writes | Exponential | 50ms, 100ms, 200ms | 3 |
| RabbitMQ publish | Exponential | 500ms, 1s, 2s, 4s | 5 |
| Training data fetch | Linear | 1s between attempts | 3 |

### Circuit Breakers

| Service | Failure Threshold | Reset Timeout | Fallback Behavior |
|---------|------------------|---------------|-------------------|
| PostgreSQL | 3 consecutive | 15s | Return 503 with Retry-After header |
| MinIO | 5 consecutive | 30s | Reject submissions with 503 |
| RabbitMQ | 5 consecutive | 60s | Write to dead-letter table in PostgreSQL |

### Failure Scenarios

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| MinIO down | Circuit breaker opens | Reject uploads, return 503 | Retry after reset timeout |
| PostgreSQL down | Connection pool errors | All API requests fail | Alert immediately |
| RabbitMQ down | Publish fails | Write job to PostgreSQL table | Replay on recovery |
| Training worker crash | Job timeout (30min) | Mark job as 'failed' | Admin restarts manually |
| Model file corrupted | Inference error | Fall back to previous model | Re-run training |

### Graceful Shutdown

All services handle SIGTERM/SIGINT: stop cleanup scheduler (collection), close database connections, log shutdown reason, exit cleanly.

## Data Lifecycle

### Retention Policies

| Data Type | Retention | Action |
|-----------|-----------|--------|
| Drawing stroke data | Indefinite (training data) | Never delete; tier to cold storage after 180 days |
| Drawing metadata (PostgreSQL) | Indefinite | Archive completed training jobs > 1 year |
| Soft-deleted drawings | 30 days | Permanent delete (DB + MinIO) |
| Flagged drawings | 90 days | Soft-delete (archive) |
| Model files | Active + last 5 versions | Delete unused models after 2 years |
| User sessions (Redis) | 7 days | Auto-expire via TTL |
| Idempotency keys (Redis) | 1 hour | Auto-expire via TTL |
| Cached stats (Redis) | 5 minutes | Auto-expire via TTL |

### Storage Tiering (Production)

```
Hot  (0-30 days):   S3 Standard — fast access for active training
Warm (30-180 days): S3 Infrequent Access — still accessible for retraining
Cold (180+ days):   S3 Glacier — compressed, archive only
```

## Scalability Considerations

### Data Collection at Scale

At 100K concurrent users submitting drawings:
1. **Horizontal scaling** of collection service (stateless, behind load balancer)
2. **Pre-signed URLs** for direct-to-storage uploads (bypass API server for binary data)
3. **Client-side batching** (submit multiple drawings in single request)
4. **Message queue** for async post-processing (quality scoring, metadata enrichment)

### Training Large Datasets

At 600M drawings:
1. **Streaming data loader** — don't load all into memory; stream from storage
2. **Distributed training** — multiple GPUs/workers for parallel training
3. **Data sampling** — train on representative subset; validate on full set
4. **Incremental training** — fine-tune on new data rather than retraining from scratch

### Model Serving at Scale

At 10,000 inference QPS:
1. **Model caching** — keep model weights warm in memory (no disk I/O per request)
2. **Batch inference** — group multiple classification requests
3. **Edge deployment** — TensorFlow.js in browser for zero-latency classification
4. **Model optimization** — quantization, pruning for smaller/faster models

### What Breaks First

1. **Object storage write throughput** at ~2,000 drawings/s — mitigated by pre-signed URLs and horizontal collection scaling
2. **PostgreSQL connections** at ~1,000 concurrent — mitigated by connection pooling and read replicas
3. **Training worker GPU** at >600M drawings — mitigated by data sampling and distributed training

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Drawing storage format | Stroke JSON | Rasterized images | 10-100x smaller, preserves temporal data |
| Submission model | REST on completion | WebSocket streaming | Simpler, lower load, natural idempotency |
| Training trigger | RabbitMQ job queue | Synchronous API | Training takes minutes; async is required |
| ML framework | PyTorch (Python worker) | TensorFlow.js (in-browser) | GPU training, mature ecosystem |
| Object storage | S3 (MinIO locally) | PostgreSQL BYTEA | Scales to petabytes; BYTEA doesn't |
| Admin auth | Session-based (Redis) | JWT | Immediate revocation, simpler |
| Inference placeholder | Heuristic analysis | Full ML model | Proves API contract; swap for real model later |
| Model activation | Single-active with DB constraint | Feature flags | Simpler; unique index enforces invariant |

## Frontend Architecture

### Component Hierarchy

```
App.tsx (hash-based router + game state manager)
├── #draw (Drawing Game - default view)
│   ├── Global Nav (Draw | Admin | Test Model)
│   ├── Stats Header (total drawings, today, streak, level)
│   ├── PostItCanvas (skeuomorphic drawing canvas)
│   │   └── <canvas> (400x400, multi-pass marker rendering)
│   ├── Progress Bar (shape cycle dots)
│   └── Success/Milestone Toasts
├── #admin (Admin Dashboard)
│   ├── AdminLogin (email/password form)
│   └── AdminDashboard (tabbed interface)
│       ├── OverviewTab (StatCard grid, recent jobs)
│       ├── DrawingsTab (paginated gallery, flag/delete/restore)
│       │   └── StrokeThumbnail (canvas-rendered thumbnail)
│       ├── QualityTab (batch analysis, quality stats)
│       └── TrainingTab (start training, model list, activate)
└── #implement (Implementor Portal)
    ├── Classify Mode
    │   ├── PostItCanvas (freeform drawing)
    │   └── Results Panel (prediction, confidence bars, probabilities)
    └── Generate Mode
        └── GenerateMode (shape selector + AI-generated stroke display)
```

The app uses a single `App.tsx` component as both the router and top-level state manager. There are no nested routes or lazy-loaded components -- the entire application renders from one component tree with conditional rendering based on the `view` state variable.

### Routing (Hash-Based, No TanStack Router)

Unlike the other projects in this repository, Scale AI does **not** use TanStack Router. It uses a simple hash-based routing scheme implemented directly in `App.tsx`:

| Hash | View | Component |
|------|------|-----------|
| (none) | `draw` | Drawing game (default) |
| `#admin` | `admin` | Admin dashboard |
| `#implement` | `implement` | Model tester portal |

Navigation uses `window.location.hash` directly, and the app listens for `hashchange` events via `useEffect`. This was chosen because the three views are completely independent portals with no shared state, and the admin/implementor views are secondary to the drawing game. The simplicity of hash routing avoids the overhead of a routing library for what is essentially a three-tab application.

### State Management (No Zustand)

This project does not use Zustand. All state is managed via React's `useState` and `useCallback` hooks within the components that need it:

**Drawing game state** (in `App.tsx`): `currentShapeIndex` (which shape to draw next), `totalDrawings` / `todayDrawings` / `streakDays` / `level` (gamification stats), `showSuccess` / `showMilestone` (toast animations), `submitting` (loading guard), `error` (error banner), `soundOn` (sound effects toggle). Stats are loaded from the backend on mount and updated locally after each submission.

**Admin dashboard state** (in `AdminDashboard.tsx`): `user` (admin auth), `stats` / `drawings` / `models` (data), `activeTab` (tab navigation), `trainingInProgress` (loading guard). All data is loaded via `Promise.all` on login and refreshed after mutations.

**Implementor portal state** (in `ImplementorPortal.tsx`): `modelInfo` (active model metadata), `result` (classification output), `activeMode` (classify vs generate tab).

**Anonymous session management** (in `services/api.ts`): A UUID session ID is generated via `crypto.randomUUID()` and stored in localStorage. This ID is sent with every drawing submission to track per-user statistics without requiring login.

### API Service Architecture

The API layer in `frontend/src/services/api.ts` is organized by backend service rather than by resource, reflecting the microservice architecture:

- **Collection API** (port 3001): `getShapes()`, `submitDrawing()`, `getUserStats()` -- used by the drawing game. Anonymous; uses `sessionId` from localStorage.
- **Admin API** (port 3002): `adminLogin()`, `adminLogout()`, `getAdminStats()`, `getDrawings()`, `flagDrawing()`, `deleteDrawing()`, `startTraining()`, `getModels()`, `activateModel()`, `analyzeBatchQuality()` -- used by the admin dashboard. Uses httpOnly session cookies via `credentials: 'include'`.
- **Inference API** (port 3003): `getModelInfo()`, `classifyDrawing()`, `generateShape()` -- used by the implementor portal. No authentication required.

The `adminFetch` helper wraps all admin API calls with consistent credentials and content-type headers. Each API function returns typed results using TypeScript interfaces defined in the same file.

### Key UI Patterns

**Skeuomorphic canvas (PostItCanvas)**: The most distinctive UI component across all four projects. The canvas is styled as a yellow post-it note pinned to a cork board background, with a decorative Sharpie marker and realistic paper texture. Drawing uses a multi-pass rendering technique: three canvas passes with decreasing opacity (0.8, 0.4, 0.2) and increasing line width simulate marker ink bleeding. Random ink dots are added at stroke points for texture. The canvas captures pressure data from touch devices and timestamps for each point, producing the stroke data format required for ML training.

**Gamification loop**: The drawing game cycles through 5 shapes (line, heart, circle, square, triangle) sequentially. After each submission, the shape advances to the next in the cycle. Milestone thresholds (5, 10, 25, 50, 100, 250, 500, 1000 drawings) trigger celebration animations and sound effects. The level system (1 level per 10 drawings) and streak tracking (consecutive days of drawing) provide long-term engagement.

**Optimistic updates in admin**: The `AdminDashboard` performs optimistic local state updates for flag, delete, and restore operations. When an admin flags a drawing, `setDrawings` immediately updates the local array without waiting for the API response. If the API call fails, an error message is shown but the optimistic update is not rolled back -- the admin can retry or refresh.

**Sound effects**: The `utils/sounds.ts` module provides audio feedback for drawing submission (`success`), milestone achievement (`levelUp`), errors (`error`), and UI interactions (`click`). Sounds can be toggled on/off and the preference persists in localStorage.

**Reusable PostItCanvas for two contexts**: The same `PostItCanvas` component serves both the drawing game (with a specific shape prompt like "Draw a circle") and the implementor classify mode (with a generic "Draw any shape" prompt). The `shape` prop controls the prompt text, and the `freeform` value disables shape-specific guidance.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, why it matters for a data labeling platform, and how it works in practice.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is a method of restricting system access based on roles assigned to users rather than checking individual permissions for each action. Each user has a role, and each API endpoint checks the caller's role before allowing the operation.

**Why Scale AI needs it:** A data labeling platform has three completely separate user personas with no overlapping permissions. Anonymous contributors draw shapes and should not be able to view other users' data, trigger training, or manage the dataset. Admins need to browse all drawings, flag low-quality data, trigger and monitor training jobs, and activate models. Inference users need to classify drawings and generate shapes. Without RBAC, either contributors could corrupt the training dataset by deleting drawings, or admins would have no way to curate data quality.

**How it works here:** The platform uses two separate authentication mechanisms reflecting its two auth models. Anonymous drawing contributors get an auto-generated session ID stored in localStorage -- they have no database user record with a role column. Admin users authenticate via email/password (bcrypt, cost 12) stored in the `admin_users` table, with sessions managed in Redis via httpOnly cookies. The auth middleware in `backend/src/shared/auth.ts` validates the session cookie and rejects requests without a valid admin session. The inference API has no authentication at all -- it is public by design. This three-tier approach (anonymous, admin-authenticated, public) is simpler than a unified RBAC system because the three portals have zero permission overlap.

### Redis Cache-Aside

**What it is:** Cache-aside is a caching strategy where the application checks the cache before querying the database for each read. On a cache hit, the cached value is returned immediately. On a cache miss, the application queries the database, stores the result in the cache with a TTL, and returns it.

**Why Scale AI needs it:** The admin dashboard's overview page queries aggregated statistics across all drawings: total count, per-shape breakdown, flagged count, today's count, and active model info. These statistics require multiple `COUNT(*)` and `GROUP BY` queries against the drawings table, which grows continuously as users submit drawings. Without caching, every time an admin loads the dashboard, the database runs expensive aggregation queries. At 20M drawings per day at production scale, these queries would take seconds and add unnecessary load. Caching the aggregated stats with a short TTL (5 minutes) means the database runs these queries at most once every 5 minutes, regardless of how many admins are viewing the dashboard simultaneously.

**How it works here:** The `backend/src/shared/cache.ts` module provides a Redis client with `cacheGet` and `cacheSet` helpers. Dashboard statistics are cached at a key like `admin:stats` with a 5-minute TTL. Session data is cached at `session:{sessionId}` with a configurable TTL (7 days default, 30 days for "remember me"). Idempotency keys for drawing submissions are stored at `idempotency:{key}` with a 1-hour TTL. When an admin triggers actions that would invalidate cached stats (flagging, deleting, restoring drawings), the stats cache is not explicitly invalidated -- the 5-minute TTL provides eventual consistency, which is acceptable for dashboard statistics.

### Circuit Breaker

**What it is:** A circuit breaker monitors calls to an external dependency and automatically stops sending requests when the dependency is failing. In its "closed" state, requests pass through normally. When failures exceed a threshold, it enters the "open" state and immediately rejects all requests without attempting the call. After a cooldown period, it enters "half-open" state and allows a single test request. If the test succeeds, the circuit closes; if it fails, it reopens.

**Why Scale AI needs it:** The platform depends on three external services: PostgreSQL, MinIO, and RabbitMQ. Each has different failure modes and recovery characteristics. If MinIO goes down, drawing submissions will fail (stroke data cannot be stored), but the admin dashboard can still display cached stats and the inference service can still classify drawings. If RabbitMQ goes down, training jobs cannot be queued, but drawing collection and inference continue. Without circuit breakers, a MinIO outage would cause every drawing submission to hang for the full timeout period (30+ seconds), exhausting the connection pool and making the entire collection service unresponsive -- even for health checks and metrics endpoints that do not use MinIO.

**How it works here:** Circuit breakers are implemented in `backend/src/shared/circuitBreaker.ts` with per-dependency configurations. PostgreSQL: opens after 3 consecutive failures, resets after 15 seconds, returns 503 with `Retry-After` header when open. MinIO: opens after 5 consecutive failures, resets after 30 seconds, rejects drawing submissions with 503. RabbitMQ: opens after 5 consecutive failures, resets after 60 seconds, falls back to writing the training job to a dead-letter table in PostgreSQL (to be replayed when RabbitMQ recovers). Circuit breaker state is exposed as a Prometheus gauge (`circuit_breaker_state`: 0=closed, 1=half-open, 2=open) and included in the health check response.

### Structured Logging

**What it is:** Structured logging emits log entries as JSON objects with consistent, typed fields instead of free-form text strings. Each entry has standard fields (timestamp, level, service, message) plus context-specific fields that vary by event type.

**Why Scale AI needs it:** A microservice architecture with three separate services (collection, admin, inference) plus a Python training worker generates logs in four different processes. Without structured logging, correlating events across services (e.g., "drawing submitted in collection service -> training job started in admin service -> model trained in Python worker -> model loaded in inference service") requires manually matching timestamps and free-text patterns. With structured fields like `{ "service": "collection", "requestId": "abc", "drawingId": "xyz", "shape": "circle" }`, operators can query by drawing ID to trace its lifecycle from submission through training to inference.

**How it works here:** The logger in `backend/src/shared/logger.ts` uses Pino with JSON output. Each service instance includes a `service` field (`collection`, `admin`, or `inference`) in every log entry. Request middleware generates a unique `requestId` and creates a child logger that inherits it. Drawing submissions log `drawingId`, `shape`, and `processingTimeMs`. Training job operations log `jobId`, `status`, and `config`. Inference requests log `modelVersion`, `predictedShape`, and `inferenceTimeMs`. The Python training worker uses Python's `logging` module with JSON formatting to maintain the same structured approach.

### Prometheus Metrics

**What it is:** Prometheus is a pull-based monitoring system that scrapes metric values from HTTP endpoints at regular intervals. Applications expose a `/metrics` endpoint with time-series data. Metrics are counters (monotonically increasing), gauges (point-in-time values), or histograms (value distributions).

**Why Scale AI needs it:** A data labeling platform has unique monitoring needs beyond standard web application metrics. Collection throughput (drawings per second per shape) determines whether the dataset is growing fast enough for training. Inference latency (p99 < 100ms) directly affects the implementor experience. Training job success rate reveals infrastructure problems. Circuit breaker state across three dependencies (PostgreSQL, MinIO, RabbitMQ) indicates which services need attention. Without metrics, operators would not know if the collection service is quietly dropping drawings, if inference latency has doubled due to a model update, or if the RabbitMQ circuit breaker has been open for an hour.

**How it works here:** Each microservice exposes its own `/metrics` endpoint. The `backend/src/shared/metrics.ts` module registers shared metrics: `http_requests_total` and `http_request_duration_seconds` (standard request monitoring), plus service-specific metrics. Collection service: `drawings_total` (counter by shape and status). Inference service: `inference_requests_total` (counter by model version and predicted shape), `inference_latency_seconds` (histogram by model version), `generation_requests_total` (counter by shape). All services: `external_service_calls_total` (counter by service/operation/status for dependency monitoring), `circuit_breaker_state` (gauge per dependency).

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make within a time window. When exceeded, the server returns HTTP 429 (Too Many Requests). Limits are tracked per IP or per user using atomic counters with TTL-based expiration.

**Why Scale AI needs it:** The drawing collection endpoint is public and accepts anonymous submissions. Without rate limiting, a bot could submit millions of junk drawings, polluting the training dataset and consuming MinIO storage. Even well-intentioned users could accidentally submit duplicates by double-clicking the "Done!" button or by a script with a retry loop. The inference endpoint is also public, and without rate limiting, it could be used as a free ML inference API by third parties. Rate limiting on drawing submissions also ensures that the quality of the dataset remains high -- genuine human drawings take 3-10 seconds each, so a rate of more than 1 drawing per second from a single IP is almost certainly automated.

**How it works here:** Rate limiting is configurable per service. The collection service limits drawing submissions per IP. The admin API limits requests to authenticated admin sessions only. The inference API limits requests per IP. All rate limits use Redis-backed counters. Drawing submissions have an additional idempotency layer that prevents the same drawing (identified by `sessionId:shapeId:timestamp`) from being stored twice, even if rate limiting allows the retry through.

### Idempotency

**What it is:** Idempotency ensures that performing the same operation multiple times produces the same result as performing it once. For APIs, this means that retried requests do not create duplicate resources, increment counters twice, or trigger side effects multiple times.

**Why Scale AI needs it:** Drawing submissions involve two non-transactional writes: storing stroke data in MinIO (object storage) and creating a metadata row in PostgreSQL. If the MinIO write succeeds but the PostgreSQL write fails (or vice versa), a retry would create a duplicate in one system. Additionally, the "Done!" button on the canvas could be double-clicked, or the browser could automatically retry a failed POST. Each duplicate drawing pollutes the training dataset and wastes storage. At production scale with 20M drawings per day, even a 0.1% duplication rate means 20,000 junk entries daily.

**How it works here:** The idempotency middleware in `backend/src/shared/idempotency.ts` generates a key from `sessionId:shapeId:timestamp`. Before processing a drawing submission, it checks Redis for this key. If found (within the 1-hour TTL window), it returns the cached response immediately. If not found, it processes the submission and caches the response. The timestamp granularity is seconds, so two legitimate drawings of the same shape within the same second from the same user are treated as duplicates -- this is acceptable because genuine drawings take 3-10 seconds minimum.

### Health Checks

**What it is:** Health check endpoints report whether an application instance can serve traffic. Load balancers use them to route traffic away from unhealthy instances. Container orchestrators use them to restart failed containers. Monitoring systems use them to trigger alerts.

**Why Scale AI needs it:** With three separate microservices (collection on 3001, admin on 3002, inference on 3003), health checks serve double duty. First, they enable individual service monitoring -- if the collection service loses its MinIO connection, it should report unhealthy independently of the admin service. Second, they enable dependency-aware routing -- if PostgreSQL is down, both collection and admin services should report unhealthy, but the inference service (which loads model info from the database only on startup and caches it) might remain healthy. The three-tier model (live/ready/deep) allows different consumers to check appropriate depth.

**How it works here:** The health check module in `backend/src/shared/healthCheck.ts` provides three endpoints per service: `/health` (basic liveness -- returns 200 if the process is running), `/health/live` (same as `/health`, used as Kubernetes liveness probe), and `/health/ready` (checks PostgreSQL, Redis, and MinIO connectivity; includes circuit breaker state in the response). Each service registers these endpoints. The readiness check returns 503 with a JSON body listing which dependencies are down, enabling operators to quickly identify the root cause of service degradation.

## Implementation Notes

This section documents the actual local development setup and maps production design decisions to the working implementation.

### Local Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Web Browser (React)                     │
│   Drawing Game │ Admin Portal │ Implementor Portal       │
│                   Port 5173                              │
└────────┬──────────────┬──────────────────┬───────────────┘
         │              │                  │
         ▼              ▼                  ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────────┐
│ Collection  │ │   Admin     │ │   Inference     │
│ Service     │ │   Service   │ │   Service       │
│ Port 3001   │ │   Port 3002 │ │   Port 3003     │
└──────┬──────┘ └──────┬──────┘ └──────┬──────────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
    ┌──────────────────┼──────────────────────┐
    │         ┌────────┼────────┐             │
    ▼         ▼        ▼        ▼             ▼
┌──────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│Redis │ │MinIO │ │PostgreSQL│ │ RabbitMQ │ │ Training │
│:6379 │ │:9000 │ │  :5432   │ │  :5672   │ │ Worker   │
└──────┘ └──────┘ └──────────┘ └──────────┘ │ (Python) │
                                             └──────────┘
```

Three separate Express microservices run independently on different ports. All infrastructure runs via Docker Compose, including a Python training worker that consumes jobs from RabbitMQ. The frontend uses hash-based routing (`/`, `#admin`, `#implement`) to switch between portals.

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Microservice decomposition | `backend/src/collection/`, `admin/`, `inference/` | Three independent Express services with separate entry points |
| Idempotency middleware | `backend/src/shared/idempotency.ts` | Redis-backed dedup for drawing submissions; prevents duplicates from retries and double-clicks |
| Circuit breakers | `backend/src/shared/circuitBreaker.ts` | Wraps PostgreSQL and MinIO calls; fails fast when dependencies are unhealthy; returns 503 with Retry-After |
| Retry with exponential backoff | `backend/src/shared/retry.ts` | Configurable retry presets for MinIO, PostgreSQL, and RabbitMQ operations |
| Prometheus metrics (prom-client) | `backend/src/shared/metrics.ts` | HTTP requests, inference latency, generation latency, external service calls, circuit breaker state |
| Structured logging (Pino) | `backend/src/shared/logger.ts` | JSON logs with service name, request IDs, child loggers for request context |
| Health checks (3-tier) | `backend/src/shared/healthCheck.ts` | `/health`, `/health/live`, `/health/ready` with dependency status and circuit breaker state |
| Session-based admin auth | `backend/src/shared/auth.ts` | Redis-backed sessions with httpOnly cookies for admin portal |
| Data lifecycle cleanup | `backend/src/shared/cleanup.ts` | Scheduled job: permanently deletes soft-deleted drawings after 30 days, archives flagged after 90 days |
| Quality scoring | `backend/src/shared/quality.ts` | Automated quality assessment of drawings |
| Training job queue | `backend/src/shared/queue.ts` | RabbitMQ publish/consume for training jobs between admin service and Python worker |
| Object storage abstraction | `backend/src/shared/storage.ts` | MinIO client for drawing uploads and model storage, bucket management |
| Database transactions | `backend/src/shared/db.ts` | `withTransaction()` helper for multi-step operations |
| Redis caching | `backend/src/shared/cache.ts` | Dashboard stats cache, session storage with configurable TTL |
| Soft deletes | `backend/src/db/init.sql` | `deleted_at` column on drawings for trash/restore functionality |
| Prototype-based generation | `backend/src/shared/prototype.ts` | Generates shapes from trained prototype data with variation |
| Heuristic classifier | `backend/src/inference/index.ts` | Placeholder inference using stroke analysis (bounding box, aspect ratio, stroke count) |
| Python training worker | `training/worker.py` | Consumes RabbitMQ jobs, trains PyTorch CNN, saves models to MinIO |
| Vitest test suite | `backend/src/collection/app.test.ts` | Unit tests with mocked shared modules |
| Graceful shutdown | All service entry points | SIGTERM/SIGINT handlers clean up resources |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| S3 multi-region | MinIO single instance (Docker) | No replication; single point of failure |
| Redis Cluster | Single Valkey instance (Docker) | No partitioning |
| PostgreSQL primary + replicas | Single PostgreSQL instance (Docker) | No read replicas |
| GPU-accelerated training | CPU training on local machine | Slower training; sufficient for 5 shapes |
| Real ML inference model | Heuristic-based stroke analysis | Proves API contract; low accuracy |
| API Gateway / Load Balancer | Direct connection to individual services | No unified entry point; each service on its own port |
| Pre-signed URLs for upload | API-proxied uploads | Higher API server load |
| OAuth / social login | Anonymous sessions (auto-generated) | No real user identity |
| Storage tiering (hot/warm/cold) | Single MinIO bucket | No lifecycle management |
| Distributed training | Single-process PyTorch | No data parallelism |

### What Was Omitted

- API Gateway / unified load balancer across microservices
- CDN for static assets
- Kubernetes orchestration
- Database sharding
- Multi-region deployment
- Pre-signed URLs for direct-to-storage uploads
- Distributed / GPU training
- Real-time WebSocket streaming of drawing strokes
- TensorFlow.js in-browser inference
- Model A/B testing framework
- Data augmentation pipeline (separate from training)
- Batch inference API
- Model quantization / optimization
- End-to-end integration tests
- Client-side stroke simplification / compression
