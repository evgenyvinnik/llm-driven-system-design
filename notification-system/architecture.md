# Design Notification System - Architecture

## System Overview

A high-throughput notification system delivering messages across multiple channels (push, email, SMS, in-app) with reliability guarantees and user preference handling. Core challenges involve message routing, delivery guarantees, and scale.

**Learning Goals:**
- Build multi-channel message routing
- Design priority-based queue processing
- Implement delivery tracking and retries
- Handle user preferences at scale

---

## Requirements

### Functional Requirements

1. **Send**: Deliver notifications across channels
2. **Priority**: Process critical messages first
3. **Preferences**: Respect user notification settings
4. **Track**: Monitor delivery status
5. **Template**: Support dynamic content templates

### Non-Functional Requirements

- **Throughput**: 1M+ notifications per minute
- **Latency**: < 100ms for critical notifications
- **Reliability**: 99.99% delivery rate
- **Ordering**: Best-effort ordering within priority

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Gateway                                  │
│        (Notification requests from services)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Message Router                               │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │  Validation   │  │  Preferences  │  │   Routing     │       │
│  │               │  │               │  │               │       │
│  │ - Schema      │  │ - User prefs  │  │ - Channel     │       │
│  │ - Rate limit  │  │ - Quiet hours │  │ - Priority    │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Priority Queue│    │ Priority Queue│    │ Priority Queue│
│    (Push)     │    │   (Email)     │    │    (SMS)      │
│               │    │               │    │               │
│ Critical/High │    │ Critical/High │    │ Critical/High │
│ Normal/Low    │    │ Normal/Low    │    │ Normal/Low    │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Push Workers  │    │ Email Workers │    │  SMS Workers  │
│               │    │               │    │               │
│ - APNs        │    │ - SMTP        │    │ - Twilio      │
│ - FCM         │    │ - SendGrid    │    │ - Rate limit  │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Delivery Tracking                            │
│              (Status updates, receipts, analytics)               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Notification API

**Request Handling:**
```javascript
class NotificationAPI {
  async sendNotification(request) {
    const {
      userId,
      templateId,
      data,
      channels,
      priority = 'normal',
      scheduledAt
    } = request

    // Validate request
    await this.validate(request)

    // Generate notification ID for tracking
    const notificationId = uuid()

    // Check rate limits
    const rateLimited = await this.checkRateLimit(userId, channels)
    if (rateLimited) {
      throw new RateLimitError('User notification rate limit exceeded')
    }

    // Render template
    const content = await this.renderTemplate(templateId, data)

    // Get user preferences
    const preferences = await this.getPreferences(userId)

    // Filter channels based on preferences
    const allowedChannels = this.filterChannels(channels, preferences)

    if (allowedChannels.length === 0) {
      return { notificationId, status: 'suppressed', reason: 'user_preferences' }
    }

    // Check quiet hours
    if (this.isQuietHours(preferences) && priority !== 'critical') {
      // Schedule for end of quiet hours
      return this.scheduleAfterQuietHours(notificationId, request)
    }

    // Create notification record
    await db.query(`
      INSERT INTO notifications
        (id, user_id, template_id, content, channels, priority, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    `, [notificationId, userId, templateId, content, allowedChannels, priority])

    // Route to channel queues
    for (const channel of allowedChannels) {
      await this.routeToChannel(notificationId, channel, priority, content)
    }

    return { notificationId, status: 'queued', channels: allowedChannels }
  }

  async routeToChannel(notificationId, channel, priority, content) {
    const queueName = `notifications:${channel}:${priority}`

    await this.queue.publish(queueName, {
      notificationId,
      channel,
      content,
      queuedAt: Date.now()
    })
  }
}
```

### 2. Priority Queue System

**Multi-Priority Processing:**
```javascript
class NotificationQueue {
  constructor(channel) {
    this.channel = channel
    this.priorities = ['critical', 'high', 'normal', 'low']
  }

  async enqueue(notification, priority) {
    const score = this.calculateScore(priority, notification.queuedAt)

    // Use sorted set for priority ordering
    await redis.zadd(
      `queue:${this.channel}`,
      score,
      JSON.stringify(notification)
    )

    // Track queue depth for monitoring
    await this.updateMetrics()
  }

  calculateScore(priority, timestamp) {
    // Lower score = higher priority
    const priorityWeights = {
      critical: 0,
      high: 1000000000000,
      normal: 2000000000000,
      low: 3000000000000
    }

    return priorityWeights[priority] + timestamp
  }

  async dequeue(batchSize = 100) {
    // Atomically pop highest priority items
    const items = await redis.zpopmin(
      `queue:${this.channel}`,
      batchSize
    )

    return items.map(item => JSON.parse(item))
  }

  async getQueueDepth() {
    return {
      total: await redis.zcard(`queue:${this.channel}`),
      critical: await redis.zcount(`queue:${this.channel}`, 0, 999999999999),
      high: await redis.zcount(`queue:${this.channel}`, 1000000000000, 1999999999999),
      normal: await redis.zcount(`queue:${this.channel}`, 2000000000000, 2999999999999),
      low: await redis.zcount(`queue:${this.channel}`, 3000000000000, '-inf')
    }
  }
}
```

### 3. Push Notification Worker

**Multi-Platform Delivery:**
```javascript
class PushWorker {
  async processNotification(notification) {
    const { notificationId, content, userId } = notification

    // Get user's device tokens
    const devices = await this.getDevices(userId)
    if (devices.length === 0) {
      await this.markDelivered(notificationId, 'no_devices')
      return
    }

    const results = []

    for (const device of devices) {
      try {
        if (device.platform === 'ios') {
          await this.sendAPNs(device.token, content)
        } else if (device.platform === 'android') {
          await this.sendFCM(device.token, content)
        }

        results.push({ deviceId: device.id, status: 'sent' })
      } catch (error) {
        results.push({ deviceId: device.id, status: 'failed', error: error.message })

        // Handle invalid tokens
        if (this.isInvalidToken(error)) {
          await this.deregisterDevice(device.id)
        }
      }
    }

    // Update delivery status
    const allFailed = results.every(r => r.status === 'failed')
    await this.updateStatus(notificationId, 'push', allFailed ? 'failed' : 'sent', results)
  }

  async sendAPNs(token, content) {
    const notification = new apn.Notification({
      alert: {
        title: content.title,
        body: content.body
      },
      sound: content.sound || 'default',
      badge: content.badge,
      payload: content.data,
      topic: this.bundleId,
      expiry: Math.floor(Date.now() / 1000) + 3600
    })

    const result = await this.apnProvider.send(notification, token)

    if (result.failed.length > 0) {
      throw new Error(result.failed[0].response.reason)
    }
  }

  async sendFCM(token, content) {
    const message = {
      token,
      notification: {
        title: content.title,
        body: content.body
      },
      data: content.data,
      android: {
        priority: 'high',
        notification: {
          sound: content.sound || 'default',
          channelId: content.channelId || 'default'
        }
      }
    }

    await this.fcmClient.send(message)
  }
}
```

### 4. Email Worker

**Templated Email Delivery:**
```javascript
class EmailWorker {
  async processNotification(notification) {
    const { notificationId, content, userId } = notification

    // Get user email
    const user = await this.getUser(userId)
    if (!user.email || !user.emailVerified) {
      await this.markDelivered(notificationId, 'no_email')
      return
    }

    // Render email template
    const emailContent = await this.renderEmail(content)

    try {
      // Send via email provider
      const result = await this.sendEmail({
        to: user.email,
        from: emailContent.from || this.defaultFrom,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        headers: {
          'X-Notification-Id': notificationId,
          'List-Unsubscribe': this.getUnsubscribeUrl(userId)
        }
      })

      await this.updateStatus(notificationId, 'email', 'sent', {
        messageId: result.messageId
      })

      // Track for analytics
      await this.trackSend(notificationId, user.email)

    } catch (error) {
      if (this.isRetryable(error)) {
        await this.retry(notification, error)
      } else {
        await this.updateStatus(notificationId, 'email', 'failed', {
          error: error.message
        })
      }
    }
  }

  async sendEmail(params) {
    // Use SendGrid, SES, or other provider
    return await this.emailProvider.send({
      personalizations: [{
        to: [{ email: params.to }]
      }],
      from: { email: params.from },
      subject: params.subject,
      content: [
        { type: 'text/plain', value: params.text },
        { type: 'text/html', value: params.html }
      ],
      headers: params.headers,
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true }
      }
    })
  }
}
```

### 5. User Preferences

**Preference Management:**
```javascript
class PreferencesService {
  async getPreferences(userId) {
    // Check cache first
    const cached = await redis.get(`prefs:${userId}`)
    if (cached) {
      return JSON.parse(cached)
    }

    // Load from database
    const prefs = await db.query(`
      SELECT * FROM notification_preferences
      WHERE user_id = $1
    `, [userId])

    const preferences = prefs.rows[0] || this.getDefaults()

    // Cache for 5 minutes
    await redis.setex(`prefs:${userId}`, 300, JSON.stringify(preferences))

    return preferences
  }

  async updatePreferences(userId, updates) {
    await db.query(`
      INSERT INTO notification_preferences
        (user_id, channels, categories, quiet_hours_start, quiet_hours_end)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        channels = COALESCE($2, notification_preferences.channels),
        categories = COALESCE($3, notification_preferences.categories),
        quiet_hours_start = COALESCE($4, notification_preferences.quiet_hours_start),
        quiet_hours_end = COALESCE($5, notification_preferences.quiet_hours_end),
        updated_at = NOW()
    `, [
      userId,
      updates.channels,
      updates.categories,
      updates.quietHoursStart,
      updates.quietHoursEnd
    ])

    // Invalidate cache
    await redis.del(`prefs:${userId}`)
  }

  filterChannels(requestedChannels, preferences) {
    return requestedChannels.filter(channel => {
      return preferences.channels[channel]?.enabled !== false
    })
  }

  isQuietHours(preferences) {
    if (!preferences.quietHoursStart || !preferences.quietHoursEnd) {
      return false
    }

    const now = new Date()
    const currentMinutes = now.getHours() * 60 + now.getMinutes()
    const start = preferences.quietHoursStart
    const end = preferences.quietHoursEnd

    if (start < end) {
      return currentMinutes >= start && currentMinutes < end
    } else {
      // Quiet hours span midnight
      return currentMinutes >= start || currentMinutes < end
    }
  }

  getDefaults() {
    return {
      channels: {
        push: { enabled: true },
        email: { enabled: true },
        sms: { enabled: false }
      },
      categories: {},
      quietHoursStart: null,
      quietHoursEnd: null
    }
  }
}
```

### 6. Rate Limiting

**Multi-Level Rate Limits:**
```javascript
class RateLimiter {
  async checkLimit(userId, channels) {
    const limits = {
      // Per-user limits
      user: {
        push: { count: 50, window: 3600 },    // 50/hour
        email: { count: 10, window: 3600 },   // 10/hour
        sms: { count: 5, window: 3600 }       // 5/hour
      },
      // Global limits (protect downstream services)
      global: {
        push: { count: 100000, window: 60 },  // 100k/min
        email: { count: 10000, window: 60 },  // 10k/min
        sms: { count: 1000, window: 60 }      // 1k/min
      }
    }

    for (const channel of channels) {
      // Check user limit
      const userKey = `ratelimit:user:${userId}:${channel}`
      const userCount = await redis.incr(userKey)
      if (userCount === 1) {
        await redis.expire(userKey, limits.user[channel].window)
      }
      if (userCount > limits.user[channel].count) {
        return { limited: true, reason: 'user_limit', channel }
      }

      // Check global limit
      const globalKey = `ratelimit:global:${channel}`
      const globalCount = await redis.incr(globalKey)
      if (globalCount === 1) {
        await redis.expire(globalKey, limits.global[channel].window)
      }
      if (globalCount > limits.global[channel].count) {
        return { limited: true, reason: 'global_limit', channel }
      }
    }

    return { limited: false }
  }

  async getUsage(userId) {
    const channels = ['push', 'email', 'sms']
    const usage = {}

    for (const channel of channels) {
      const count = await redis.get(`ratelimit:user:${userId}:${channel}`)
      usage[channel] = parseInt(count) || 0
    }

    return usage
  }
}
```

### 7. Delivery Tracking

**Status and Analytics:**
```javascript
class DeliveryTracker {
  async updateStatus(notificationId, channel, status, details = {}) {
    await db.query(`
      INSERT INTO delivery_status
        (notification_id, channel, status, details, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (notification_id, channel)
      DO UPDATE SET
        status = $3,
        details = delivery_status.details || $4,
        updated_at = NOW()
    `, [notificationId, channel, status, details])

    // Update aggregate notification status
    await this.updateNotificationStatus(notificationId)

    // Emit event for real-time tracking
    await this.emitStatusChange(notificationId, channel, status)
  }

  async updateNotificationStatus(notificationId) {
    const statuses = await db.query(`
      SELECT channel, status FROM delivery_status
      WHERE notification_id = $1
    `, [notificationId])

    // Determine overall status
    const allSent = statuses.rows.every(s => s.status === 'sent')
    const allFailed = statuses.rows.every(s => s.status === 'failed')
    const anyPending = statuses.rows.some(s => s.status === 'pending')

    let overallStatus
    if (allSent) overallStatus = 'delivered'
    else if (allFailed) overallStatus = 'failed'
    else if (anyPending) overallStatus = 'partial'
    else overallStatus = 'partial_success'

    await db.query(`
      UPDATE notifications
      SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE NULL END
      WHERE id = $1
    `, [notificationId, overallStatus])
  }

  async trackOpen(notificationId, channel) {
    await db.query(`
      INSERT INTO notification_events
        (notification_id, channel, event_type, occurred_at)
      VALUES ($1, $2, 'opened', NOW())
    `, [notificationId, channel])

    // Update analytics
    await this.incrementMetric('opens', channel)
  }

  async trackClick(notificationId, channel, linkId) {
    await db.query(`
      INSERT INTO notification_events
        (notification_id, channel, event_type, metadata, occurred_at)
      VALUES ($1, $2, 'clicked', $3, NOW())
    `, [notificationId, channel, { linkId }])

    await this.incrementMetric('clicks', channel)
  }

  async getDeliveryStats(timeRange) {
    const stats = await db.query(`
      SELECT
        channel,
        status,
        COUNT(*) as count
      FROM delivery_status
      WHERE updated_at >= NOW() - $1::interval
      GROUP BY channel, status
    `, [timeRange])

    return this.formatStats(stats.rows)
  }
}
```

---

## Database Schema

```sql
-- Notifications
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  template_id VARCHAR(100),
  content JSONB NOT NULL,
  channels TEXT[] NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status) WHERE status = 'pending';

-- Delivery status per channel
CREATE TABLE delivery_status (
  notification_id UUID REFERENCES notifications(id),
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  details JSONB DEFAULT '{}',
  attempts INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, channel)
);

CREATE INDEX idx_delivery_status ON delivery_status(status, updated_at);

-- User preferences
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY,
  channels JSONB DEFAULT '{}',
  categories JSONB DEFAULT '{}',
  quiet_hours_start INTEGER, -- minutes from midnight
  quiet_hours_end INTEGER,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Device tokens
CREATE TABLE device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform VARCHAR(20) NOT NULL, -- ios, android, web
  token TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used TIMESTAMP
);

CREATE UNIQUE INDEX idx_device_token ON device_tokens(token);
CREATE INDEX idx_device_user ON device_tokens(user_id) WHERE active = true;

-- Notification events (opens, clicks)
CREATE TABLE notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES notifications(id),
  channel VARCHAR(20),
  event_type VARCHAR(20),
  metadata JSONB,
  occurred_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_events_notification ON notification_events(notification_id);
CREATE INDEX idx_events_time ON notification_events(occurred_at);

-- Templates
CREATE TABLE notification_templates (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200),
  channels JSONB NOT NULL, -- { push: {...}, email: {...} }
  variables TEXT[],
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Priority Queues

**Decision**: Separate queue per channel with priority scoring

**Rationale**:
- Critical notifications bypass normal queue
- Channel-specific workers scale independently
- Prevents one channel from blocking others

### 2. At-Least-Once Delivery

**Decision**: Retry failed deliveries with backoff

**Rationale**:
- Users prefer duplicate over missing
- Idempotent handling on client
- Clear visibility into failures

### 3. User Preference Caching

**Decision**: Cache preferences with 5-minute TTL

**Rationale**:
- Preferences rarely change
- High read volume per user
- Acceptable staleness

---

## Authentication and Authorization

### Session-Based Authentication

For local development, we use Redis-backed sessions with Express middleware:

```javascript
// Session configuration
const sessionConfig = {
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}

app.use(session(sessionConfig))
```

### Role-Based Access Control (RBAC)

**User Roles:**
| Role | Description | Permissions |
|------|-------------|-------------|
| `user` | End user | Send notifications to self, manage own preferences, view own delivery status |
| `service` | Internal service | Send notifications to any user, access bulk endpoints, view aggregate stats |
| `admin` | System admin | All service permissions plus: manage templates, configure rate limits, access all user data |

**Permission Boundaries:**

```javascript
// Middleware for role checking
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.session?.user) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }

    next()
  }
}

// Route protection examples
app.post('/api/v1/notifications', requireRole('user', 'service', 'admin'), sendNotification)
app.post('/api/v1/notifications/bulk', requireRole('service', 'admin'), sendBulkNotifications)
app.get('/api/v1/admin/templates', requireRole('admin'), listTemplates)
app.put('/api/v1/admin/rate-limits', requireRole('admin'), updateRateLimits)
```

### API Endpoint Authorization Matrix

| Endpoint | User | Service | Admin | Description |
|----------|------|---------|-------|-------------|
| `POST /notifications` | Own only | Any user | Any user | Send notification |
| `GET /notifications/:id` | Own only | Any | Any | Get notification status |
| `GET /preferences` | Own only | - | Any user | Get preferences |
| `PUT /preferences` | Own only | - | Any user | Update preferences |
| `GET /admin/stats` | - | Read-only | Full | Delivery statistics |
| `POST /admin/templates` | - | - | Full | Manage templates |
| `PUT /admin/rate-limits` | - | - | Full | Configure limits |

### Rate Limit Configuration by Role

```javascript
const rateLimitsByRole = {
  user: {
    push: { count: 50, window: 3600 },   // 50/hour
    email: { count: 10, window: 3600 },  // 10/hour
    sms: { count: 5, window: 3600 }      // 5/hour
  },
  service: {
    push: { count: 10000, window: 60 },  // 10k/minute
    email: { count: 1000, window: 60 },  // 1k/minute
    sms: { count: 100, window: 60 }      // 100/minute
  },
  admin: {
    // No rate limits for admin (use global limits only)
    push: { count: Infinity, window: 60 },
    email: { count: Infinity, window: 60 },
    sms: { count: Infinity, window: 60 }
  }
}
```

---

## Failure Handling and Reliability

### Idempotency Keys

All notification sends use client-provided idempotency keys to prevent duplicate deliveries:

```javascript
class NotificationService {
  async sendNotification(request, idempotencyKey) {
    // Check for existing notification with this key
    const existing = await redis.get(`idempotency:${idempotencyKey}`)
    if (existing) {
      return JSON.parse(existing) // Return cached response
    }

    // Process notification
    const result = await this.processNotification(request)

    // Cache result for 24 hours
    await redis.setex(
      `idempotency:${idempotencyKey}`,
      86400,
      JSON.stringify(result)
    )

    return result
  }
}
```

**Idempotency Key Format:**
```
# Client-generated keys (recommended)
{service-name}:{entity-id}:{action}:{timestamp}
# Example: order-service:order-12345:confirmation:1704067200
```

### Retry Strategy with Exponential Backoff

```javascript
class RetryHandler {
  constructor() {
    this.maxRetries = 5
    this.baseDelay = 1000 // 1 second
    this.maxDelay = 300000 // 5 minutes
  }

  async executeWithRetry(operation, context) {
    let lastError

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error

        if (!this.isRetryable(error) || attempt === this.maxRetries) {
          await this.sendToDeadLetter(context, error)
          throw error
        }

        const delay = this.calculateDelay(attempt)
        console.log(`Retry ${attempt + 1}/${this.maxRetries} in ${delay}ms`)
        await this.sleep(delay)
      }
    }

    throw lastError
  }

  calculateDelay(attempt) {
    // Exponential backoff with jitter
    const exponentialDelay = this.baseDelay * Math.pow(2, attempt)
    const jitter = Math.random() * 1000
    return Math.min(exponentialDelay + jitter, this.maxDelay)
  }

  isRetryable(error) {
    // Retry on transient errors only
    const retryableCodes = [429, 500, 502, 503, 504]
    return retryableCodes.includes(error.statusCode) ||
           error.code === 'ECONNRESET' ||
           error.code === 'ETIMEDOUT'
  }
}
```

**Retry Schedule:**
| Attempt | Delay | Cumulative Time |
|---------|-------|-----------------|
| 1 | ~1s | ~1s |
| 2 | ~2s | ~3s |
| 3 | ~4s | ~7s |
| 4 | ~8s | ~15s |
| 5 | ~16s | ~31s |

### Circuit Breaker Pattern

Protects downstream services (APNs, SendGrid, Twilio) from cascading failures:

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000 // 30 seconds
    this.halfOpenRequests = options.halfOpenRequests || 3

    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.successes = 0
    this.lastFailure = null
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'HALF_OPEN'
        this.successes = 0
      } else {
        throw new Error('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    if (this.state === 'HALF_OPEN') {
      this.successes++
      if (this.successes >= this.halfOpenRequests) {
        this.state = 'CLOSED'
      }
    }
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
    }
  }
}

// Usage per channel provider
const apnsBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
const fcmBreaker = new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
const sendgridBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 })
const twilioBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 60000 })
```

### Dead Letter Queue Handling

Failed notifications after all retries go to a dead letter queue for manual review:

```javascript
class DeadLetterHandler {
  async sendToDeadLetter(notification, error) {
    await db.query(`
      INSERT INTO dead_letter_notifications
        (notification_id, original_payload, error_message, error_code, failed_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [
      notification.id,
      JSON.stringify(notification),
      error.message,
      error.code || 'UNKNOWN'
    ])

    // Alert on DLQ growth
    const dlqCount = await this.getDLQCount()
    if (dlqCount > 100) {
      await this.alertOps('DLQ count exceeded threshold', { count: dlqCount })
    }
  }

  async reprocessDLQ(batchSize = 10) {
    const items = await db.query(`
      SELECT * FROM dead_letter_notifications
      WHERE reprocessed_at IS NULL
      ORDER BY failed_at ASC
      LIMIT $1
    `, [batchSize])

    for (const item of items.rows) {
      try {
        await notificationService.sendNotification(JSON.parse(item.original_payload))
        await db.query(`
          UPDATE dead_letter_notifications
          SET reprocessed_at = NOW(), reprocess_status = 'success'
          WHERE id = $1
        `, [item.id])
      } catch (error) {
        await db.query(`
          UPDATE dead_letter_notifications
          SET reprocess_attempts = reprocess_attempts + 1,
              last_error = $2
          WHERE id = $1
        `, [item.id, error.message])
      }
    }
  }
}
```

### Backup and Restore Strategy (Local Development)

**Backup Script:**
```bash
#!/bin/bash
# backup.sh - Run daily via cron

BACKUP_DIR="/backups/notification-system"
DATE=$(date +%Y%m%d_%H%M%S)

# PostgreSQL backup
pg_dump -h localhost -U postgres notification_db > "$BACKUP_DIR/postgres_$DATE.sql"

# Redis backup (RDB snapshot)
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb "$BACKUP_DIR/redis_$DATE.rdb"

# Keep last 7 days
find "$BACKUP_DIR" -mtime +7 -delete
```

**Restore Script:**
```bash
#!/bin/bash
# restore.sh - Restore from backup

BACKUP_FILE=$1

# Stop services
docker-compose stop notification-api notification-worker

# Restore PostgreSQL
psql -h localhost -U postgres -d notification_db < "$BACKUP_FILE"

# Restart services
docker-compose start notification-api notification-worker
```

**Testing Backup/Restore (Quarterly):**
1. Create test notifications in staging
2. Run backup script
3. Drop and recreate database
4. Run restore script
5. Verify notification delivery status matches pre-backup state

---

## Cost Optimization and Resource Tradeoffs

### Storage Tiering

For a local development environment, we optimize for learning rather than cost, but the same principles apply:

**Notification Data Lifecycle:**
| Age | Storage | Retention | Access Pattern |
|-----|---------|-----------|----------------|
| 0-7 days | PostgreSQL (hot) | Full detail | High (status checks) |
| 7-30 days | PostgreSQL (warm) | Full detail | Medium (analytics) |
| 30-90 days | PostgreSQL (archive) | Summary only | Low (compliance) |
| 90+ days | Export to file/delete | N/A | Rare (audit) |

```sql
-- Partition notifications table by month
CREATE TABLE notifications (
  id UUID,
  user_id UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  -- ... other columns
) PARTITION BY RANGE (created_at);

CREATE TABLE notifications_current PARTITION OF notifications
  FOR VALUES FROM (CURRENT_DATE - INTERVAL '30 days') TO (MAXVALUE);

CREATE TABLE notifications_archive PARTITION OF notifications
  FOR VALUES FROM (MINVALUE) TO (CURRENT_DATE - INTERVAL '30 days');

-- Archive old notifications (run weekly)
-- For local dev, just delete after 30 days to save disk space
DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM notification_events WHERE occurred_at < NOW() - INTERVAL '30 days';
DELETE FROM delivery_status WHERE updated_at < NOW() - INTERVAL '30 days';
```

### Cache Sizing Guidelines

**Redis Memory Allocation (Local Development):**
| Cache Type | Max Size | TTL | Eviction Policy |
|------------|----------|-----|-----------------|
| User preferences | 50 MB | 5 min | LRU |
| Rate limit counters | 20 MB | 1 hour | Automatic expiry |
| Idempotency keys | 30 MB | 24 hours | Automatic expiry |
| Session data | 50 MB | 24 hours | LRU |
| **Total** | **150 MB** | - | - |

```bash
# redis.conf for local development
maxmemory 256mb
maxmemory-policy allkeys-lru
```

**Cache Hit Rate Targets:**
- User preferences: >95% (high read volume)
- Rate limit counters: 100% (always in Redis)
- Sessions: >90% (frequent access)

### Queue Retention Settings

**RabbitMQ Configuration:**
```javascript
// Queue declarations with TTL and limits
const queueOptions = {
  durable: true,
  arguments: {
    'x-message-ttl': 86400000,     // Messages expire after 24 hours
    'x-max-length': 100000,         // Max 100k messages per queue
    'x-overflow': 'reject-publish', // Reject new messages when full
    'x-dead-letter-exchange': 'dlx' // Route expired/rejected to DLX
  }
}

// Channel-specific settings
const channelQueues = {
  push: { maxLength: 100000, ttl: 3600000 },    // 100k, 1 hour TTL
  email: { maxLength: 50000, ttl: 86400000 },   // 50k, 24 hour TTL
  sms: { maxLength: 10000, ttl: 3600000 }       // 10k, 1 hour TTL
}
```

**Queue Depth Alerts:**
```javascript
// Monitor queue depth and alert
async function monitorQueues() {
  const thresholds = { push: 50000, email: 25000, sms: 5000 }

  for (const [channel, threshold] of Object.entries(thresholds)) {
    const depth = await getQueueDepth(channel)
    if (depth > threshold) {
      console.warn(`Queue ${channel} depth ${depth} exceeds threshold ${threshold}`)
    }
  }
}
```

### Compute vs Storage Optimization

**Local Development Resource Budget:**
| Component | CPU | Memory | Disk | Notes |
|-----------|-----|--------|------|-------|
| PostgreSQL | 1 core | 512 MB | 2 GB | Single instance |
| Redis | 0.5 core | 256 MB | 100 MB | In-memory only |
| RabbitMQ | 0.5 core | 256 MB | 500 MB | Persistent queues |
| API Server | 0.5 core | 256 MB | - | Node.js |
| Workers (x3) | 0.5 core each | 128 MB each | - | One per channel |
| **Total** | **4 cores** | **~2 GB** | **~3 GB** | Fits in 8 GB laptop |

**Tradeoff Decisions:**

1. **Preference Caching vs Database Queries**
   - Cache: 50 MB Redis, ~$0.01/day equivalent
   - No cache: ~1000 extra DB queries/min, higher DB CPU
   - **Decision**: Cache with 5-min TTL (preferences rarely change)

2. **Queue Persistence vs Speed**
   - Persistent: Survives restarts, slight write overhead
   - Transient: Faster, lose messages on crash
   - **Decision**: Persistent for learning reliability patterns

3. **Notification Retention vs Disk Space**
   - Keep all: ~100 MB/month growth for 10k notifications/day
   - 30-day retention: ~100 MB steady state
   - **Decision**: 30-day retention for local dev, configurable for prod

4. **Worker Count vs Message Latency**
   - More workers: Lower latency, higher resource use
   - Fewer workers: Higher latency, lower resource use
   - **Decision**: 1 worker per channel (3 total) for local dev

```javascript
// Configuration for different environments
const envConfig = {
  development: {
    workers: { push: 1, email: 1, sms: 1 },
    batchSize: 10,
    cacheSize: '256mb'
  },
  production: {
    workers: { push: 5, email: 3, sms: 2 },
    batchSize: 100,
    cacheSize: '2gb'
  }
}
```

---

## Implementation Notes

This section documents the production-ready reliability features implemented in the codebase and explains **why** each improvement matters for a high-throughput notification system.

### 1. Structured Logging with Pino

**File:** `backend/src/utils/logger.js`

**What we implemented:**
- Pino-based structured JSON logging with consistent field names
- Component-specific child loggers for tracing
- Request correlation IDs (X-Request-ID header support)
- Sensitive field redaction (authorization headers, tokens)
- Performance timing helper for async operations

**Why this improves the system:**

| Problem | Solution | Benefit |
|---------|----------|---------|
| Console.log scattered everywhere | Centralized logger with levels | Filter logs by severity in production |
| Can't trace requests across services | Request correlation IDs | Debug distributed flows end-to-end |
| Logs are unstructured text | JSON output with standard fields | Parse logs with ELK/Loki/Datadog |
| Secrets leak in logs | Redact sensitive paths | Security compliance |

**Usage example:**
```javascript
import { createLogger } from '../utils/logger.js';
const log = createLogger('notification-service');

log.info({ userId, notificationId }, 'Notification queued successfully');
log.error({ err: error, userId }, 'Failed to send notification');
```

### 2. Prometheus Metrics

**File:** `backend/src/utils/metrics.js`

**What we implemented:**
- Counter: `notifications_sent_total` by channel, priority, status
- Counter: `delivery_attempts_total` by channel, success/failure
- Histogram: `processing_duration_seconds` for latency percentiles
- Histogram: `http_request_duration_seconds` for API latency
- Gauge: `queue_depth` by queue and priority
- Gauge: `circuit_breaker_state` per channel (0=closed, 1=open, 2=half-open)
- Counter: `rate_limited_total`, `deduplicated_total`, `retries_total`

**Why this improves the system:**

| Metric Type | Use Case | Alert Threshold Example |
|-------------|----------|-------------------------|
| Counter (sent) | Throughput monitoring | Rate drops > 50% in 5 min |
| Histogram (latency) | SLO tracking | p99 > 500ms for critical |
| Gauge (queue depth) | Backpressure detection | Depth > 10k for 10 min |
| Gauge (circuit breaker) | Provider health | State = 1 (open) |

**Endpoints:**
- `GET /metrics` - Prometheus scrape endpoint
- Integrates with Grafana for visualization

### 3. Enhanced Health Checks

**File:** `backend/src/index.js`

**What we implemented:**
- `/health` - Comprehensive check with component status and circuit breaker states
- `/health/live` - Simple liveness probe (process is running)
- `/health/ready` - Readiness probe (dependencies available)

**Why this improves the system:**

```
Kubernetes/Load Balancer Integration:

livenessProbe:
  httpGet:
    path: /health/live  <- Restart if this fails
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /health/ready  <- Remove from rotation if this fails
    port: 3001
  periodSeconds: 5
```

| Check Type | Failure Response | Recovery Action |
|------------|------------------|-----------------|
| Liveness | 200 OK | None - pod is alive |
| Readiness | 503 | Remove from load balancer |
| Full health | Degraded | Alert ops, continue serving |

**Response example:**
```json
{
  "status": "degraded",
  "timestamp": "2024-01-15T10:30:00Z",
  "uptime": 3600,
  "components": {
    "postgres": { "status": "healthy", "latencyMs": 2 },
    "redis": { "status": "healthy", "latencyMs": 1 },
    "rabbitmq": { "status": "healthy" }
  },
  "circuitBreakers": {
    "push": "closed",
    "email": "open",
    "sms": "closed"
  }
}
```

### 4. Circuit Breaker for Delivery Channels

**File:** `backend/src/utils/circuitBreaker.js`

**What we implemented:**
- Per-channel circuit breakers (push, email, SMS)
- Consecutive failure threshold (5 failures opens circuit)
- Half-open testing after 30-60 seconds
- State change logging and Prometheus metrics
- Integration with Cockatiel library for production-grade implementation

**Why this improves the system:**

Without circuit breaker:
```
Provider outage -> All workers blocked waiting on timeouts
                -> Queue backs up exponentially
                -> Memory exhaustion / cascading failure
```

With circuit breaker:
```
Provider outage -> 5 failures trigger OPEN state
                -> Immediate rejection (no timeout wait)
                -> Workers process other channels
                -> Half-open tests recovery
                -> Auto-close when provider healthy
```

**Configuration per channel:**
```javascript
const configs = {
  push: { consecutiveFailures: 5, halfOpenAfter: 30000 },   // APNs/FCM are reliable
  email: { consecutiveFailures: 3, halfOpenAfter: 60000 },  // SMTP more sensitive
  sms: { consecutiveFailures: 3, halfOpenAfter: 60000 }     // Carrier APIs rate limit
};
```

### 5. Idempotency for Notifications

**File:** `backend/src/utils/idempotency.js`

**What we implemented:**
- Client-provided idempotency key support
- Redis-backed key storage with 24-hour TTL
- Processing state tracking to detect concurrent duplicates
- Automatic result caching for repeated requests
- Conflict detection (409 response for in-flight duplicates)

**Why this improves the system:**

| Failure Scenario | Without Idempotency | With Idempotency |
|------------------|---------------------|------------------|
| Client network timeout | Retry sends duplicate | Returns cached result |
| Service restart mid-request | Retry sends duplicate | Returns cached result |
| Load balancer retry | Sends to two instances | Second returns cached |

**API usage:**
```javascript
// Client sends
POST /api/v1/notifications
{
  "idempotencyKey": "order-service:order-123:confirmation:1704067200",
  "userId": "...",
  "templateId": "order_confirmation"
}

// First request: processes and caches result
// Retry request: returns cached result immediately
```

**Key format recommendation:**
```
{service-name}:{entity-id}:{action}:{timestamp}
order-service:order-123:confirmation:1704067200
```

### 6. Retry with Exponential Backoff

**File:** `backend/src/utils/retry.js`

**What we implemented:**
- Configurable max retries, base delay, max delay
- Exponential backoff with jitter (prevents thundering herd)
- Retryable error detection (status codes, network errors)
- Preset configurations (fast, standard, slow, aggressive)
- Integration with Prometheus retry counter

**Why this improves the system:**

Fixed retry interval problem:
```
10,000 requests fail at t=0
All retry at t+5s -> provider overwhelmed -> all fail
All retry at t+10s -> same problem
```

Exponential backoff with jitter:
```
10,000 requests fail at t=0
Retry spread: t+1s...t+2s (random)
Retry 2 spread: t+3s...t+6s
Load distributed, provider can recover
```

**Retry schedule (standard preset):**
| Attempt | Base Delay | With Jitter | Cumulative |
|---------|------------|-------------|------------|
| 1 | 1s | 1.0-1.1s | ~1s |
| 2 | 2s | 2.0-2.2s | ~3s |
| 3 | 4s | 4.0-4.4s | ~7s |
| 4 | 8s | 8.0-8.8s | ~15s |
| 5 | 16s | 16.0-17.6s | ~32s |

### 7. Graceful Shutdown

**File:** `backend/src/index.js`, `backend/src/workers/index.js`

**What we implemented:**
- SIGTERM/SIGINT signal handlers
- Stop accepting new connections
- Wait for in-flight requests to complete
- Close database and Redis connections cleanly
- 30-second timeout for forced shutdown

**Why this improves the system:**

| Shutdown Type | Without Graceful | With Graceful |
|---------------|------------------|---------------|
| Rolling deploy | Dropped requests, broken connections | Zero dropped requests |
| Scale down | Lost queue messages | Messages acked or requeued |
| Emergency stop | Corrupted state possible | Clean state guaranteed |

### Architecture Impact Summary

These improvements address the Codex feedback systematically:

1. **Authentication/Authorization** (already documented):
   - Session-based auth with Redis backing
   - RBAC with user/service/admin roles
   - Rate limits by role

2. **Failure Handling** (now implemented):
   - Idempotency keys prevent duplicates
   - Circuit breakers prevent cascading failures
   - Exponential backoff with jitter for retries
   - Dead letter queue for persistent failures
   - Graceful shutdown preserves state

3. **Observability** (now implemented):
   - Structured logging for debugging
   - Prometheus metrics for alerting
   - Health checks for orchestration

4. **Cost Tradeoffs** (already documented):
   - Storage tiering strategy
   - Cache sizing guidelines
   - Queue retention settings
   - Compute vs storage optimization

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Queue | Priority sorted set | Separate queues | Simpler, flexible |
| Delivery | At-least-once | Exactly-once | Reliability |
| Rate limit | Per-user + global | Per-user only | Protect downstream |
| Preferences | Cached | Real-time | Performance |
| Tracking | Async events | Sync update | Throughput |
| Auth | Session + RBAC | JWT tokens | Simpler for local dev |
| Retries | Exponential backoff | Fixed interval | Prevents thundering herd |
| Circuit breaker | Per-provider | Global | Isolate failures by channel |
| Storage | 30-day retention | Unlimited | Bounded disk usage |
| Cache | 256 MB Redis | Larger cache | Fits local dev constraints |
| Logging | Pino structured JSON | Console.log | Queryable, machine-readable |
| Metrics | Prometheus counters/histograms | Custom tracking | Industry standard, Grafana compatible |
| Health checks | Three-tier (live/ready/full) | Single endpoint | Kubernetes-native deployment |
| Idempotency | Redis with 24h TTL | Database | Low latency, automatic cleanup |
