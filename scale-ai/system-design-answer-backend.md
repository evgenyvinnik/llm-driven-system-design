# Scale AI - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design a crowdsourced data labeling platform where users contribute training data through a drawing game, administrators manage datasets and trigger model training, and ML engineers use trained models for inference."

This is a **backend-focused problem** requiring expertise in:
- High-throughput data ingestion pipelines
- Object storage for large binary data
- Message queues for async job processing
- Database schema for ML training metadata
- Model versioning and serving

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- Receive and store drawing submissions (stroke data)
- Manage dataset with quality scoring and flagging
- Trigger and monitor model training jobs
- Serve trained models for inference
- Track model versions and performance metrics

### Non-Functional Requirements
- **Throughput**: 10K concurrent users submitting drawings
- **Storage**: 10M+ drawings per month (100-500GB)
- **Training**: Jobs complete in hours, not days
- **Inference**: Sub-100ms latency for predictions
- **Reliability**: No data loss for submitted drawings

### Backend-Specific Clarifications
- "How to store drawings?" - Stroke JSON in object storage, metadata in PostgreSQL
- "Training orchestration?" - RabbitMQ for job queue, Python worker consumes
- "Model serving?" - Load models into memory, warm inference
- "Failure handling?" - Circuit breakers, idempotency keys, retry with backoff

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                       FRONTEND LAYER                            │
│  Drawing Game (Canvas)  │  Admin Portal  │  Implementor Portal  │
└─────────────┬───────────┴───────┬────────┴──────────┬───────────┘
              │                   │                    │
              ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                   API GATEWAY / LOAD BALANCER                   │
└─────────────┬───────────────────┬────────────────────┬──────────┘
              │                   │                    │
              ▼                   ▼                    ▼
      ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
      │  Collection   │   │    Admin      │   │   Inference   │
      │   Service     │   │   Service     │   │    Service    │
      │    :3001      │   │    :3002      │   │     :3003     │
      └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
              │                   │                    │
              │                   ▼                    │
              │           ┌───────────────┐            │
              │           │   RabbitMQ    │            │
              │           │  (Job Queue)  │            │
              │           └───────┬───────┘            │
              │                   │                    │
              │                   ▼                    │
              │           ┌───────────────┐            │
              │           │   Training    │            │
              │           │    Worker     │            │
              │           │   (Python)    │            │
              │           └───────┬───────┘            │
              │                   │                    │
              ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                               │
├─────────────────┬─────────────────────┬─────────────────────────┤
│   PostgreSQL    │   MinIO (S3)        │       Redis             │
│   (Metadata)    │   (Drawings/Models) │       (Cache)           │
└─────────────────┴─────────────────────┴─────────────────────────┘
```

### Service Responsibilities

| Service | Responsibility | Scaling Pattern |
|---------|---------------|-----------------|
| Collection | Ingest drawings, store stroke data | Horizontal (stateless) |
| Admin | Dataset management, trigger training | Single instance OK |
| Inference | Model loading, prediction serving | Horizontal + warm models |
| Training Worker | Consume jobs, train PyTorch models | Scale with GPU workers |

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: Drawing Ingestion Pipeline (8 minutes)

**Challenge**: Handle 10K concurrent users submitting drawings without data loss.

**Data Flow**:

```
User Canvas → Collection Service → MinIO (stroke JSON) + PostgreSQL (metadata)
```

**Drawing Data Format** (stored in MinIO):

```json
{
  "id": "uuid",
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

**Why Stroke Data over Images**:
1. **Preserves information**: Temporal ordering, pressure, drawing speed
2. **Compact storage**: JSON is smaller than PNG for simple drawings
3. **Flexible rendering**: Generate any resolution at training time
4. **Future use cases**: Stroke-based models, animation generation

**Submission Handler with Reliability**:

```typescript
// backend/src/collection/routes/drawings.ts
async function submitDrawing(req: Request, res: Response) {
  const { shapeId, strokes, metadata } = req.body;
  const userId = req.session?.userId;

  // 1. Check idempotency key
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  if (idempotencyKey) {
    const existing = await redis.get(`idem:drawing:${idempotencyKey}`);
    if (existing) {
      return res.status(200).json({ id: existing, status: 'duplicate' });
    }
  }

  const drawingId = crypto.randomUUID();
  const storagePath = `drawings/${userId}/${drawingId}.json`;

  // 2. Upload to MinIO with circuit breaker
  await minioCircuitBreaker.execute(async () => {
    await storage.putObject(
      DRAWINGS_BUCKET,
      storagePath,
      JSON.stringify({ strokes, metadata, shapeId })
    );
  });

  // 3. Insert metadata to PostgreSQL
  await pool.query(`
    INSERT INTO drawings (id, user_id, shape_id, stroke_data_path, metadata)
    VALUES ($1, $2, $3, $4, $5)
  `, [drawingId, userId, shapeId, storagePath, metadata]);

  // 4. Update user stats (async, eventual consistency OK)
  await pool.query(`
    UPDATE users SET total_drawings = total_drawings + 1
    WHERE id = $1
  `, [userId]);

  // 5. Mark idempotency key processed
  if (idempotencyKey) {
    await redis.setex(`idem:drawing:${idempotencyKey}`, 3600, drawingId);
  }

  metrics.increment('drawings.submitted', { shape: shapeId });

  res.status(201).json({ id: drawingId });
}
```

**Failure Handling**:

| Failure | Detection | Response |
|---------|-----------|----------|
| MinIO down | Circuit breaker opens | 503 with Retry-After |
| PostgreSQL down | Connection timeout | Queue in Redis (short-term) |
| Partial failure | MinIO OK, DB fails | Orphan cleanup job |

---

### Deep Dive 2: Training Job Pipeline (8 minutes)

**Challenge**: Decouple training from web requests, ensure jobs complete reliably.

**Job Flow**:

```
Admin triggers → PostgreSQL (job record) → RabbitMQ → Training Worker → Model saved to MinIO
```

**Job Creation with Idempotency**:

```typescript
// backend/src/admin/routes/training.ts
async function startTrainingJob(req: Request, res: Response) {
  const { config } = req.body;

  // Generate idempotency key from config hash
  const configHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(config))
    .digest('hex');

  // Check for existing pending/running job with same config
  const existing = await pool.query(`
    SELECT id, status FROM training_jobs
    WHERE status IN ('pending', 'queued', 'running')
      AND config_hash = $1
      AND created_at > NOW() - INTERVAL '24 hours'
  `, [configHash]);

  if (existing.rows.length > 0) {
    return res.status(200).json({
      jobId: existing.rows[0].id,
      status: 'already_exists'
    });
  }

  // Create job record
  const result = await pool.query(`
    INSERT INTO training_jobs (config, config_hash, status, created_by)
    VALUES ($1, $2, 'pending', $3)
    RETURNING id
  `, [config, configHash, req.session.userId]);

  const jobId = result.rows[0].id;

  // Publish to RabbitMQ
  await rabbitChannel.publish(
    'training_exchange',
    'training.new',
    Buffer.from(JSON.stringify({ jobId, config })),
    { persistent: true }
  );

  // Update status to queued
  await pool.query(`
    UPDATE training_jobs SET status = 'queued' WHERE id = $1
  `, [jobId]);

  res.status(201).json({ jobId, status: 'queued' });
}
```

**Training Worker (Python)**:

```python
# training/worker.py
import pika
import json
import torch
from minio import Minio

def process_training_job(job_data):
    job_id = job_data['jobId']
    config = job_data['config']

    try:
        # Update status to running
        update_job_status(job_id, 'running')

        # 1. Fetch drawings from MinIO
        drawings = fetch_drawings(config.get('filters', {}))
        logger.info(f"Fetched {len(drawings)} drawings for job {job_id}")

        # 2. Preprocess: Convert stroke data to images
        images, labels = [], []
        for drawing in drawings:
            img = render_strokes_to_image(drawing['strokes'], size=128)
            images.append(img)
            labels.append(drawing['shape_id'])

        # 3. Create PyTorch dataset
        dataset = DrawingDataset(images, labels)
        train_loader = DataLoader(dataset, batch_size=32, shuffle=True)

        # 4. Train CNN model
        model = ShapeClassifier(num_classes=5)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        criterion = nn.CrossEntropyLoss()

        for epoch in range(config.get('epochs', 50)):
            train_epoch(model, train_loader, optimizer, criterion)
            update_job_progress(job_id, epoch, config['epochs'])

        # 5. Evaluate and save metrics
        accuracy = evaluate_model(model, validation_loader)

        # 6. Save model to MinIO
        model_path = f"models/{job_id}/model.pt"
        torch.save(model.state_dict(), '/tmp/model.pt')
        minio_client.fput_object(MODELS_BUCKET, model_path, '/tmp/model.pt')

        # 7. Create model version record
        create_model_version(job_id, model_path, accuracy)

        update_job_status(job_id, 'completed', metrics={'accuracy': accuracy})

    except Exception as e:
        logger.error(f"Training job {job_id} failed: {e}")
        update_job_status(job_id, 'failed', error_message=str(e))

# RabbitMQ consumer
connection = pika.BlockingConnection(pika.URLParameters(RABBITMQ_URL))
channel = connection.channel()
channel.queue_declare('training_jobs', durable=True)
channel.basic_consume('training_jobs', on_message_callback=process_message)
channel.start_consuming()
```

**Job Status Tracking**:

```sql
-- Training job states
CREATE TYPE job_status AS ENUM ('pending', 'queued', 'running', 'completed', 'failed');

CREATE TABLE training_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status job_status DEFAULT 'pending',
  config JSONB NOT NULL,
  config_hash VARCHAR(64) NOT NULL,
  progress FLOAT DEFAULT 0,
  metrics JSONB,
  error_message TEXT,
  model_path VARCHAR(500),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### Deep Dive 3: Model Serving for Inference (5 minutes)

**Challenge**: Sub-100ms inference latency with model version management.

```typescript
// backend/src/inference/index.ts
class ModelServer {
  private model: tf.LayersModel | null = null;
  private modelVersion: string | null = null;

  async loadActiveModel() {
    const result = await pool.query(`
      SELECT m.id, m.model_path, m.version
      FROM models m
      WHERE m.is_active = TRUE
    `);

    if (result.rows.length === 0) {
      throw new Error('No active model found');
    }

    const { model_path, version } = result.rows[0];

    // Download from MinIO if not cached locally
    const localPath = `/tmp/models/${version}/model.json`;
    if (!fs.existsSync(localPath)) {
      await downloadModelFromMinio(model_path, localPath);
    }

    // Load into TensorFlow.js
    this.model = await tf.loadLayersModel(`file://${localPath}`);
    this.modelVersion = version;

    logger.info(`Loaded model version ${version}`);
  }

  async classify(strokeData: StrokeData): Promise<ClassificationResult> {
    if (!this.model) {
      throw new Error('Model not loaded');
    }

    const startTime = Date.now();

    // 1. Render strokes to image tensor (same as training preprocessing)
    const imageTensor = renderStrokesToTensor(strokeData, 128, 128);

    // 2. Run inference
    const predictions = this.model.predict(imageTensor) as tf.Tensor;
    const probabilities = await predictions.data();

    // 3. Get top prediction
    const classes = ['line', 'circle', 'square', 'triangle', 'heart'];
    const maxIndex = probabilities.indexOf(Math.max(...probabilities));

    const latencyMs = Date.now() - startTime;
    metrics.histogram('inference.latency_ms', latencyMs);

    return {
      shape: classes[maxIndex],
      confidence: probabilities[maxIndex],
      modelVersion: this.modelVersion,
      latencyMs
    };
  }
}

// Warm up model at startup
const modelServer = new ModelServer();
await modelServer.loadActiveModel();
```

**Model Activation (Atomic)**:

```sql
-- Only one active model at a time
CREATE UNIQUE INDEX idx_models_active ON models(is_active) WHERE is_active = TRUE;

-- Atomic activation
BEGIN;
UPDATE models SET is_active = FALSE WHERE is_active = TRUE;
UPDATE models SET is_active = TRUE WHERE id = $1;
COMMIT;
```

---

### Deep Dive 4: Circuit Breaker and Retry Patterns (4 minutes)

**Circuit Breaker Implementation**:

```typescript
// backend/src/shared/circuitBreaker.ts
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailure = 0;

  constructor(
    private name: string,
    private threshold: number = 5,
    private resetTimeout: number = 30000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'half-open';
        metrics.gauge(`circuit.${this.name}.state`, 1); // half-open
      } else {
        metrics.increment(`circuit.${this.name}.rejected`);
        throw new CircuitOpenError(this.name);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
    metrics.gauge(`circuit.${this.name}.state`, 0); // closed
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.failures >= this.threshold) {
      this.state = 'open';
      metrics.gauge(`circuit.${this.name}.state`, 2); // open
      logger.warn(`Circuit breaker ${this.name} opened`);
    }
  }
}

// Usage
const minioCircuitBreaker = new CircuitBreaker('minio', 5, 30000);
const dbCircuitBreaker = new CircuitBreaker('postgres', 3, 15000);
```

**Retry with Exponential Backoff**:

```typescript
// backend/src/shared/retry.ts
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    operationName: string;
  }
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt === options.maxRetries) break;

      const delay = Math.min(
        options.initialDelayMs * Math.pow(2, attempt),
        options.maxDelayMs
      );

      // Add jitter to prevent thundering herd
      const jitter = delay * 0.1 * Math.random();

      logger.warn(`${options.operationName} failed, retrying in ${delay}ms`, {
        attempt,
        error: lastError.message
      });

      await sleep(delay + jitter);
    }
  }

  throw lastError!;
}
```

---

## 5. Database Schema (3 minutes)

```sql
-- Core tables
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) UNIQUE NOT NULL,
  role VARCHAR(20) DEFAULT 'user',
  total_drawings INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE shapes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  difficulty INT DEFAULT 1
);

CREATE TABLE drawings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  shape_id INT REFERENCES shapes(id),
  stroke_data_path VARCHAR(500) NOT NULL,
  metadata JSONB DEFAULT '{}',
  quality_score FLOAT,
  is_flagged BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ  -- Soft delete
);

CREATE TABLE models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_job_id UUID REFERENCES training_jobs(id),
  version VARCHAR(50) NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  accuracy FLOAT,
  model_path VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_drawings_shape ON drawings(shape_id);
CREATE INDEX idx_drawings_created ON drawings(created_at DESC);
CREATE INDEX idx_drawings_quality ON drawings(quality_score)
  WHERE quality_score IS NOT NULL;
CREATE UNIQUE INDEX idx_models_active ON models(is_active)
  WHERE is_active = TRUE;
```

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Stroke JSON over images | Preprocessing at training time | Preserves temporal data, smaller storage |
| MinIO over DB BLOB | Operational complexity | Designed for large files, S3-compatible |
| RabbitMQ over polling | Additional infrastructure | Reliable delivery, decouples services |
| Single active model | Can't A/B test easily | Simpler deployment, clear rollback |
| Soft deletes | Storage overhead | Audit trail, undo capability |

---

## 7. Future Enhancements

1. **Distributed Training**: Multi-GPU support with PyTorch DistributedDataParallel
2. **Active Learning**: Prioritize collecting underperforming shape classes
3. **Model A/B Testing**: Traffic splitting for model comparison
4. **Pre-signed URLs**: Direct-to-MinIO uploads for higher throughput
5. **Batch Inference**: Group predictions for efficiency
