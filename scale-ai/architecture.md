# Scale AI - Data Labeling & ML Training Platform

## Overview

A crowdsourced data collection platform for training machine learning models. Users contribute labeled drawing data through a simple game interface, administrators manage the dataset and trigger model training, and implementors use the trained model for inference.

## Core Requirements

### Functional Requirements

**Data Collection Portal (End Users)**
- Draw shapes on a canvas (line, heart, circle, square, triangle)
- Touch and mouse input support
- Clear visual feedback and instructions
- Session tracking (anonymous or authenticated)
- Gamification elements (progress, streaks)

**Admin Portal**
- View collected data statistics (count per shape, quality metrics)
- Browse and filter individual submissions
- Flag/remove low-quality data
- Trigger model training jobs
- Monitor training progress and model performance
- Compare model versions

**Implementor Portal**
- Load trained model
- Request shape generation/recognition
- Test model with custom inputs
- View inference latency and confidence scores

### Non-Functional Requirements

- Handle 10,000+ concurrent users drawing
- Store millions of drawing samples efficiently
- Training jobs complete within reasonable time
- Model inference < 100ms latency
- All portals run locally for development

## Scale Estimates

| Metric | Estimate |
|--------|----------|
| Concurrent users | 10,000 |
| Drawings per user per session | 10-50 |
| Drawing data size | ~5-50KB per drawing (stroke data) |
| Total drawings (1 month) | 10M+ |
| Storage (1 month) | 100GB - 500GB |
| Training job frequency | Daily or on-demand |
| Model inference QPS | 1,000+ |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND LAYER                                  │
├─────────────────┬─────────────────────┬─────────────────────────────────────┤
│  Drawing Game   │    Admin Portal     │         Implementor Portal          │
│  (React + Canvas)│   (React + Charts) │        (React + Canvas)             │
└────────┬────────┴──────────┬──────────┴──────────────────┬──────────────────┘
         │                   │                              │
         ▼                   ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API GATEWAY                                     │
│                    (Load Balancer / Rate Limiting)                          │
└────────┬────────────────────┬─────────────────────────────┬─────────────────┘
         │                    │                              │
         ▼                    ▼                              ▼
┌─────────────────┐  ┌─────────────────┐           ┌─────────────────┐
│  Collection     │  │  Admin          │           │  Inference      │
│  Service        │  │  Service        │           │  Service        │
│  (Express)      │  │  (Express)      │           │  (Express/Py)   │
└────────┬────────┘  └────────┬────────┘           └────────┬────────┘
         │                    │                              │
         ▼                    │                              │
┌─────────────────┐           │                              │
│  Message Queue  │◄──────────┘                              │
│  (RabbitMQ)     │                                          │
└────────┬────────┘                                          │
         │                                                   │
         ▼                                                   │
┌─────────────────┐                                          │
│  Training       │                                          │
│  Worker         │                                          │
│  (Python)       │                                          │
└────────┬────────┘                                          │
         │                                                   │
         ▼                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATA LAYER                                      │
├─────────────────┬─────────────────────┬─────────────────────────────────────┤
│   PostgreSQL    │    Object Storage   │         Model Registry              │
│   (Metadata)    │    (Drawing Data)   │         (Trained Models)            │
└─────────────────┴─────────────────────┴─────────────────────────────────────┘
```

## Data Model

### PostgreSQL Schema

```sql
-- Users (optional, can be anonymous)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP DEFAULT NOW(),
    total_drawings INT DEFAULT 0
);

-- Shape definitions
CREATE TABLE shapes (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,  -- 'line', 'heart', 'circle', 'square', 'triangle'
    description TEXT,
    difficulty INT DEFAULT 1
);

-- Drawing submissions
CREATE TABLE drawings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    shape_id INT REFERENCES shapes(id),
    stroke_data_path VARCHAR(500),  -- Path to object storage
    metadata JSONB,  -- canvas size, duration, stroke count
    quality_score FLOAT,  -- 0-1, computed or admin-assigned
    is_flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Training jobs
CREATE TABLE training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) DEFAULT 'pending',  -- pending, running, completed, failed
    config JSONB,  -- hyperparameters, data filters
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    metrics JSONB,  -- accuracy, loss, etc.
    model_path VARCHAR(500),
    created_by UUID REFERENCES users(id)
);

-- Model versions
CREATE TABLE models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    training_job_id UUID REFERENCES training_jobs(id),
    version VARCHAR(50),
    is_active BOOLEAN DEFAULT FALSE,
    accuracy FLOAT,
    model_path VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_drawings_shape ON drawings(shape_id);
CREATE INDEX idx_drawings_created ON drawings(created_at);
CREATE INDEX idx_drawings_quality ON drawings(quality_score);
```

### Drawing Data Format (Stored in Object Storage)

```json
{
  "id": "uuid",
  "shape": "circle",
  "canvas": {
    "width": 400,
    "height": 400
  },
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
  "device": "mouse|touch",
  "user_agent": "..."
}
```

## Component Deep Dives

### Drawing Collection Service

**Responsibilities:**
- Receive drawing submissions via WebSocket or REST
- Validate and sanitize input data
- Store stroke data in object storage
- Create metadata record in PostgreSQL
- Optional: Real-time quality scoring

**API Endpoints:**
```
POST /api/drawings          # Submit a completed drawing
GET  /api/shapes            # Get list of available shapes
GET  /api/user/stats        # Get user's drawing statistics
WS   /ws/drawing            # Real-time stroke streaming (optional)
```

**Design Considerations:**
- Batch writes to reduce DB load
- Pre-signed URLs for direct object storage upload
- Client-side stroke simplification to reduce data size

### Admin Service

**Responsibilities:**
- Aggregate statistics across all drawings
- Provide data browsing and filtering
- Manage training job lifecycle
- Model comparison and deployment

**API Endpoints:**
```
GET  /api/admin/stats                    # Dashboard statistics
GET  /api/admin/drawings                 # Paginated drawing list
POST /api/admin/drawings/:id/flag        # Flag low-quality data
POST /api/admin/training/start           # Trigger training job
GET  /api/admin/training/:id             # Training job status
GET  /api/admin/models                   # List trained models
POST /api/admin/models/:id/activate      # Set active model
```

### Training Worker

**Responsibilities:**
- Poll for pending training jobs
- Fetch training data from storage
- Train ML model (CNN for shape recognition)
- Save model to registry
- Report metrics back to admin service

**Training Pipeline:**
```python
# Simplified training flow
1. Fetch drawings from object storage (filtered by job config)
2. Preprocess: Convert stroke data to images
3. Augment: Rotation, scaling, noise
4. Train: CNN model (e.g., MobileNet, custom small net)
5. Evaluate: Accuracy, confusion matrix
6. Save: Model to registry, metrics to DB
```

### Inference Service

**Responsibilities:**
- Load active model
- Accept drawing input
- Return classification with confidence
- Optional: Generate shapes based on prompts

**API Endpoints:**
```
POST /api/inference/classify    # Classify a drawing
POST /api/inference/generate    # Generate a shape (if generative model)
GET  /api/inference/model/info  # Current model info
```

## Key Technical Decisions

### Drawing Data Storage

**Option 1: Store as image (PNG/SVG)**
- Pros: Easy to use with standard ML pipelines
- Cons: Loses temporal/pressure data, larger storage

**Option 2: Store as stroke data (JSON)**
- Pros: Compact, preserves all information, can render to image
- Cons: Requires preprocessing for training

**Recommendation:** Store stroke data (JSON) in object storage, render to images at training time. This preserves maximum information and enables future use cases (e.g., stroke-based models).

### Real-time vs Batch Submission

**Option 1: WebSocket streaming**
- Pros: Can show real-time feedback, partial saves
- Cons: More complex, higher server load

**Option 2: Submit on completion**
- Pros: Simpler, lower load, easier batching
- Cons: Lost data if user leaves mid-drawing

**Recommendation:** Start with submit-on-completion (simpler), add WebSocket streaming later if needed.

### ML Framework

**For local development:**
- TensorFlow.js (runs in browser for quick testing)
- PyTorch (training worker)

**Model architecture for shape recognition:**
- Small CNN (few layers, optimized for speed)
- Input: 64x64 or 128x128 grayscale images
- Output: Softmax over shape classes

### Object Storage (Local Dev)

**Options:**
- MinIO (S3-compatible, Docker-friendly)
- Local filesystem with path-based storage
- PostgreSQL BYTEA (for small-scale testing)

**Recommendation:** MinIO for realistic S3-like behavior, fallback to filesystem for simplicity.

## Scaling Considerations

### Data Collection at Scale

```
Problem: 10K concurrent users submitting drawings

Solutions:
1. Horizontal scaling of collection service
2. Message queue for async processing
3. Client-side batching (submit multiple drawings at once)
4. Pre-signed URLs for direct-to-storage uploads
```

### Training Large Datasets

```
Problem: Training on millions of drawings

Solutions:
1. Streaming data loader (don't load all into memory)
2. Distributed training (multiple GPUs/workers)
3. Incremental training (fine-tune on new data)
4. Data sampling (train on representative subset)
```

### Model Serving

```
Problem: Low-latency inference at scale

Solutions:
1. Model optimization (quantization, pruning)
2. Batch inference
3. Edge deployment (TensorFlow.js in browser)
4. Model caching (keep warm in memory)
```

## Local Development Setup

```bash
# Start infrastructure
docker-compose up -d  # PostgreSQL, MinIO, RabbitMQ

# Run services on different ports
npm run dev:collection  # Port 3001
npm run dev:admin       # Port 3002
npm run dev:inference   # Port 3003

# Run training worker
python training/worker.py

# Frontend (all portals)
cd frontend && npm run dev  # Port 5173
```

## Security Considerations

- Rate limiting on drawing submissions (prevent spam)
- Admin portal authentication required
- Validate drawing data format and size limits
- Sanitize user inputs (prevent injection)
- CORS configuration for API endpoints

## Monitoring & Observability

**Metrics to track:**
- Drawings submitted per minute
- Drawing size distribution
- Quality score distribution
- Training job duration and success rate
- Model accuracy over time
- Inference latency percentiles

**Logging:**
- Structured JSON logs
- Request tracing (correlation IDs)
- Training job progress logs

## Consistency and Idempotency Semantics

### Write Consistency Model

| Operation | Consistency Level | Rationale |
|-----------|------------------|-----------|
| Drawing submission | Eventual | Loss of a single drawing is acceptable; high write throughput is critical |
| Training job creation | Strong | Must guarantee exactly-once job creation to avoid duplicate training runs |
| Model activation | Strong | Active model state must be immediately consistent across all inference instances |
| User stats update | Eventual | Can be reconciled asynchronously via background job |

**Drawing Submissions (Eventual Consistency):**
- Writes to PostgreSQL and MinIO are not transactional
- If MinIO write succeeds but PostgreSQL fails, orphan detection job cleans up hourly
- If PostgreSQL write succeeds but MinIO fails, the `drawings` row has null `stroke_data_path` and is excluded from training

**Training Jobs (Strong Consistency):**
- Uses PostgreSQL transaction with `SELECT ... FOR UPDATE` on job creation
- Job ID is UUID generated server-side, preventing duplicate job creation on retry

### Idempotency Implementation

**Drawing Submissions:**
```typescript
// Client generates idempotency key before submission
const idempotencyKey = `${sessionId}:${shapeId}:${Date.now()}`;

// Server checks Redis before processing
const exists = await redis.get(`idem:drawing:${idempotencyKey}`);
if (exists) return { status: 'already_processed', drawingId: exists };

// After successful save, mark as processed with 1-hour TTL
await redis.setex(`idem:drawing:${idempotencyKey}`, 3600, drawingId);
```

**Training Job Triggers:**
```typescript
// Admin clicks "Start Training" - use job config hash as idempotency key
const configHash = crypto.createHash('sha256').update(JSON.stringify(jobConfig)).digest('hex');
const idempotencyKey = `training:${configHash}:${new Date().toISOString().slice(0,10)}`;

// Check for existing pending/running job with same config from today
const existing = await db.query(`
  SELECT id FROM training_jobs
  WHERE status IN ('pending', 'running')
    AND config_hash = $1
    AND created_at > NOW() - INTERVAL '24 hours'
`, [configHash]);
if (existing.rows.length > 0) return { jobId: existing.rows[0].id, status: 'already_exists' };
```

### Conflict Resolution

**Concurrent Drawing Submissions:**
- No conflicts possible: each drawing gets a unique UUID, no updates to existing records
- Quality score updates use last-write-wins (admin override is final)

**Model Activation Race:**
```sql
-- Atomic model activation (only one active model at a time)
BEGIN;
UPDATE models SET is_active = FALSE WHERE is_active = TRUE;
UPDATE models SET is_active = TRUE WHERE id = $1;
COMMIT;
```

**Replay Handling:**
- Drawing submissions: Safe to replay due to idempotency keys
- Training jobs: Config hash prevents duplicate training on same data
- Model activation: Idempotent by nature (activating already-active model is no-op)

## Failure Handling

### Retry Strategies

| Component | Retry Policy | Backoff | Max Attempts |
|-----------|-------------|---------|--------------|
| MinIO uploads | Exponential | 100ms, 200ms, 400ms, 800ms | 4 |
| PostgreSQL writes | Exponential | 50ms, 100ms, 200ms | 3 |
| RabbitMQ publish | Exponential | 500ms, 1s, 2s, 4s | 5 |
| Training data fetch | Linear | 1s between attempts | 3 |

**Collection Service - Drawing Upload:**
```typescript
async function saveDrawing(drawing: DrawingData, idempotencyKey: string): Promise<string> {
  // Check idempotency first
  const cached = await redis.get(`idem:drawing:${idempotencyKey}`);
  if (cached) return cached;

  let minioPath: string | null = null;

  // Retry MinIO upload with exponential backoff
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      minioPath = await minio.putObject(bucket, `drawings/${drawing.id}.json`, JSON.stringify(drawing));
      break;
    } catch (err) {
      if (attempt === 3) throw new Error('MinIO upload failed after retries');
      await sleep(100 * Math.pow(2, attempt));
    }
  }

  // PostgreSQL insert (separate retry loop)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.query(`INSERT INTO drawings (id, shape_id, stroke_data_path, ...) VALUES ($1, $2, $3, ...)`,
        [drawing.id, drawing.shapeId, minioPath]);
      break;
    } catch (err) {
      if (attempt === 2) {
        // Log for orphan cleanup job, but don't fail the request
        console.error('DB insert failed, MinIO object is orphaned:', minioPath);
        throw err;
      }
      await sleep(50 * Math.pow(2, attempt));
    }
  }

  await redis.setex(`idem:drawing:${idempotencyKey}`, 3600, drawing.id);
  return drawing.id;
}
```

### Circuit Breaker Pattern

**Implementation for External Dependencies (Local Dev):**
```typescript
// Simple circuit breaker for learning purposes
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,      // Open after 5 failures
    private resetTimeout: number = 30000 // Try again after 30s
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}

// Usage
const minioBreaker = new CircuitBreaker(5, 30000);
const result = await minioBreaker.call(() => minio.putObject(...));
```

**Circuit Breaker Configuration:**
| Service | Failure Threshold | Reset Timeout | Fallback Behavior |
|---------|------------------|---------------|-------------------|
| MinIO | 5 failures | 30s | Return 503, client retries later |
| PostgreSQL | 3 failures | 15s | Return 503, queue in memory (short-term) |
| RabbitMQ | 5 failures | 60s | Write to dead-letter table in PostgreSQL |
| Training Worker | 2 failures | 120s | Mark job as 'failed', notify admin |

### Disaster Recovery (Local Development Context)

For a local learning project, DR focuses on data protection and quick recovery:

**Backup Strategy:**
```bash
# PostgreSQL: Daily logical backup (cron job or manual)
pg_dump -h localhost -U user scale_ai > backup_$(date +%Y%m%d).sql

# MinIO: Sync to local backup directory
mc mirror local/drawings ./backups/minio/drawings/

# Combined backup script (run before major changes)
#!/bin/bash
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
pg_dump -h localhost -U user scale_ai > "$BACKUP_DIR/postgres.sql"
mc mirror local/drawings "$BACKUP_DIR/minio/"
echo "Backup complete: $BACKUP_DIR"
```

**Restore Procedure:**
```bash
# 1. Stop all services
docker-compose down

# 2. Restore PostgreSQL
docker-compose up -d postgres
psql -h localhost -U user -d scale_ai < backup_20240115.sql

# 3. Restore MinIO
docker-compose up -d minio
mc mirror ./backups/minio/drawings/ local/drawings/

# 4. Restart all services
docker-compose up -d
```

**Backup Testing Checklist (Monthly):**
- [ ] Restore PostgreSQL backup to a test database
- [ ] Verify row counts match: `SELECT COUNT(*) FROM drawings`
- [ ] Restore random MinIO objects and verify JSON validity
- [ ] Run inference on restored model to verify functionality
- [ ] Document restore time and any issues encountered

### Failure Scenarios and Responses

| Failure | Detection | Response | Recovery |
|---------|-----------|----------|----------|
| MinIO down | Circuit breaker trips | Return 503, log to file | Retry after reset timeout |
| PostgreSQL down | Connection timeout | Return 503, queue minimal data in Redis | Drain Redis queue on recovery |
| RabbitMQ down | Publish fails | Write to `dead_letter_jobs` table | Background job replays on recovery |
| Training worker crash | Job timeout (30min) | Mark job as 'failed' | Admin manually restarts job |
| Model file corrupted | Inference throws error | Fall back to previous model version | Re-run training job |

## Data Lifecycle Policies

### Retention Policies

| Data Type | Hot Storage | Warm Storage | Cold/Archive | Deletion |
|-----------|-------------|--------------|--------------|----------|
| Drawings (stroke JSON) | 30 days | 30-180 days | 180+ days | Never (training data) |
| Drawing metadata (PostgreSQL) | Indefinite | N/A | N/A | Never |
| Training jobs | Indefinite | N/A | N/A | Completed jobs > 1 year: archive |
| Model files | Active + last 5 versions | Older versions | N/A | After 2 years if unused |
| User sessions | 7 days | N/A | N/A | Auto-expire |
| Inference logs | 7 days | 7-30 days | N/A | 30 days |

### TTL Implementation

**Redis Keys:**
```typescript
// Session data: 7 days
await redis.setex(`session:${sessionId}`, 7 * 24 * 3600, sessionData);

// Idempotency keys: 1 hour (enough to handle retries)
await redis.setex(`idem:drawing:${key}`, 3600, drawingId);

// Cached stats: 5 minutes
await redis.setex('stats:dashboard', 300, JSON.stringify(stats));

// Rate limit counters: 1 minute window
await redis.setex(`ratelimit:${ip}`, 60, count);
```

**PostgreSQL Cleanup Jobs:**
```sql
-- Run daily: Archive old inference logs
INSERT INTO inference_logs_archive
SELECT * FROM inference_logs WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM inference_logs WHERE created_at < NOW() - INTERVAL '30 days';

-- Run weekly: Clean up orphaned drawings (MinIO exists, DB doesn't)
-- Implemented as a Node.js script that lists MinIO objects and checks DB
```

### Storage Tiering (Local Dev Simulation)

For learning purposes, simulate tiering with different MinIO buckets:

```yaml
# docker-compose.yml buckets represent tiers
# In production: S3 Standard → S3 Infrequent Access → S3 Glacier

# Local simulation:
# - drawings-hot/    : Recent 30 days, fast access
# - drawings-warm/   : 30-180 days, still accessible
# - drawings-archive/: 180+ days, compressed JSON
```

**Tiering Job (Background Worker):**
```typescript
// Run daily at 2 AM
async function tieringJob() {
  // Move drawings older than 30 days from hot to warm
  const hotToWarm = await db.query(`
    SELECT id, stroke_data_path FROM drawings
    WHERE created_at < NOW() - INTERVAL '30 days'
      AND stroke_data_path LIKE 'drawings-hot/%'
  `);

  for (const row of hotToWarm.rows) {
    const data = await minio.getObject('drawings-hot', row.id + '.json');
    await minio.putObject('drawings-warm', row.id + '.json', data);
    await minio.removeObject('drawings-hot', row.id + '.json');
    await db.query(`UPDATE drawings SET stroke_data_path = $1 WHERE id = $2`,
      [`drawings-warm/${row.id}.json`, row.id]);
  }

  // Move drawings older than 180 days from warm to archive (compressed)
  const warmToArchive = await db.query(`
    SELECT id, stroke_data_path FROM drawings
    WHERE created_at < NOW() - INTERVAL '180 days'
      AND stroke_data_path LIKE 'drawings-warm/%'
  `);

  for (const row of warmToArchive.rows) {
    const data = await minio.getObject('drawings-warm', row.id + '.json');
    const compressed = zlib.gzipSync(data);
    await minio.putObject('drawings-archive', row.id + '.json.gz', compressed);
    await minio.removeObject('drawings-warm', row.id + '.json');
    await db.query(`UPDATE drawings SET stroke_data_path = $1 WHERE id = $2`,
      [`drawings-archive/${row.id}.json.gz`, row.id]);
  }
}
```

### Backfill and Replay Procedures

**Scenario 1: Reprocess All Drawings with New Quality Scoring Algorithm**
```bash
# 1. Create backfill job in admin UI or via API
POST /api/admin/backfill
{
  "type": "quality_rescore",
  "filter": { "created_after": "2024-01-01" },
  "batch_size": 1000
}

# 2. Worker processes in batches
# - Fetches drawings in chunks of 1000
# - Applies new scoring algorithm
# - Updates quality_score in PostgreSQL
# - Logs progress to backfill_jobs table
```

**Scenario 2: Replay Failed Training Job with Fixed Data**
```typescript
// Admin UI: "Replay Training Job" button
async function replayTrainingJob(originalJobId: string) {
  const original = await db.query(`SELECT config FROM training_jobs WHERE id = $1`, [originalJobId]);

  // Create new job with same config but updated timestamp
  const newJob = await db.query(`
    INSERT INTO training_jobs (config, status, replay_of)
    VALUES ($1, 'pending', $2)
    RETURNING id
  `, [original.rows[0].config, originalJobId]);

  // Publish to RabbitMQ
  await rabbit.publish('training_jobs', { jobId: newJob.rows[0].id });

  return newJob.rows[0].id;
}
```

**Scenario 3: Backfill Missing MinIO Objects from Backup**
```bash
#!/bin/bash
# Compare MinIO objects with PostgreSQL records, restore missing from backup

# 1. Get list of expected objects from PostgreSQL
psql -h localhost -U user -d scale_ai -t -c \
  "SELECT stroke_data_path FROM drawings WHERE stroke_data_path IS NOT NULL" \
  > expected_objects.txt

# 2. Get list of actual objects in MinIO
mc ls --recursive local/drawings | awk '{print $NF}' > actual_objects.txt

# 3. Find missing objects
comm -23 <(sort expected_objects.txt) <(sort actual_objects.txt) > missing_objects.txt

# 4. Restore from backup
while read object; do
  if [ -f "./backups/minio/$object" ]; then
    mc cp "./backups/minio/$object" "local/$object"
    echo "Restored: $object"
  else
    echo "MISSING FROM BACKUP: $object"
  fi
done < missing_objects.txt
```

**Backfill Job Tracking:**
```sql
-- Track backfill job progress
CREATE TABLE backfill_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(50) NOT NULL,  -- 'quality_rescore', 'tier_migration', 'replay'
    status VARCHAR(50) DEFAULT 'pending',
    total_items INT,
    processed_items INT DEFAULT 0,
    failed_items INT DEFAULT 0,
    config JSONB,
    error_log JSONB,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

## Implementation Notes

This section documents the reliability and observability patterns implemented in the backend services, explaining the rationale behind each design decision.

### Idempotency Middleware

**What it does:** Prevents duplicate submissions by tracking processed requests in Redis with TTL-based keys.

**Why it matters:**
- **Network failures cause retries:** When a client submits a drawing but doesn't receive a response (network timeout, server restart), it will retry. Without idempotency, this creates duplicate drawings in the database.
- **User double-clicks:** Users may accidentally click "Submit" multiple times before the UI disables the button.
- **Client-side retry logic:** Modern HTTP clients (Axios, fetch with retry) automatically retry on network errors.

**How it works:**
1. Client sends request with `X-Idempotency-Key` header (or one is generated from request body hash)
2. Middleware checks Redis for existing response with that key
3. If found, returns cached response immediately (no re-processing)
4. If not found, marks as "processing" and forwards to handler
5. After handler completes, caches the response with configurable TTL (default: 1 hour)

**Trade-offs:**
- Requires Redis dependency (already in use for caching)
- Adds ~1-2ms latency per request for Redis check
- TTL must balance between catching retries (short enough) and not growing unbounded (long enough)

```typescript
// Usage in collection service
app.post('/api/drawings',
  idempotencyMiddleware('drawing', { ttlSeconds: 3600 }),
  async (req, res) => { ... }
)
```

### Circuit Breakers

**What it does:** Detects when external services (PostgreSQL, MinIO, RabbitMQ) are failing and "opens" to reject requests immediately, giving the service time to recover.

**Why it matters:**
- **Prevents cascade failures:** When MinIO is down, continuing to call it wastes resources, increases latency, and may exhaust connection pools. Circuit breakers fail fast with a clear error.
- **Enables graceful degradation:** When the circuit opens, the service returns HTTP 503 with `Retry-After` header, allowing load balancers and clients to retry intelligently.
- **Protects downstream services:** A struggling database doesn't need 10,000 new connections per second. Circuit breakers reduce load during recovery.

**How it works:**
1. **Closed state (normal):** All requests pass through. Failures are counted.
2. **Open state (failing):** After N consecutive failures, requests are rejected immediately without calling the service.
3. **Half-open state (testing):** After a reset timeout, a few requests are allowed through. If they succeed, the circuit closes. If they fail, it reopens.

**Configuration per service:**

| Service    | Failure Threshold | Reset Timeout | Rationale |
|------------|------------------|---------------|-----------|
| PostgreSQL | 3 failures       | 15 seconds    | Critical dependency, fast recovery detection |
| MinIO      | 5 failures       | 30 seconds    | More tolerant, object storage is async |
| RabbitMQ   | 5 failures       | 60 seconds    | Longer timeout, messages can queue in dead-letter table |

```typescript
// Usage with circuit breaker
const result = await minioCircuitBreaker.execute(async () => {
  return uploadDrawing(drawingId, strokeData)
})
```

### Retry Logic with Exponential Backoff

**What it does:** Automatically retries failed operations with increasing delays between attempts.

**Why it matters:**
- **Transient failures are common:** Network hiccups, brief resource contention, and temporary overloads resolve themselves quickly.
- **Exponential backoff prevents thundering herd:** If 1000 requests fail simultaneously and all retry after 1 second, you create a spike. Exponential delays spread retries over time.
- **Jitter prevents synchronized retries:** Adding randomness to delays prevents all clients from retrying at exactly the same moment.

**Retry presets:**

| Operation  | Max Retries | Initial Delay | Max Delay | Backoff |
|------------|------------|---------------|-----------|---------|
| MinIO      | 4          | 100ms         | 2000ms    | 2x      |
| PostgreSQL | 3          | 50ms          | 500ms     | 2x      |
| RabbitMQ   | 5          | 500ms         | 5000ms    | 2x      |

```typescript
// Example: Upload with retry
const result = await withRetry(
  () => minio.putObject(bucket, key, data),
  { maxRetries: 4, initialDelayMs: 100, operationName: 'minio-upload' }
)
```

### Structured Logging with Pino

**What it does:** Outputs JSON-formatted logs with consistent structure for log aggregation and analysis.

**Why it matters:**
- **Debuggability:** When investigating a bug, you can filter logs by `requestId`, `userId`, or `endpoint` to trace a single request across services.
- **Alerting:** Log aggregation tools (Loki, Elasticsearch, CloudWatch) can parse JSON logs and trigger alerts on error patterns.
- **Performance:** Pino is one of the fastest Node.js loggers, with minimal overhead even at high log volumes.

**Log structure:**
```json
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "collection",
  "requestId": "abc-123",
  "msg": "Drawing saved successfully",
  "drawingId": "uuid-...",
  "shape": "circle",
  "processingTimeMs": 45
}
```

**Child loggers for request context:**
```typescript
const reqLogger = createChildLogger({
  requestId: req.headers['x-request-id'],
  userId: session?.userId,
})
reqLogger.info({ msg: 'Processing request', endpoint: '/api/drawings' })
```

### Prometheus Metrics

**What it does:** Exposes a `/metrics` endpoint with Prometheus-formatted metrics for scraping.

**Why it matters:**
- **Visibility:** Metrics show request rates, error rates, latencies, and resource usage in real-time.
- **Alerting:** Set alerts on error rate > 1%, p99 latency > 500ms, or circuit breaker open.
- **Capacity planning:** Historical metrics show traffic patterns and help predict when to scale.

**Key metrics exposed:**

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_requests_total` | Counter | method, route, status_code | Request volume and success rate |
| `http_request_duration_seconds` | Histogram | method, route | Latency percentiles |
| `drawings_total` | Counter | shape, status | Business metric for drawing submissions |
| `external_service_calls_total` | Counter | service, operation, status | Dependency health |
| `circuit_breaker_state` | Gauge | service | 0=closed, 1=half-open, 2=open |

```
# Example /metrics output
http_requests_total{method="POST",route="/api/drawings",status_code="201"} 12345
http_request_duration_seconds_bucket{method="POST",route="/api/drawings",le="0.1"} 11000
drawings_total{shape="circle",status="success"} 3456
circuit_breaker_state{service="minio"} 0
```

### Health Check Endpoints

**What it does:** Provides `/health`, `/health/live`, and `/health/ready` endpoints for container orchestration.

**Why it matters:**
- **Container orchestration:** Kubernetes uses liveness probes to restart unhealthy containers and readiness probes to route traffic only to ready instances.
- **Load balancer integration:** Load balancers use health checks to remove unhealthy backends from rotation.
- **Debugging:** The full `/health` endpoint shows dependency status and circuit breaker states for troubleshooting.

**Endpoint semantics:**

| Endpoint | Purpose | Returns 200 when... |
|----------|---------|---------------------|
| `/health/live` | Liveness probe | Process is running (always 200) |
| `/health/ready` | Readiness probe | All dependencies are healthy |
| `/health` | Full status | Always (but body shows status details) |

```json
// GET /health response
{
  "status": "healthy",
  "service": "collection",
  "version": "0.1.0",
  "uptime": 3600,
  "dependencies": [
    { "name": "postgres", "status": "healthy", "latencyMs": 2 },
    { "name": "redis", "status": "healthy", "latencyMs": 1 },
    { "name": "minio", "status": "healthy", "latencyMs": 5 }
  ],
  "circuitBreakers": [
    { "name": "minio", "state": "closed", "failures": 0 }
  ]
}
```

### Data Lifecycle Management

**What it does:** Scheduled jobs clean up old data based on configurable retention policies.

**Why it matters:**
- **Storage cost control:** Without cleanup, storage grows indefinitely. Old flagged drawings waste space.
- **Performance:** Large tables slow down queries. Archiving old data keeps the hot dataset manageable.
- **Compliance:** Some data may need deletion after retention periods expire.

**Cleanup jobs:**

| Job | Retention | Action |
|-----|-----------|--------|
| Soft-deleted drawings | 30 days | Permanently delete (DB + MinIO) |
| Flagged drawings | 90 days | Soft-delete (archive) |
| Orphaned data | N/A | Detect MinIO objects without DB records or vice versa |

**Configuration via environment variables:**
```bash
CLEANUP_INTERVAL_HOURS=24          # How often to run cleanup
CLEANUP_DRY_RUN=false              # Set to true to log without deleting
SOFT_DELETE_RETENTION_DAYS=30     # Days before permanent deletion
FLAGGED_RETENTION_DAYS=90         # Days before flagged drawings are archived
```

**Manual cleanup trigger (admin API):**
```bash
POST /api/admin/cleanup/run
{ "dryRun": true, "batchSize": 100 }
```

### Summary: Defense in Depth

These patterns work together to create a resilient system:

1. **Idempotency** prevents duplicate data from client retries
2. **Retries** handle transient failures automatically
3. **Circuit breakers** prevent cascade failures when retries aren't enough
4. **Health checks** enable orchestrators to route around unhealthy instances
5. **Metrics** provide visibility into system health
6. **Structured logs** enable debugging when things go wrong
7. **Cleanup jobs** maintain system hygiene over time

Each pattern addresses a specific failure mode, and together they provide defense in depth against the inevitable failures of distributed systems.

## Future Enhancements

1. **Active Learning:** Prioritize collecting drawings for underperforming classes
2. **Quality Estimation:** Auto-score drawings based on similarity to known good examples
3. **Generative Models:** Train models to generate shapes (VAE, GAN)
4. **Multi-task Learning:** Train single model for recognition + generation
5. **Federated Learning:** Train on-device without centralizing data
6. **Gamification:** Leaderboards, achievements, challenges
