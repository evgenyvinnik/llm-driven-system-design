# Claude Collaboration Notes - Scale AI

This document tracks the LLM-assisted development process for this project.

## Project Genesis

**Initial Request:** Build a data labeling platform similar to Scale AI, focused on collecting drawing data from thousands of users to train ML models.

**Three Portals Identified:**
1. Drawing Game - Simple shape drawing (line, heart, circle, square, triangle)
2. Admin Dashboard - Data management and model training
3. Implementor Portal - Model inference and testing

## Key Design Discussions

### Drawing Data Storage

**Question:** Should we store drawings as images or stroke data?

**Analysis:**
- Images are simpler for ML but lose temporal/pressure information
- Stroke data (JSON) is compact, preserves all info, can be converted to images
- Future use cases (stroke-based models, animation) benefit from raw data

**Decision:** Store as stroke data, convert to images at training time.

### Real-time vs Batch Collection

**Question:** Should drawings stream in real-time or submit on completion?

**Analysis:**
- Real-time (WebSocket) enables live feedback, partial saves
- Batch (REST) is simpler, lower server load, easier error handling
- Most users complete drawings in 2-5 seconds

**Decision:** Start with batch submission, add WebSocket later if needed.

### ML Framework Choice

**Question:** TensorFlow vs PyTorch for training?

**Analysis:**
- Both work well for simple CNNs
- PyTorch more popular in research, better debugging
- TensorFlow.js enables browser inference
- Training worker can use either

**Decision:** PyTorch for training worker, TensorFlow.js for optional browser inference.

### UI Design Direction: Skeuomorphic Post-It Notes

**Request:** Create a tactile, nostalgic experience for the drawing game.

**Design Concept:**
- Users draw on realistic yellow post-it notes
- Black marker strokes with ink bleeding effect
- Cork board background with wood frame
- Pink instruction post-it with pushpin
- Decorative Sharpie marker prop

**Why Skeuomorphism?**
- Makes drawing feel natural and familiar (like doodling at your desk)
- Post-it metaphor implies quick, casual sketches (lowers pressure)
- Tactile design encourages engagement and playfulness
- Memorable aesthetic differentiates from clinical data collection tools

**Implementation Details:**
- Multi-pass canvas rendering for marker ink effect
- CSS-only paper textures and shadows (no images)
- Caveat font for handwritten feel
- Touch-action: none to prevent scroll interference
- Responsive design for mobile drawing

## Architecture Evolution

### Version 1 (Initial)
- Single monolithic backend
- PostgreSQL for everything (including drawing data as BYTEA)
- Simple image upload

### Version 2 (Current)
- Microservices: Collection, Admin, Inference, Training Worker
- Object storage (MinIO) for drawing data
- Message queue (RabbitMQ) for training jobs
- Separate model registry

**Rationale for split:**
- Collection needs to scale independently (high write throughput)
- Training is async, benefits from queue-based architecture
- Inference has different latency requirements

## Implementation Phases

### Phase 1: Core Drawing Game (Completed)
- [x] Canvas component with mouse/touch support
- [x] Stroke data capture and formatting
- [x] Shape prompts and visual feedback
- [x] Submit to collection API
- [x] Skeuomorphic post-it note UI design
- [x] Sound effects using Web Audio API
- [x] Gamification (streaks, levels, milestones)

### Phase 2: Data Pipeline (Completed)
- [x] Collection service with MinIO integration
- [x] PostgreSQL schema and migrations
- [x] Basic data validation
- [x] Redis added for session storage and caching
- [x] Docker Compose with all services

### Phase 3: Admin Dashboard (Completed)
- [x] Statistics aggregation
- [x] Drawing browser with filters
- [x] Flag/unflag functionality
- [x] Training job management UI
- [x] Stroke thumbnail rendering
- [x] Session-based authentication

### Phase 4: Training Pipeline (Completed)
- [x] Training worker with RabbitMQ consumer
- [x] Stroke-to-image preprocessing
- [x] Simple CNN model (DoodleNet)
- [x] Model saving to registry

### Phase 5: Inference Service (Completed)
- [x] Model loading and caching
- [x] Classification API
- [x] Implementor portal UI
- [x] Heuristic-based demo classification

### Phase 6: Polish (Completed)
- [x] Gamification (streaks, levels, milestones, sound effects)
- [x] Unit tests for backend API endpoints
- [x] Redis caching for performance optimization
- [x] Session-based admin authentication
- [ ] Model comparison in admin (optional)
- [ ] Load testing (optional)

## Technical Challenges Encountered

### Canvas Touch Support
- Need to prevent default touch behavior (scrolling)
- Pressure sensitivity varies by device
- Consider pointer events API for unified handling

### Stroke Simplification
- Raw stroke data can be very large (1000+ points per drawing)
- Ramer-Douglas-Peucker algorithm for simplification
- Balance between data size and quality

### Training Data Quality
- Some users draw poorly or spam
- Need quality scoring (automated or manual)
- Consider active learning to request specific shapes

## Questions for Future Exploration

1. **Federated Learning:** Could we train on-device to preserve privacy?
2. **Generative Models:** Can we train a model to generate shapes, not just recognize?
3. **Transfer Learning:** Use pretrained model (Quick, Draw! dataset) as starting point?
4. **Real-time Collaboration:** Multiple users drawing the same shape simultaneously?

## Resources & References

- [Quick, Draw! Dataset](https://quickdraw.withgoogle.com/data) - Google's 50M drawing dataset
- [Ramer-Douglas-Peucker Algorithm](https://en.wikipedia.org/wiki/Ramer%E2%80%93Douglas%E2%80%93Peucker_algorithm) - Stroke simplification
- [Pointer Events API](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) - Unified input handling
- [MobileNet](https://arxiv.org/abs/1704.04861) - Efficient CNN architecture
