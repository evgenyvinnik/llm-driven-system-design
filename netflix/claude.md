# Design Netflix - Development with Claude

## Project Context

Building a video streaming platform to understand adaptive streaming, personalization, and A/B testing at scale.

**Key Learning Goals:**
- Build adaptive bitrate streaming
- Design personalization for millions of users
- Implement A/B testing infrastructure
- Handle video encoding optimization

---

## Key Challenges to Explore

### 1. Bandwidth Estimation

**Challenge**: Accurately predict available bandwidth

**Approaches:**
- Segment download time measurement
- Exponential moving average
- Buffer-based adaptation
- Hybrid approaches

### 2. Personalization Latency

**Problem**: Generating personalized homepage is expensive

**Solutions:**
- Precompute row candidates
- Cache per-profile recommendations
- Async row generation
- Progressive loading

### 3. Experiment Interactions

**Problem**: Multiple experiments running simultaneously

**Solutions:**
- Orthogonal experiment layers
- Holdout groups
- Interaction detection
- Careful traffic allocation

---

## Development Phases

### Phase 1: Catalog & Streaming
- [ ] Video metadata
- [ ] Basic streaming
- [ ] DASH manifest generation

### Phase 2: Personalization
- [ ] Profile system
- [ ] Viewing history
- [ ] Homepage rows

### Phase 3: Recommendations
- [ ] Similar titles
- [ ] Genre rankings
- [ ] Continue watching

### Phase 4: Experimentation
- [ ] A/B test framework
- [ ] Allocation service
- [ ] Metrics collection

---

## Resources

- [Netflix Tech Blog](https://netflixtechblog.com/)
- [DASH Streaming](https://dashif.org/docs/)
- [Netflix Personalization](https://netflixtechblog.com/netflix-recommendations-beyond-the-5-stars-part-1-55838468f429)
