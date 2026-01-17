# Scale AI - Data Labeling & ML Training Platform

A crowdsourced data collection platform where users contribute labeled drawing data through a game interface, administrators manage datasets and training, and implementors use trained models for inference.

## Project Overview

**Three User Portals:**

1. **Drawing Game (End Users)** - Draw shapes (line, heart, circle, square, triangle) on a canvas
2. **Admin Dashboard** - View statistics, browse data, trigger model training
3. **Implementor Portal** - Load trained model, test inference, generate shapes

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.10+
- Docker & Docker Compose

### 1. Start Infrastructure

```bash
docker-compose up -d
```

This starts:
- PostgreSQL (port 5432)
- MinIO / S3-compatible storage (port 9000, console 9001)
- RabbitMQ (port 5672, management 15672)

### 2. Initialize Database

```bash
cd backend
npm run db:migrate
npm run db:seed  # Creates shape definitions
```

### 3. Start Backend Services

```bash
# Terminal 1 - Collection Service
npm run dev:collection  # Port 3001

# Terminal 2 - Admin Service
npm run dev:admin       # Port 3002

# Terminal 3 - Inference Service
npm run dev:inference   # Port 3003
```

### 4. Start Training Worker

```bash
cd training
pip install -r requirements.txt
python worker.py
```

### 5. Start Frontend

```bash
cd frontend
npm install
npm run dev  # Port 5173
```

## Project Structure

```
scale-ai/
├── frontend/                    # React + TypeScript + Vite
│   ├── src/
│   │   ├── components/
│   │   │   ├── Canvas/         # Drawing canvas component
│   │   │   ├── ShapePrompt/    # Shape to draw indicator
│   │   │   └── AdminCharts/    # Dashboard visualizations
│   │   ├── routes/
│   │   │   ├── draw/           # Drawing game portal
│   │   │   ├── admin/          # Admin dashboard
│   │   │   └── implement/      # Implementor portal
│   │   ├── stores/             # Zustand stores
│   │   └── services/           # API clients
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── collection/         # Drawing collection service
│   │   ├── admin/              # Admin service
│   │   ├── inference/          # Model inference service
│   │   ├── shared/             # Shared utilities
│   │   └── db/                 # Database migrations
│   └── package.json
│
├── training/                    # Python ML training
│   ├── worker.py               # Training job worker
│   ├── model.py                # Model architecture
│   ├── preprocess.py           # Stroke to image conversion
│   └── requirements.txt
│
├── docker-compose.yml
├── architecture.md
├── claude.md
└── README.md
```

## API Reference

### Collection Service (Port 3001)

```
GET  /api/shapes                  # List available shapes
POST /api/drawings                # Submit a drawing
GET  /api/user/stats              # User's drawing count
```

### Admin Service (Port 3002)

```
GET  /api/admin/stats             # Dashboard statistics
GET  /api/admin/drawings          # Paginated drawing list
POST /api/admin/drawings/:id/flag # Flag drawing
POST /api/admin/training/start    # Start training job
GET  /api/admin/training/:id      # Training job status
GET  /api/admin/models            # List models
POST /api/admin/models/:id/activate
```

### Inference Service (Port 3003)

```
POST /api/inference/classify      # Classify a drawing
POST /api/inference/generate      # Generate a shape
GET  /api/inference/model/info    # Current model info
```

## Drawing Data Format

Drawings are stored as stroke data (JSON):

```json
{
  "shape": "circle",
  "canvas": { "width": 400, "height": 400 },
  "strokes": [
    {
      "points": [
        { "x": 100, "y": 100, "pressure": 0.5, "timestamp": 1234567890 }
      ],
      "color": "#000000",
      "width": 3
    }
  ],
  "duration_ms": 2500,
  "device": "mouse"
}
```

## Testing

```bash
# Backend tests
cd backend && npm test

# Frontend tests
cd frontend && npm test

# Training tests
cd training && pytest
```

## Development Notes

### Drawing Canvas

The canvas component captures:
- Mouse events (mousedown, mousemove, mouseup)
- Touch events (touchstart, touchmove, touchend)
- Pointer events (for pressure sensitivity)

### Model Training

The training worker:
1. Polls RabbitMQ for training jobs
2. Fetches stroke data from MinIO
3. Converts strokes to 64x64 grayscale images
4. Trains a small CNN (MobileNet-style)
5. Saves model to MinIO, metrics to PostgreSQL

### Local MinIO Setup

Access MinIO console at http://localhost:9001
- Username: minioadmin
- Password: minioadmin

Create buckets:
- `drawings` - Raw stroke data
- `models` - Trained model files

## Key Design Decisions

See [architecture.md](./architecture.md) for detailed system design documentation.

**Highlights:**
- Stroke data stored as JSON (not images) to preserve temporal/pressure info
- Submit-on-completion (not real-time streaming) for simplicity
- MinIO for S3-compatible local object storage
- RabbitMQ for training job queue
- Small CNN optimized for fast inference
