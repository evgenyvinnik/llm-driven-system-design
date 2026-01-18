# Ad Click Aggregator - Development with Claude

## Project Context

This document tracks the development journey of implementing a real-time analytics system for aggregating ad clicks.

## Key Challenges to Explore

1. High-volume writes
2. Real-time aggregation
3. Exactly-once semantics
4. Time-series data

## Development Phases

### Phase 1: Requirements and Design
*Completed*

**Key decisions made:**
- Target scale: 10,000 clicks/second for design, simplified for local dev
- Core features: Click ingestion, real-time aggregation, fraud detection, analytics
- PostgreSQL instead of ClickHouse for simplicity in local development
- Redis for deduplication, rate limiting, and real-time counters
- Express + TypeScript backend, React + TanStack Router frontend

### Phase 2: Initial Implementation
*In progress*

**Completed:**
- Click event ingestion API with validation (Zod)
- Deduplication using Redis with 5-minute TTL
- Real-time aggregation (minute, hour, day granularity)
- Fraud detection based on click velocity and patterns
- Query API for analytics with flexible grouping
- Admin API for system stats and monitoring
- React dashboard with Recharts visualizations
- Test click generator for development

**Focus areas:**
- Implement core functionality
- Get something working end-to-end
- Validate basic assumptions

### Phase 3: Scaling and Optimization
*Not started*

**Focus areas:**
- Add caching layer for aggregated queries
- Optimize database queries with better indexes
- Implement load balancing across multiple backend instances
- Add monitoring with Prometheus/Grafana
- Consider Kafka for event streaming

### Phase 4: Polish and Documentation
*Not started*

**Focus areas:**
- Complete documentation
- Add comprehensive tests
- Performance tuning
- Code cleanup

## Design Decisions Log

### PostgreSQL vs ClickHouse
**Decision:** Use PostgreSQL for this learning project
**Rationale:**
- Simpler setup and operation
- Familiar SQL interface
- Good enough for local development scale
- Built-in UPSERT for aggregation updates
- ClickHouse would be preferred at production scale for columnar storage and faster analytics

### Redis for Deduplication
**Decision:** Use Redis for click deduplication and real-time counters
**Rationale:**
- Sub-millisecond lookups for dedup checks
- Automatic TTL (5 minutes) for click IDs
- HyperLogLog for efficient unique user counting
- Hash maps for real-time click counters per time bucket

### Aggregation Strategy
**Decision:** Update aggregates synchronously on each click
**Rationale:**
- Simpler than async processing with Kafka
- Acceptable for learning project scale
- Uses UPSERT for atomic counter updates
- Trade-off: Higher latency per click vs. simpler architecture

### Fraud Detection
**Decision:** Rule-based fraud detection with velocity thresholds
**Rationale:**
- 100 clicks/minute per IP triggers fraud flag
- 50 clicks/minute per user triggers fraud flag
- Suspicious patterns (missing device info, regular timing)
- Fraudulent clicks are flagged but stored for analysis
- ML-based detection is a future enhancement

## Iterations and Learnings

### Iteration 1: Basic Implementation
- Set up Express backend with TypeScript
- Implemented click ingestion with Zod validation
- Added Redis deduplication layer
- Created PostgreSQL schema with aggregation tables
- Built React dashboard with real-time updates

**Key learnings:**
- UPSERT pattern works well for aggregation updates
- Redis HyperLogLog is efficient for unique user counting
- TanStack Router with file-based routing is productive

## Questions and Discussions

### Open Questions
1. How to handle late-arriving clicks? (Currently: update aggregates immediately)
2. Should we implement watermarking for time window handling?
3. Best strategy for archiving old raw click data?

### Future Considerations
1. Kafka integration for higher throughput
2. ClickHouse for production-scale analytics
3. ML-based fraud detection model
4. Geo-velocity fraud detection (impossible travel)

## Resources and References

- [ClickHouse Documentation](https://clickhouse.com/docs/)
- [Redis HyperLogLog](https://redis.io/docs/data-types/hyperloglog/)
- [Apache Flink for Stream Processing](https://flink.apache.org/)
- [Exactly-Once Semantics](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)

## Next Steps

- [x] Define detailed requirements
- [x] Sketch initial architecture
- [x] Choose technology stack
- [x] Implement MVP
- [ ] Test and iterate
- [ ] Add Kafka for async processing (optional)
- [ ] Implement comprehensive tests
- [ ] Add monitoring and observability

---

*This document will be updated throughout the development process to capture insights, decisions, and learnings.*
