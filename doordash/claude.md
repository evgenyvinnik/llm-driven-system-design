# Design DoorDash - Development with Claude

## Project Context

Building a food delivery platform to understand real-time logistics, three-sided marketplaces, and location tracking at scale.

**Key Learning Goals:**
- Design real-time location tracking
- Build optimal order-driver matching algorithms
- Calculate multi-factor ETAs
- Handle complex order state machines

---

## Key Challenges to Explore

### 1. The Batching Problem

**Scenario**: Driver near two restaurants, both have orders

**Solution**: Batch pickup
- Calculate combined route efficiency
- Only batch if minimal delay
- Cap at 2-3 orders per batch

### 2. Dynamic ETA Updates

**Problem**: ETA changes as conditions change

**Factors that update ETA:**
- Driver location changes
- Traffic conditions
- Restaurant prep delays
- Driver accepts/declines

### 3. Peak Hour Demand

**Solutions:**
- Surge pricing (reduce demand)
- Driver incentives (increase supply)
- Prep time padding (manage expectations)

---

## Development Phases

### Phase 1: Core Ordering
- [ ] Restaurant and menu management
- [ ] Order placement
- [ ] Basic status tracking

### Phase 2: Driver System
- [ ] Driver onboarding
- [ ] Location tracking
- [ ] Order assignment

### Phase 3: Real-Time
- [ ] Live location updates
- [ ] WebSocket connections
- [ ] Push notifications

### Phase 4: Optimization
- [ ] ETA calculation
- [ ] Route optimization
- [ ] Batching logic

---

## Resources

- [DoorDash Engineering Blog](https://doordash.engineering/)
- [Real-Time Location Tracking](https://eng.uber.com/real-time-push-platform/)
- [Vehicle Routing Problem](https://developers.google.com/optimization/routing/vrp)
