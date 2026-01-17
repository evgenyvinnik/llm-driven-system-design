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

## Future Enhancements

1. **Active Learning:** Prioritize collecting drawings for underperforming classes
2. **Quality Estimation:** Auto-score drawings based on similarity to known good examples
3. **Generative Models:** Train models to generate shapes (VAE, GAN)
4. **Multi-task Learning:** Train single model for recognition + generation
5. **Federated Learning:** Train on-device without centralizing data
6. **Gamification:** Leaderboards, achievements, challenges
