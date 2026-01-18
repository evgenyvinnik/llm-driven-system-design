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

### Phase 1: Core Ordering (Completed)
- [x] Restaurant and menu management
- [x] Order placement
- [x] Basic status tracking

### Phase 2: Driver System (In Progress)
- [x] Driver onboarding
- [x] Location tracking
- [x] Order assignment
- [ ] Advanced matching algorithm improvements
- [ ] Driver batching for multiple orders

### Phase 3: Real-Time
- [x] Live location updates via WebSocket
- [x] WebSocket connections for all parties
- [ ] Push notifications (browser notifications)

### Phase 4: Optimization
- [x] Basic ETA calculation
- [ ] ML-based ETA improvements
- [ ] Route optimization
- [ ] Advanced batching logic

---

## Implementation Notes

### Order-Driver Matching Algorithm

The current implementation uses a score-based matching system:

```javascript
function calculateMatchScore(driver, order, distance) {
  let score = 0;

  // Distance to restaurant (most important) - closer is better
  score += 100 - distance * 10;

  // Driver rating
  score += parseFloat(driver.rating || 5) * 5;

  // Experience (more deliveries = more reliable)
  score += Math.min(driver.total_deliveries / 10, 20);

  return score;
}
```

### ETA Calculation

Multi-factor ETA with traffic adjustments:

1. **Time to restaurant**: Based on driver location and traffic
2. **Preparation time**: Restaurant's estimated prep time
3. **Delivery time**: Route from restaurant to customer
4. **Buffer**: Pickup and dropoff handling time

Traffic multipliers:
- Rush hours (7-9 AM, 5-7 PM): 1.5x
- Lunch rush (11 AM - 1 PM): 1.3x
- Normal hours: 1.0x

### Redis Geo Commands

Using Redis for real-time driver location:

```javascript
// Store driver location
await redisClient.geoAdd('driver_locations', {
  longitude: lon,
  latitude: lat,
  member: driverId.toString(),
});

// Find nearby drivers
const results = await redisClient.geoSearch(
  'driver_locations',
  { longitude: lon, latitude: lat },
  { radius: radiusKm, unit: 'km' },
  { WITHDIST: true, SORT: 'ASC', COUNT: 20 }
);
```

---

## Resources

- [DoorDash Engineering Blog](https://doordash.engineering/)
- [Real-Time Location Tracking](https://eng.uber.com/real-time-push-platform/)
- [Vehicle Routing Problem](https://developers.google.com/optimization/routing/vrp)
