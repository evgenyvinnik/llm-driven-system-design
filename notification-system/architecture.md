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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Queue | Priority sorted set | Separate queues | Simpler, flexible |
| Delivery | At-least-once | Exactly-once | Reliability |
| Rate limit | Per-user + global | Per-user only | Protect downstream |
| Preferences | Cached | Real-time | Performance |
| Tracking | Async events | Sync update | Throughput |
