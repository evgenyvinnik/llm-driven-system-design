# Design APNs - Development with Claude

## Project Context

Building a push notification service to understand real-time delivery, connection management, and reliability at scale.

**Key Learning Goals:**
- Build push notification infrastructure
- Design connection pooling at scale
- Implement store-and-forward delivery
- Handle device token lifecycle

---

## Key Challenges to Explore

### 1. Connection Scale

**Challenge**: Millions of concurrent device connections

**Approaches:**
- Sharded connection servers
- Efficient event loop (epoll/kqueue)
- Connection pooling
- Geographic distribution

### 2. Delivery Guarantee

**Problem**: Ensuring delivery to offline devices

**Solutions:**
- Store-and-forward queues
- Expiration handling
- Retry with backoff
- Collapse ID deduplication

### 3. Battery Efficiency

**Challenge**: Minimize device wake-ups

**Solutions:**
- Priority levels (immediate vs background)
- Power nap delivery
- Batching low-priority notifications
- Silent push optimization

---

## Development Phases

### Phase 1: Provider API
- [x] HTTP/2 server (using HTTP/1.1 for learning)
- [x] JWT authentication (simplified session-based)
- [x] Payload validation
- [x] Request routing

### Phase 2: Token Management (In Progress)
- [x] Token registration
- [x] Invalidation handling
- [x] Topic subscriptions
- [x] Feedback service

### Phase 3: Delivery
- [x] Push to online devices
- [x] Store-and-forward
- [x] Priority handling
- [x] Collapse IDs

### Phase 4: Scale
- [ ] Connection sharding
- [ ] Geographic routing
- [x] Rate limiting
- [ ] Monitoring

---

## Implementation Notes

### Architecture Decisions

1. **HTTP/1.1 instead of HTTP/2**: For this learning project, we use HTTP/1.1 with Express for simplicity. HTTP/2 would require TLS certificates and more complex setup. The concepts remain the same.

2. **Session-based auth instead of JWT**: Simplified authentication using Redis sessions. In production APNs, provider authentication uses JWT tokens with app-specific keys.

3. **WebSocket for device connections**: We use WebSocket for real-time bidirectional communication with devices. This simulates the persistent TCP connections that real APNs maintains.

4. **PostgreSQL for persistence**: All device tokens, notifications, and delivery logs are stored in PostgreSQL for durability and querying.

5. **Redis for real-time**: Device connection tracking, rate limiting, and inter-server communication via pub/sub.

### Key Files

- `backend/src/services/tokenRegistry.ts` - Device token management
- `backend/src/services/pushService.ts` - Notification delivery logic
- `backend/src/services/feedbackService.ts` - Invalid token reporting
- `backend/src/routes/devices.ts` - Device registration API
- `backend/src/routes/notifications.ts` - Notification sending API
- `backend/src/routes/admin.ts` - Admin dashboard API

### Testing the System

1. Register a test device:
```bash
curl -X POST http://localhost:3000/api/v1/devices/register \
  -H "Content-Type: application/json" \
  -d '{
    "token": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    "app_bundle_id": "com.example.test"
  }'
```

2. Send a notification:
```bash
curl -X POST http://localhost:3000/api/v1/notifications/device/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 \
  -H "Content-Type: application/json" \
  -d '{
    "payload": {
      "aps": {
        "alert": {"title": "Test", "body": "Hello World"}
      }
    }
  }'
```

3. Check notification status:
```bash
curl http://localhost:3000/api/v1/notifications/{notification_id}/status
```

---

## Resources

- [APNs Documentation](https://developer.apple.com/documentation/usernotifications)
- [HTTP/2 Specification](https://http2.github.io/)
- [Firebase Cloud Messaging Architecture](https://firebase.google.com/docs/cloud-messaging/concept-options)
