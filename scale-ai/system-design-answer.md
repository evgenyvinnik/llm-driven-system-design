# System Design Interview: Scale AI - Data Labeling Platform

## Opening Statement

"Today I'll design a crowdsourced data labeling platform similar to Scale AI, specifically focused on collecting drawing data to train machine learning models. The system has three distinct user types: end users who contribute labeled data through a drawing game, administrators who manage the dataset and trigger training, and implementors who use trained models for inference."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

Let me confirm the core functionality:

1. **Data Collection Portal**: Users draw simple shapes (line, heart, circle, square, triangle) on a canvas with touch and mouse support
2. **Admin Portal**: View statistics, browse submissions, flag low-quality data, trigger model training, compare model versions
3. **Implementor Portal**: Load trained models, request shape recognition, test with custom inputs

### Non-Functional Requirements

- **Throughput**: Handle 10,000+ concurrent users drawing simultaneously
- **Storage**: Store millions of drawing samples efficiently (target 10M+ drawings per month)
- **Training**: Jobs should complete within reasonable time (hours, not days)
- **Inference**: Sub-100ms latency for model predictions
- **Local Development**: All components must run locally for testing

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Concurrent users | 10,000 |
| Drawings per user session | 10-50 |
| Drawing data size | 5-50KB per drawing (stroke data) |
| Monthly storage | 100GB - 500GB |
| Model inference QPS | 1,000+ |

---

## Step 2: High-Level Architecture (8 minutes)

Let me walk through the architecture from top to bottom.

### Architecture Overview

```
                     FRONTEND LAYER
    ┌────────────────┬──────────────────┬─────────────────────┐
    │ Drawing Game   │  Admin Portal    │ Implementor Portal  │
    │ (React+Canvas) │  (React+Charts)  │ (React+Canvas)      │
    └───────┬────────┴────────┬─────────┴──────────┬──────────┘
            │                 │                     │
            ▼                 ▼                     ▼
    ┌─────────────────────────────────────────────────────────┐
    │              API GATEWAY (Load Balancer)                │
    └───────┬─────────────────┬────────────────────┬──────────┘
            │                 │                    │
            ▼                 ▼                    ▼
    ┌───────────────┐ ┌───────────────┐   ┌───────────────┐
    │  Collection   │ │    Admin      │   │   Inference   │
    │   Service     │ │   Service     │   │    Service    │
    │  (Express)    │ │  (Express)    │   │ (Express/Py)  │
    └───────┬───────┘ └───────┬───────┘   └───────┬───────┘
            │                 │                    │
            ▼                 │                    │
    ┌───────────────┐         │                    │
    │ Message Queue │◄────────┘                    │
    │  (RabbitMQ)   │                              │
    └───────┬───────┘                              │
            │                                      │
            ▼                                      │
    ┌───────────────┐                              │
    │   Training    │                              │
    │    Worker     │                              │
    │   (Python)    │                              │
    └───────┬───────┘                              │
            │                                      │
            ▼                                      ▼
    ┌─────────────────────────────────────────────────────────┐
    │                     DATA LAYER                          │
    ├───────────────┬───────────────────┬─────────────────────┤
    │  PostgreSQL   │  Object Storage   │   Model Registry    │
    │  (Metadata)   │  (Drawing Data)   │  (Trained Models)   │
    └───────────────┴───────────────────┴─────────────────────┘
```

### Why This Architecture?

**Separation of Services**: Each portal has different scaling requirements. The collection service needs to handle 10K concurrent users with high write throughput, while the inference service needs low latency. Admin is relatively low traffic.

**Message Queue for Training**: Training jobs are long-running and should never block the API. RabbitMQ decouples job submission from execution and provides reliability if workers crash.

**Object Storage for Drawings**: Stroke data can be 5-50KB per drawing. Storing this in PostgreSQL would bloat the database. Object storage (MinIO locally, S3 in production) is designed for this.

---

## Step 3: Data Model Deep Dive (10 minutes)

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
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    difficulty INT DEFAULT 1
);

-- Drawing submissions (metadata only)
CREATE TABLE drawings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    shape_id INT REFERENCES shapes(id),
    stroke_data_path VARCHAR(500),  -- Path to object storage
    metadata JSONB,
    quality_score FLOAT,
    is_flagged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Training jobs
CREATE TABLE training_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(50) DEFAULT 'pending',
    config JSONB,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    metrics JSONB,
    model_path VARCHAR(500)
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
```

### Drawing Data Format (Object Storage)

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

### Key Decision: Stroke Data vs Images

I chose to store stroke data (JSON) rather than rendered images for several reasons:

1. **Information Preservation**: Stroke data includes temporal information (how the user drew), pressure, and drawing order - valuable for advanced models
2. **Flexibility**: We can render to any resolution at training time (64x64, 128x128, etc.)
3. **Smaller Storage**: JSON with point simplification is typically smaller than PNG images
4. **Future Use Cases**: Stroke-based models, animation generation

The tradeoff is we need a preprocessing step before training to render strokes to images.

---

## Step 4: Core Service Deep Dives (12 minutes)

### Collection Service

This is the highest-traffic component. Let me explain the data flow:

**API Endpoints:**
```
POST /api/drawings          # Submit a completed drawing
GET  /api/shapes            # Get list of shapes to draw
GET  /api/user/stats        # Get user's drawing statistics
```

**Submission Flow:**
```javascript
async function submitDrawing(userId, shapeId, strokeData) {
  // 1. Validate stroke data format and size
  validateStrokeData(strokeData)

  // 2. Generate unique path for object storage
  const path = `drawings/${userId}/${uuid()}.json`

  // 3. Upload to object storage (async)
  await objectStorage.put(path, JSON.stringify(strokeData))

  // 4. Create metadata record in PostgreSQL
  await db('drawings').insert({
    user_id: userId,
    shape_id: shapeId,
    stroke_data_path: path,
    metadata: extractMetadata(strokeData)
  })
}
```

**Scaling Strategies:**

1. **Horizontal Scaling**: Stateless service, just add more instances behind load balancer
2. **Batching**: Client can submit multiple drawings in one request
3. **Pre-signed URLs**: For very high scale, generate pre-signed URLs for direct-to-storage upload, bypassing our servers

### Training Worker

The training worker consumes jobs from RabbitMQ:

```python
# Training pipeline
def process_training_job(job):
    # 1. Fetch drawings from object storage
    drawings = fetch_drawings(job.config.filters)

    # 2. Preprocess: Convert stroke data to images
    images = [render_strokes_to_image(d, size=128) for d in drawings]

    # 3. Augment: Rotation, scaling, noise
    augmented = augment_dataset(images)

    # 4. Train CNN model
    model = train_cnn(augmented, epochs=50)

    # 5. Evaluate
    accuracy = evaluate_model(model, validation_set)

    # 6. Save to registry
    model_path = save_model(model, job.id)

    # 7. Update job status
    update_job(job.id, status='completed', accuracy=accuracy)
```

**Why CNN for Shape Recognition?**

For simple shape classification (5 classes), a small CNN is sufficient:
- Input: 128x128 grayscale images
- 3-4 convolutional layers
- Output: Softmax over 5 classes
- Training time: Minutes on CPU, seconds on GPU

### Inference Service

The inference service must maintain low latency:

```javascript
// Load model at startup
let activeModel = await loadModel(getActiveModelPath())

async function classify(strokeData) {
  // 1. Render strokes to image (same preprocessing as training)
  const image = renderStrokesToImage(strokeData, 128, 128)

  // 2. Run inference
  const predictions = await activeModel.predict(image)

  // 3. Return top prediction with confidence
  return {
    shape: getTopClass(predictions),
    confidence: predictions[getTopClass(predictions)]
  }
}
```

**Latency Optimization:**

1. **Model Warm-Up**: Keep model loaded in memory, don't reload per request
2. **Batch Inference**: If multiple requests arrive together, batch them
3. **Edge Deployment**: For browser-based inference, export to TensorFlow.js

---

## Step 5: Key Design Decisions & Trade-offs (7 minutes)

### Decision 1: Batch Submission vs Real-time Streaming

**Options:**
- **WebSocket streaming**: Send strokes as user draws
- **Submit on completion**: Wait until drawing is finished

**Choice**: Submit on completion

**Rationale**:
- Most drawings take 2-5 seconds - not worth the WebSocket complexity
- Simpler error handling (retry whole submission)
- Lower server load
- We could add streaming later for real-time feedback features

### Decision 2: Object Storage Type

**Options:**
- MinIO (S3-compatible, Docker-friendly)
- Local filesystem
- PostgreSQL BYTEA

**Choice**: MinIO

**Rationale**:
- S3-compatible API matches production behavior
- Handles large files efficiently
- Built-in redundancy options
- For local dev, filesystem fallback is fine

### Decision 3: Quality Scoring

**Options:**
- Manual admin review
- Automated ML-based scoring
- Crowdsourced validation

**Choice**: Hybrid - automated scoring with admin override

**Approach**:
```javascript
function autoScoreDrawing(drawing) {
  // Check stroke count (too few = incomplete, too many = scribble)
  if (drawing.strokes.length < 1 || drawing.strokes.length > 50) {
    return 0.3
  }

  // Check duration (too fast = spam)
  if (drawing.duration_ms < 500) {
    return 0.2
  }

  // Use model confidence as proxy for quality
  const prediction = await classify(drawing)
  return prediction.confidence
}
```

---

## Step 6: Scaling Considerations (5 minutes)

### Handling 10K Concurrent Users

```
Problem: 10K users submitting drawings simultaneously

Solutions:
1. Horizontal scaling of collection service (3-5 instances)
2. Message queue buffers spikes in training requests
3. Client-side batching (submit 5 drawings at once)
4. Pre-signed URLs bypass API servers for upload
```

### Training on Millions of Drawings

```
Problem: Can't load 10M drawings into memory

Solutions:
1. Streaming data loader (batch by batch from storage)
2. Data sampling (train on representative 100K subset)
3. Incremental training (fine-tune on new data weekly)
4. Distributed training (multiple GPUs in production)
```

### Model Serving at Scale

```
Problem: 1000+ QPS inference

Solutions:
1. Model quantization (INT8 vs FP32) - 3x faster
2. Model pruning (remove unnecessary weights)
3. Batch inference (group requests)
4. Edge deployment (TensorFlow.js in browser)
```

---

## Closing Summary

I've designed a data labeling platform with three main components:

1. **Collection Service**: High-throughput drawing ingestion storing stroke data in object storage with metadata in PostgreSQL

2. **Admin Service + Training Pipeline**: Async job processing via RabbitMQ, with workers that fetch drawings, preprocess to images, train CNNs, and save to a model registry

3. **Inference Service**: Low-latency shape classification using cached models with sub-100ms response times

**Key trade-offs made:**
- Stroke data over images (flexibility vs. preprocessing cost)
- Batch submission over streaming (simplicity vs. real-time features)
- Shared PostgreSQL with object storage separation (operational simplicity vs. specialized databases)

**What would I add with more time?**
- Active learning to prioritize collecting underperforming classes
- A/B testing framework for model versions
- Federated learning for privacy-preserving data collection
