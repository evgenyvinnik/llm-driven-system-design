# Design Health Data Pipeline - Development with Claude

## Project Context

Building a health data aggregation pipeline to understand multi-source data ingestion, deduplication, and privacy-preserving processing.

**Key Learning Goals:**
- Build multi-device data ingestion
- Design data deduplication algorithms
- Implement privacy-preserving processing
- Handle time-series data at scale

---

## Key Challenges to Explore

### 1. Multi-Source Ingestion

**Challenge**: Handle diverse devices with different data formats

**Approaches:**
- Unified data model
- Source adapters
- Schema validation
- Unit normalization

### 2. Data Deduplication

**Problem**: Same metric from multiple sources

**Solutions:**
- Source priority ranking
- Time-based overlap detection
- Sample merging strategies
- Confidence scoring

### 3. Privacy Protection

**Challenge**: Protect sensitive health data

**Solutions:**
- End-to-end encryption
- On-device processing
- Granular sharing controls
- Minimal data exposure

---

## Development Phases

### Phase 1: Data Model - COMPLETED
- [x] Health data types (16 types across activity, vitals, body, sleep)
- [x] Sample schema with TimescaleDB hypertables
- [x] Aggregation levels (hour, day, week, month)
- [x] Device registry with priority ranking

### Phase 2: Ingestion - IN PROGRESS
- [x] Sync protocol (batch sync via REST API)
- [x] Batch processing (bulk insert with UPSERT)
- [x] Validation layer (HealthSample model validation)
- [x] Error handling (per-sample error collection)
- [ ] Real device integration (HealthKit, Google Fit)
- [ ] Webhook support for push updates

### Phase 3: Aggregation - COMPLETED
- [x] Deduplication (priority-based with overlap detection)
- [x] Time-based aggregation (hourly, daily)
- [x] Trend calculation (linear regression)
- [x] Insight generation (heart rate, sleep, activity, weight)

### Phase 4: Access - COMPLETED
- [x] Query API (samples, aggregates, summaries, history)
- [x] Admin API (stats, user management, reaggregation)
- [ ] Sharing system (share tokens implemented in schema)
- [ ] Export functionality (CSV, JSON export)
- [ ] Privacy controls (data deletion, consent management)

---

## Implementation Notes

### Deduplication Algorithm

The deduplication algorithm uses device priority ranking to handle overlapping data:

1. **Priority Order**: Apple Watch (100) > iPhone (80) > iPad (70) > Third-party wearable (50) > Third-party scale (40) > Manual entry (10)

2. **Overlap Detection**:
   - Full overlap: Lower priority sample is completely covered - skip it
   - Partial overlap: Adjust the sample to only include non-overlapping portion
   - No overlap: Include full sample

3. **Value Adjustment**: For partial overlaps, proportionally reduce the value based on the remaining time duration.

### Aggregation Strategy

Different health metrics use different aggregation strategies:

| Strategy | Metrics | Description |
|----------|---------|-------------|
| `sum` | Steps, Distance, Calories, Sleep | Total for the period |
| `average` | Heart Rate, Blood Pressure, Blood Oxygen | Mean value |
| `latest` | Weight, Body Fat | Most recent value |
| `min`/`max` | Available for range queries | Extreme values |

### Insights Engine

The insights engine analyzes aggregated data to generate health recommendations:

1. **Heart Rate Trend**: Detects increasing/decreasing resting heart rate over 30 days using linear regression
2. **Sleep Deficit**: Alerts when average sleep falls below 6 hours over 14 days
3. **Activity Change**: Compares current week steps to 4-week average
4. **Weight Change**: Detects significant weight changes (>3%) over 30 days

---

## Architecture Decisions

### Why TimescaleDB?

- Native PostgreSQL compatibility (familiar SQL)
- Automatic partitioning via hypertables
- Efficient time-range queries
- Built-in compression for older data
- Compatible with existing PostgreSQL tools

### Why Redis for Sessions?

- Fast session validation (< 1ms)
- Natural expiration support
- Can also cache aggregated data
- Simple to scale with replication

### Why Zustand for State?

- Minimal boilerplate compared to Redux
- Built-in persistence middleware
- No context providers needed
- TypeScript-first design

---

## Future Enhancements

1. **Real Device Integration**
   - Apple HealthKit SDK integration
   - Google Fit API integration
   - Fitbit, Garmin adapters

2. **Advanced Analytics**
   - Correlation analysis between metrics
   - Anomaly detection with ML
   - Predictive health insights

3. **Privacy Features**
   - End-to-end encryption with user keys
   - Differential privacy for aggregates
   - GDPR compliance (data export, deletion)

4. **Sharing System**
   - Time-limited share tokens
   - Healthcare provider portal
   - Family sharing with consent

---

## Resources

- [Apple HealthKit](https://developer.apple.com/documentation/healthkit)
- [TimescaleDB](https://www.timescale.com/)
- [HIPAA Compliance](https://www.hhs.gov/hipaa/index.html)
- [Recharts](https://recharts.org/)
- [TanStack Router](https://tanstack.com/router)
