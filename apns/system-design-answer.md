# APNs (Apple Push Notification Service) - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design APNs, Apple's push notification service that delivers billions of notifications daily to iOS, macOS, and other Apple platforms. The key challenge is building a highly reliable, low-latency delivery system that maintains persistent connections to hundreds of millions of devices while handling varying network conditions.

The core technical challenges are managing millions of concurrent device connections, implementing store-and-forward delivery for offline devices, and achieving sub-500ms latency for high-priority notifications."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Push**: Deliver notifications to devices with < 500ms latency
- **Register**: Manage device token lifecycle (create, invalidate)
- **Topics**: Subscribe devices to notification topics for broadcast
- **Feedback**: Report invalid tokens back to providers
- **Priority**: Handle urgent vs background notifications differently

### Non-Functional Requirements
- **Latency**: < 500ms for high-priority notifications to online devices
- **Scale**: 50B+ notifications per day
- **Reliability**: 99.99% delivery to online devices
- **Efficiency**: Minimal battery impact on devices

### Scale Estimates
- 1 billion+ active Apple devices
- 50 billion notifications per day = ~580K notifications/second
- Each device maintains persistent connection when online
- Store up to 100 notifications per offline device

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     Provider Layer                         |
|       App Servers (Netflix, Instagram, WhatsApp, etc.)    |
+----------------------------------------------------------+
                           | HTTP/2 (multiplexed)
                           v
+----------------------------------------------------------+
|                    APNs Gateway                            |
|        (Authentication, Rate Limiting, Validation)        |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                   Routing Layer                            |
|        (Device lookup, Topic resolution, Sharding)        |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
|   Push Service   |  |  Store Service   |  | Token Registry   |
|                  |  |                  |  |                  |
| - Delivery       |  | - Queue offline  |  | - Device tokens  |
| - Connections    |  | - Retry logic    |  | - Invalidation   |
| - QoS            |  | - Expiration     |  | - Topics         |
+------------------+  +------------------+  +------------------+
                           |
                           v
+----------------------------------------------------------+
|                      Device Layer                          |
|          Persistent connections to all devices             |
+----------------------------------------------------------+
```

### Core Components
1. **APNs Gateway** - HTTP/2 endpoint for providers, handles auth and validation
2. **Routing Layer** - Maps device tokens to push service shards
3. **Push Service** - Maintains device connections, delivers notifications
4. **Store Service** - Queues notifications for offline devices
5. **Token Registry** - Manages device token lifecycle and topic subscriptions
6. **Feedback Service** - Reports invalid tokens to providers

## Deep Dive: Provider API (HTTP/2) (7 minutes)

The provider-facing API uses HTTP/2 for efficiency with multiplexed streams over a single connection.

### HTTP/2 Benefits for Push
- **Multiplexing**: Thousands of requests on single connection
- **Header compression**: Reduces overhead for repeated headers
- **Binary protocol**: More efficient than HTTP/1.1 text
- **Server push**: Not used for APNs, but protocol supports it

### Request Flow

```javascript
class APNsGateway {
  async handleRequest(stream, headers) {
    // POST /3/device/{device_token}
    const deviceToken = headers[':path'].split('/')[3]

    // 1. Validate JWT authentication
    const authHeader = headers['authorization']
    const validAuth = await this.validateJWT(authHeader)
    if (!validAuth) {
      return stream.respond({ ':status': 403 })
    }

    // 2. Parse notification payload
    const payload = await this.readBody(stream)
    const notification = JSON.parse(payload)

    // 3. Extract headers
    const notificationId = headers['apns-id'] || uuid()
    const priority = headers['apns-priority'] || 10  // 10=immediate, 5=power-efficient
    const expiration = headers['apns-expiration'] || 0
    const topic = headers['apns-topic']  // Bundle ID
    const collapseId = headers['apns-collapse-id']  // Replace previous

    // 4. Validate payload size (< 4KB for regular, < 5KB for VoIP)
    if (payload.length > 4096) {
      return stream.respond({ ':status': 413 })
    }

    // 5. Route to push service
    const result = await this.queueNotification({
      id: notificationId,
      deviceToken,
      payload: notification,
      priority,
      expiration,
      topic,
      collapseId
    })

    stream.respond({
      ':status': 200,
      'apns-id': notificationId
    })
  }
}
```

### Authentication

Providers authenticate using JWT tokens signed with their private key:

```javascript
async validateJWT(authHeader) {
  const token = authHeader.replace('bearer ', '')
  const decoded = jwt.decode(token, { complete: true })

  // Verify claims
  const { iss, iat } = decoded.payload
  if (!iss) return false  // iss = Team ID
  if (Date.now() - iat * 1000 > 3600000) return false  // Token < 1 hour old

  // Verify signature with provider's public key
  const publicKey = await this.getProviderPublicKey(iss, decoded.header.kid)
  return jwt.verify(token, publicKey)
}
```

### Priority Levels

| Priority | Use Case | Delivery Behavior |
|----------|----------|-------------------|
| 10 | User-visible alerts | Immediate delivery, wake device |
| 5 | Background updates | Deliver opportunistically, preserve battery |

## Deep Dive: Device Connection Management (7 minutes)

Managing persistent connections to hundreds of millions of devices is the most challenging aspect.

### Connection Architecture

```
+------------------+     +------------------+
|   Push Service   |     |   Push Service   |
|   (Shard 1)      |     |   (Shard N)      |
+------------------+     +------------------+
    |  |  |  |               |  |  |  |
    v  v  v  v               v  v  v  v
  [Device connections]    [Device connections]

Sharding strategy: hash(deviceId) % numShards
Each shard handles ~10M concurrent connections
```

### Connection Lifecycle

```javascript
class PushService {
  constructor(shardId) {
    this.shardId = shardId
    this.connections = new Map()  // deviceId -> connection
  }

  handleConnection(socket, deviceId) {
    const connection = new DeviceConnection(socket, deviceId)

    // Store connection
    this.connections.set(deviceId, connection)

    // Deliver queued notifications
    this.deliverPending(deviceId, connection)

    // Handle disconnection
    connection.on('close', () => {
      this.connections.delete(deviceId)
      // Update device status in Redis
      redis.del(`device:online:${deviceId}`)
    })

    // Handle acknowledgments
    connection.on('ack', (notificationId) => {
      this.markDelivered(notificationId)
    })

    // Update device status
    redis.set(`device:online:${deviceId}`, this.shardId)
  }

  async deliverNotification(notification) {
    const connection = this.connections.get(notification.deviceId)

    if (connection && connection.isAlive()) {
      // Device is online - deliver immediately
      try {
        await connection.send(notification)
        await this.markDelivered(notification.id)
        return { delivered: true }
      } catch (error) {
        // Connection failed, fall through to store
      }
    }

    // Device offline or delivery failed - store for later
    return this.storeForDelivery(notification)
  }
}
```

### Store-and-Forward

For offline devices, notifications are queued and delivered when the device reconnects:

```javascript
async storeForDelivery(notification) {
  const { expiration, priority, collapseId, deviceId } = notification

  // Check if notification already expired
  if (expiration && expiration < Date.now()) {
    return { expired: true }
  }

  // Store in database with UPSERT for collapse IDs
  await db.query(`
    INSERT INTO pending_notifications
      (id, device_id, payload, priority, expiration, collapse_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (device_id, collapse_id)
    DO UPDATE SET payload = $3, priority = $4
  `, [notification.id, deviceId, notification.payload,
      priority, expiration, collapseId])

  return { queued: true }
}

async onDeviceConnect(deviceId, connection) {
  // Fetch pending notifications
  const pending = await db.query(`
    SELECT * FROM pending_notifications
    WHERE device_id = $1
    AND (expiration IS NULL OR expiration > NOW())
    ORDER BY priority DESC, created_at ASC
  `, [deviceId])

  // Deliver in priority order
  for (const notification of pending.rows) {
    await connection.send(notification)
  }

  // Clean up delivered
  await db.query(
    'DELETE FROM pending_notifications WHERE device_id = $1',
    [deviceId]
  )
}
```

### Collapse IDs

Multiple notifications with the same collapse ID replace each other:

```javascript
// Example: Sports score updates
// Only the latest score is delivered
{ collapseId: 'nba-game-12345', payload: { score: '98-95' } }
{ collapseId: 'nba-game-12345', payload: { score: '100-95' } }  // Replaces above
{ collapseId: 'nba-game-12345', payload: { score: '102-97' } }  // Replaces above

// Device receives only: { score: '102-97' }
```

## Deep Dive: Token Lifecycle & Feedback (5 minutes)

Device tokens can become invalid for many reasons - app uninstalled, device wiped, token refresh. Providers need to know about invalid tokens.

### Token States

```
Created --> Active --> Inactive/Invalid
              |
              +--> Refreshed (new token)
```

### Token Registry

```javascript
class TokenRegistry {
  async registerToken(token, deviceInfo) {
    const tokenHash = sha256(token)

    await db.query(`
      INSERT INTO device_tokens
        (device_id, token_hash, app_bundle_id, device_info, is_valid)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (token_hash)
      DO UPDATE SET last_seen = NOW(), device_info = $4
    `, [deviceInfo.deviceId, tokenHash, deviceInfo.bundleId, deviceInfo])

    return { deviceId: deviceInfo.deviceId }
  }

  async invalidateToken(token, reason) {
    const tokenHash = sha256(token)

    await db.query(`
      UPDATE device_tokens
      SET is_valid = false, invalidated_at = NOW(), invalidation_reason = $2
      WHERE token_hash = $1
    `, [tokenHash, reason])

    // Queue feedback for provider
    await this.feedbackService.reportInvalidToken(token, reason)
  }
}
```

### Feedback Service

Providers poll for invalid tokens to clean up their databases:

```javascript
class FeedbackService {
  async getFeedback(appBundleId, since) {
    const feedback = await db.query(`
      SELECT token_hash, reason, timestamp
      FROM feedback_queue
      WHERE app_bundle_id = $1 AND timestamp > $2
      ORDER BY timestamp ASC
      LIMIT 1000
    `, [appBundleId, since])

    return feedback.rows
  }
}
```

**Common invalidation reasons:**
- `Unregistered` - App uninstalled or token explicitly invalidated
- `BadDeviceToken` - Token format is invalid
- `DeviceTokenNotForTopic` - Token doesn't match the topic/app

## Trade-offs and Alternatives (5 minutes)

### 1. HTTP/2 vs WebSocket for Provider API

**Chose: HTTP/2**
- Pro: Standard HTTP semantics, excellent tooling
- Pro: Multiplexing without custom protocol
- Pro: Header compression reduces overhead
- Con: Slightly more overhead than raw WebSocket
- Alternative: WebSocket (lower overhead but non-standard)

### 2. Persistent Connections vs Polling

**Chose: Persistent TCP connections**
- Pro: Immediate delivery (no polling delay)
- Pro: Battery efficient (no periodic wake-ups)
- Con: Requires maintaining millions of connections
- Alternative: Silent push + fetch (simpler but higher latency)

### 3. Store-and-Forward vs Drop if Offline

**Chose: Store-and-Forward**
- Pro: Guaranteed delivery when device comes online
- Pro: Support for expiration policies
- Con: Storage overhead
- Alternative: Drop notifications for offline devices (simpler but lossy)

### 4. Token Hashing

**Chose: Store hashed tokens**
- Pro: Security - tokens not exposed if DB breached
- Pro: Fixed-length for efficient indexing
- Con: Can't recover original token
- Alternative: Store plaintext (simpler but security risk)

### Database Schema

```sql
-- Device Tokens
CREATE TABLE device_tokens (
  device_id UUID PRIMARY KEY,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  device_info JSONB,
  is_valid BOOLEAN DEFAULT TRUE,
  invalidated_at TIMESTAMP,
  invalidation_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

-- Topic Subscriptions
CREATE TABLE topic_subscriptions (
  device_id UUID REFERENCES device_tokens(device_id),
  topic VARCHAR(200) NOT NULL,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (device_id, topic)
);

-- Pending Notifications (for offline devices)
CREATE TABLE pending_notifications (
  id UUID PRIMARY KEY,
  device_id UUID REFERENCES device_tokens(device_id),
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 10,
  expiration TIMESTAMP,
  collapse_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (device_id, collapse_id)
);

-- Feedback Queue
CREATE TABLE feedback_queue (
  id BIGSERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  app_bundle_id VARCHAR(200) NOT NULL,
  reason VARCHAR(50),
  timestamp TIMESTAMP NOT NULL
);
```

## Closing Summary (1 minute)

"The APNs architecture is built around three key principles:

1. **HTTP/2 for provider efficiency** - Using multiplexed streams, a single connection can handle thousands of concurrent notification requests with minimal overhead.

2. **Persistent device connections** - By maintaining long-lived connections to devices, we achieve immediate delivery without polling overhead, while being battery efficient.

3. **Store-and-forward reliability** - Notifications for offline devices are queued with priority ordering and expiration handling, ensuring delivery when the device reconnects.

The main trade-off is between latency and resource usage. We optimize for low latency by maintaining persistent connections, which requires significant infrastructure for connection management and sharding. The collapse ID feature is a nice touch that prevents notification spam while ensuring users see the latest update."
