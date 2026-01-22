# Notification System - Backend Engineer Interview Answer

## System Design Interview (45 minutes)

### Opening Statement (1 minute)

"I'll design the backend infrastructure for a high-throughput notification system delivering messages across push, email, SMS, and in-app channels. The core challenge is processing millions of notifications per minute while respecting user preferences, managing delivery priorities, and ensuring reliable delivery with appropriate retry strategies.

From a backend perspective, I'll focus on priority queue design, multi-channel worker architecture, rate limiting strategies, and delivery tracking with comprehensive retry logic."

---

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Multi-Channel Delivery**: Push (iOS/Android), Email, SMS, In-App
- **Priority Handling**: Critical notifications bypass normal queues
- **User Preferences**: Respect opt-outs, quiet hours, channel preferences
- **Template System**: Dynamic content with variable substitution
- **Delivery Tracking**: Status tracking, open/click analytics

### Non-Functional Requirements
- **Throughput**: 1M+ notifications per minute
- **Latency**: < 100ms for critical notifications
- **Reliability**: 99.99% delivery rate
- **Ordering**: Best-effort ordering within priority level

### Scale Estimates
- **Notifications/day**: 1 billion+
- **Peak rate**: 20,000+ per second
- **Channels**: 4 (push, email, SMS, in-app)
- **Users**: 100M+ with preferences to manage

---

## Deep Dive: Priority Queue System (10 minutes)

### Queue Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Message Router                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Validation   │  │ Preferences  │  │ Routing      │      │
│  │ - Schema     │  │ - User prefs │  │ - Channel    │      │
│  │ - Rate limit │  │ - Quiet hours│  │ - Priority   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
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
```

### Priority Scoring with Redis Sorted Sets

```javascript
class NotificationQueue {
  constructor(channel) {
    this.channel = channel;
    this.priorities = ['critical', 'high', 'normal', 'low'];
  }

  async enqueue(notification, priority) {
    const score = this.calculateScore(priority, notification.queuedAt);

    // Redis sorted set - lower score = higher priority
    await redis.zadd(
      `queue:${this.channel}`,
      score,
      JSON.stringify(notification)
    );

    // Track queue metrics
    await this.updateMetrics();
  }

  calculateScore(priority, timestamp) {
    // Priority determines the "bucket", timestamp orders within bucket
    const priorityWeights = {
      critical: 0,                  // 0-999B: Processed first
      high:     1_000_000_000_000,  // 1T-2T: After critical
      normal:   2_000_000_000_000,  // 2T-3T: Standard processing
      low:      3_000_000_000_000   // 3T+: Best effort
    };

    return priorityWeights[priority] + timestamp;
  }

  async dequeue(batchSize = 100) {
    // Atomically pop highest priority items
    const items = await redis.zpopmin(
      `queue:${this.channel}`,
      batchSize
    );

    return items.map(item => JSON.parse(item));
  }

  async getQueueDepth() {
    return {
      total: await redis.zcard(`queue:${this.channel}`),
      critical: await redis.zcount(`queue:${this.channel}`, 0, 999_999_999_999),
      high: await redis.zcount(`queue:${this.channel}`, 1_000_000_000_000, 1_999_999_999_999),
      normal: await redis.zcount(`queue:${this.channel}`, 2_000_000_000_000, 2_999_999_999_999),
      low: await redis.zcount(`queue:${this.channel}`, 3_000_000_000_000, Infinity)
    };
  }
}
```

### Why Sorted Sets Over Separate Queues?

| Approach | Pros | Cons |
|----------|------|------|
| Separate queues per priority | Simple logic | Must poll all queues |
| Single sorted set | Atomic dequeue | Score calculation |
| Multiple lists with polling | Simple | Priority inversion risk |

Sorted sets let us atomically pop the highest-priority items in O(log N) without polling multiple queues.

### RabbitMQ Alternative Implementation

```javascript
class RabbitMQPriorityQueue {
  constructor(channel) {
    this.channel = channel;
    this.exchangeName = `notifications.${channel}`;
    this.queuesByPriority = {
      critical: `${channel}.critical`,
      high: `${channel}.high`,
      normal: `${channel}.normal`,
      low: `${channel}.low`
    };
  }

  async initialize() {
    await this.amqpChannel.assertExchange(this.exchangeName, 'direct', { durable: true });

    for (const [priority, queueName] of Object.entries(this.queuesByPriority)) {
      await this.amqpChannel.assertQueue(queueName, {
        durable: true,
        arguments: {
          'x-message-ttl': this.getTTL(priority),
          'x-dead-letter-exchange': 'notifications.dlx'
        }
      });
      await this.amqpChannel.bindQueue(queueName, this.exchangeName, priority);
    }
  }

  getTTL(priority) {
    // Critical notifications expire fastest - must be delivered quickly
    const ttls = {
      critical: 60_000,     // 1 minute
      high: 300_000,        // 5 minutes
      normal: 3_600_000,    // 1 hour
      low: 86_400_000       // 24 hours
    };
    return ttls[priority];
  }

  async publish(notification, priority) {
    const message = Buffer.from(JSON.stringify(notification));

    await this.amqpChannel.publish(
      this.exchangeName,
      priority,
      message,
      {
        persistent: true,
        contentType: 'application/json',
        messageId: notification.id,
        timestamp: Date.now()
      }
    );
  }
}
```

---

## Deep Dive: Multi-Channel Workers (10 minutes)

### Worker Architecture

```javascript
class ChannelWorker {
  constructor(channel, options = {}) {
    this.channel = channel;
    this.concurrency = options.concurrency || 10;
    this.batchSize = options.batchSize || 100;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000
    });
  }

  async start() {
    while (this.running) {
      const notifications = await this.queue.dequeue(this.batchSize);

      if (notifications.length === 0) {
        await this.sleep(100); // Backoff when queue empty
        continue;
      }

      // Process batch with concurrency limit
      await this.processBatch(notifications);
    }
  }

  async processBatch(notifications) {
    const chunks = this.chunk(notifications, this.concurrency);

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(notification => this.processOne(notification))
      );
    }
  }

  async processOne(notification) {
    try {
      await this.circuitBreaker.execute(async () => {
        await this.deliver(notification);
      });

      await this.tracker.updateStatus(notification.id, this.channel, 'sent');
      metrics.increment('delivery_success', { channel: this.channel });
    } catch (error) {
      await this.handleFailure(notification, error);
    }
  }
}
```

### Push Notification Worker (APNs/FCM)

```javascript
class PushWorker extends ChannelWorker {
  async deliver(notification) {
    const { userId, content } = notification;

    // Get user's registered devices
    const devices = await this.deviceService.getDevices(userId);
    if (devices.length === 0) {
      throw new NoDevicesError('User has no registered devices');
    }

    const results = [];

    for (const device of devices) {
      try {
        if (device.platform === 'ios') {
          await this.sendAPNs(device.token, content);
        } else if (device.platform === 'android') {
          await this.sendFCM(device.token, content);
        }
        results.push({ deviceId: device.id, status: 'sent' });
      } catch (error) {
        results.push({ deviceId: device.id, status: 'failed', error: error.message });

        // Handle invalid tokens (uninstalled app)
        if (this.isInvalidToken(error)) {
          await this.deviceService.deregister(device.id);
        }
      }
    }

    // Partial success if at least one device received
    const successCount = results.filter(r => r.status === 'sent').length;
    if (successCount === 0) {
      throw new DeliveryError('All devices failed', results);
    }

    return results;
  }

  async sendAPNs(token, content) {
    const notification = new apn.Notification({
      alert: { title: content.title, body: content.body },
      sound: content.sound || 'default',
      badge: content.badge,
      payload: content.data,
      topic: this.bundleId,
      expiry: Math.floor(Date.now() / 1000) + 3600
    });

    const result = await this.apnProvider.send(notification, token);
    if (result.failed.length > 0) {
      throw new APNsError(result.failed[0].response.reason);
    }
  }

  async sendFCM(token, content) {
    const message = {
      token,
      notification: { title: content.title, body: content.body },
      data: content.data,
      android: {
        priority: 'high',
        notification: {
          sound: content.sound || 'default',
          channelId: content.channelId || 'default'
        }
      }
    };

    await this.fcmClient.send(message);
  }
}
```

### Email Worker with Template Rendering

```javascript
class EmailWorker extends ChannelWorker {
  async deliver(notification) {
    const { userId, content, templateId } = notification;

    const user = await this.userService.getUser(userId);
    if (!user.email || !user.emailVerified) {
      throw new NoEmailError('User has no verified email');
    }

    // Render template with user data
    const emailContent = await this.templateService.render(templateId, {
      user,
      ...content.variables
    });

    const result = await this.emailProvider.send({
      to: user.email,
      from: emailContent.from || this.defaultFrom,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      headers: {
        'X-Notification-Id': notification.id,
        'List-Unsubscribe': this.getUnsubscribeUrl(userId)
      },
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true }
      }
    });

    return { messageId: result.messageId };
  }
}
```

### Channel-Specific Rate Limits

| Channel | Rate Limit | Retry Strategy | Typical Latency |
|---------|------------|----------------|-----------------|
| Push (APNs) | High | 3x exponential | <100ms |
| Push (FCM) | High | 3x exponential | <100ms |
| Email | 100/sec | 5x with backoff | 1-5s |
| SMS | 10/sec | 2x | 1-3s |

---

## Deep Dive: Rate Limiting (7 minutes)

### Multi-Level Rate Limiting

```javascript
class RateLimiter {
  constructor() {
    this.limits = {
      // Per-user limits (prevent spam to single user)
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
      },
      // Per-service limits (prevent runaway services)
      service: {
        push: { count: 50000, window: 60 },
        email: { count: 5000, window: 60 },
        sms: { count: 500, window: 60 }
      }
    };
  }

  async checkLimit(userId, serviceId, channel) {
    // Check user limit
    const userResult = await this.checkUserLimit(userId, channel);
    if (userResult.limited) return userResult;

    // Check service limit
    const serviceResult = await this.checkServiceLimit(serviceId, channel);
    if (serviceResult.limited) return serviceResult;

    // Check global limit
    const globalResult = await this.checkGlobalLimit(channel);
    if (globalResult.limited) return globalResult;

    return { limited: false };
  }

  async checkUserLimit(userId, channel) {
    const key = `ratelimit:user:${userId}:${channel}`;
    const limit = this.limits.user[channel];

    return this.checkLimit(key, limit);
  }

  async checkLimit(key, limit) {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, limit.window);
    }

    if (count > limit.count) {
      const ttl = await redis.ttl(key);
      return {
        limited: true,
        retryAfter: ttl,
        current: count,
        limit: limit.count
      };
    }

    return { limited: false, current: count, limit: limit.count };
  }
}
```

### Sliding Window Rate Limiter

```javascript
class SlidingWindowRateLimiter {
  async checkLimit(key, limit, windowSeconds) {
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);
    const countKey = `ratelimit:sliding:${key}`;

    // Remove old entries
    await redis.zremrangebyscore(countKey, 0, windowStart);

    // Count current entries
    const count = await redis.zcard(countKey);

    if (count >= limit) {
      // Get oldest entry to calculate retry-after
      const oldest = await redis.zrange(countKey, 0, 0, 'WITHSCORES');
      const retryAfter = oldest[1] ? Math.ceil((oldest[1] + windowSeconds * 1000 - now) / 1000) : windowSeconds;

      return { limited: true, retryAfter, current: count };
    }

    // Add current request
    await redis.zadd(countKey, now, `${now}:${Math.random()}`);
    await redis.expire(countKey, windowSeconds);

    return { limited: false, current: count + 1, limit };
  }
}
```

---

## Deep Dive: Retry and Circuit Breaker (8 minutes)

### Exponential Backoff with Jitter

```javascript
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 300000;
    this.jitterFactor = options.jitterFactor || 0.1;
  }

  async executeWithRetry(operation, context) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (!this.isRetryable(error)) {
          await this.sendToDeadLetter(context, error);
          throw error;
        }

        if (attempt === this.maxRetries) {
          await this.sendToDeadLetter(context, error);
          throw error;
        }

        const delay = this.calculateDelay(attempt);
        logger.info({
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          delay,
          error: error.message
        }, 'Retrying notification delivery');

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  calculateDelay(attempt) {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const exponentialDelay = this.baseDelay * Math.pow(2, attempt);

    // Add jitter to prevent thundering herd
    const jitter = exponentialDelay * this.jitterFactor * Math.random();

    return Math.min(exponentialDelay + jitter, this.maxDelay);
  }

  isRetryable(error) {
    // Retry on transient errors only
    const retryableCodes = [429, 500, 502, 503, 504];
    return retryableCodes.includes(error.statusCode) ||
           error.code === 'ECONNRESET' ||
           error.code === 'ETIMEDOUT' ||
           error.code === 'ECONNREFUSED';
  }
}
```

### Circuit Breaker Implementation

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.halfOpenRequests = options.halfOpenRequests || 3;

    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.successes = 0;
        logger.info('Circuit breaker transitioning to HALF_OPEN');
      } else {
        throw new CircuitOpenError('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.halfOpenRequests) {
        this.state = 'CLOSED';
        logger.info('Circuit breaker CLOSED');
        metrics.gauge('circuit_breaker_state', 0, { channel: this.channel });
      }
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      logger.warn({ failures: this.failures }, 'Circuit breaker OPENED');
      metrics.gauge('circuit_breaker_state', 1, { channel: this.channel });
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      successes: this.successes
    };
  }
}
```

### Dead Letter Queue Handler

```javascript
class DeadLetterHandler {
  async sendToDeadLetter(notification, error) {
    await db.query(`
      INSERT INTO dead_letter_notifications
        (notification_id, original_payload, channel, error_message, error_code, attempts, failed_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      notification.id,
      JSON.stringify(notification),
      notification.channel,
      error.message,
      error.code || 'UNKNOWN',
      notification.attempts || 1
    ]);

    // Alert on DLQ growth
    const dlqCount = await this.getDLQCount();
    if (dlqCount > 100) {
      await this.alertOps('Dead letter queue threshold exceeded', {
        count: dlqCount,
        channel: notification.channel
      });
    }

    metrics.increment('dead_letter_total', { channel: notification.channel });
  }

  async reprocessDLQ(channel, batchSize = 10) {
    const items = await db.query(`
      SELECT * FROM dead_letter_notifications
      WHERE channel = $1 AND reprocessed_at IS NULL
      ORDER BY failed_at ASC
      LIMIT $2
    `, [channel, batchSize]);

    for (const item of items.rows) {
      try {
        const notification = JSON.parse(item.original_payload);
        await notificationService.reprocess(notification);

        await db.query(`
          UPDATE dead_letter_notifications
          SET reprocessed_at = NOW(), reprocess_status = 'success'
          WHERE id = $1
        `, [item.id]);
      } catch (error) {
        await db.query(`
          UPDATE dead_letter_notifications
          SET reprocess_attempts = reprocess_attempts + 1, last_error = $2
          WHERE id = $1
        `, [item.id, error.message]);
      }
    }
  }
}
```

---

## Database Schema (5 minutes)

### PostgreSQL Schema

```sql
-- Core notifications table
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  template_id VARCHAR(100),
  content JSONB NOT NULL,
  channels TEXT[] NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  idempotency_key VARCHAR(255),
  scheduled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_notifications_idempotency ON notifications(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Delivery status per channel
CREATE TABLE delivery_status (
  notification_id UUID REFERENCES notifications(id),
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  details JSONB DEFAULT '{}',
  attempts INTEGER DEFAULT 1,
  last_attempt_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, channel)
);

CREATE INDEX idx_delivery_status ON delivery_status(status, updated_at);
CREATE INDEX idx_delivery_pending ON delivery_status(channel, status) WHERE status = 'pending';

-- User preferences with caching support
CREATE TABLE notification_preferences (
  user_id UUID PRIMARY KEY,
  channels JSONB DEFAULT '{}',
  categories JSONB DEFAULT '{}',
  quiet_hours_start INTEGER,  -- minutes from midnight
  quiet_hours_end INTEGER,
  timezone VARCHAR(50) DEFAULT 'UTC',
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Device tokens for push notifications
CREATE TABLE device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  platform VARCHAR(20) NOT NULL,  -- ios, android, web
  token TEXT NOT NULL,
  device_info JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used TIMESTAMP
);

CREATE UNIQUE INDEX idx_device_token ON device_tokens(token);
CREATE INDEX idx_device_user ON device_tokens(user_id) WHERE active = true;

-- Notification events (opens, clicks, dismissals)
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

-- Templates for dynamic content
CREATE TABLE notification_templates (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(200),
  channels JSONB NOT NULL,  -- { push: {...}, email: {...}, sms: {...} }
  variables TEXT[],
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Dead letter queue for failed notifications
CREATE TABLE dead_letter_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID,
  original_payload JSONB NOT NULL,
  channel VARCHAR(20),
  error_message TEXT,
  error_code VARCHAR(50),
  attempts INTEGER DEFAULT 0,
  failed_at TIMESTAMP DEFAULT NOW(),
  reprocessed_at TIMESTAMP,
  reprocess_status VARCHAR(20),
  reprocess_attempts INTEGER DEFAULT 0,
  last_error TEXT
);

CREATE INDEX idx_dlq_channel ON dead_letter_notifications(channel, failed_at);
CREATE INDEX idx_dlq_pending ON dead_letter_notifications(channel)
  WHERE reprocessed_at IS NULL;
```

### Redis Data Structures

```javascript
// User preferences cache
const prefsCacheKey = `prefs:${userId}`;
// TTL: 5 minutes, Value: JSON preferences object

// Rate limiting
const userRateLimitKey = `ratelimit:user:${userId}:${channel}`;
const globalRateLimitKey = `ratelimit:global:${channel}`;
const serviceRateLimitKey = `ratelimit:service:${serviceId}:${channel}`;
// TTL: window duration, Value: integer count

// Idempotency keys
const idempotencyKey = `idempotency:${key}`;
// TTL: 24 hours, Value: JSON result or "processing"

// Queue (if using Redis instead of RabbitMQ)
const queueKey = `queue:${channel}`;
// Type: Sorted Set, Score: priority + timestamp

// Circuit breaker state
const circuitKey = `circuit:${channel}`;
// Value: JSON state object
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Queue Technology | Redis Sorted Sets | RabbitMQ/Kafka | Simpler priority implementation, low latency |
| Delivery Guarantee | At-least-once | Exactly-once | Simpler, more reliable; clients handle duplicates |
| Preference Caching | 5-minute TTL | Real-time | Reduces DB load; acceptable staleness |
| Worker Scaling | Per-channel pools | Unified pool | Independent scaling, failure isolation |
| Retry Strategy | Exponential backoff | Fixed interval | Prevents thundering herd |
| Rate Limiting | Sliding window | Fixed window | More accurate at window boundaries |
| Idempotency | Redis with 24h TTL | Database | Low latency, automatic cleanup |
| Circuit Breaker | Per-provider | Global | Isolate failures by channel |

---

## Future Enhancements

1. **Notification Batching**: Aggregate low-priority notifications into digest emails
2. **A/B Testing**: Test different templates and delivery times
3. **Machine Learning**: Optimize delivery time based on user engagement patterns
4. **Multi-Region Delivery**: Route to nearest provider endpoint
5. **Webhook Delivery**: Support HTTP endpoint delivery for external integrations
6. **Priority Escalation**: Auto-escalate undelivered high-priority notifications to SMS
