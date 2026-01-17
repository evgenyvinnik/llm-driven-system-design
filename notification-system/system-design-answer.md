# Notification System - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design a high-throughput notification system that delivers messages across multiple channels - push notifications, email, SMS, and in-app - with reliability guarantees and user preference handling. The core challenge is processing millions of notifications per minute while respecting user preferences, managing delivery priorities, and ensuring reliable delivery across diverse channel providers.

This involves three key technical challenges: building a priority-based queue system that processes critical notifications first, designing multi-channel routing with per-channel workers, and implementing robust delivery tracking with retry logic."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Multi-Channel Delivery**: Push (iOS/Android), Email, SMS, In-App
- **Priority Handling**: Critical notifications bypass normal queues
- **User Preferences**: Respect opt-outs, quiet hours, channel preferences
- **Template System**: Dynamic content with variables
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

### Key Questions I'd Ask
1. What's the acceptable delay for non-critical notifications?
2. Should we support scheduled/future notifications?
3. What retry policy for failed deliveries?

## High-Level Architecture (5 minutes)

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
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Push Workers  │    │ Email Workers │    │  SMS Workers  │
│ - APNs/FCM    │    │ - SendGrid    │    │ - Twilio      │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Delivery Tracking                            │
│              (Status updates, receipts, analytics)               │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

1. **Message Router**: Validates requests, checks preferences, routes to channels
2. **Priority Queues**: Per-channel queues with priority ordering
3. **Channel Workers**: Specialized workers for each delivery channel
4. **Delivery Tracker**: Status tracking, retry logic, analytics

### Why Separate Queues Per Channel?

- Channels have different latency characteristics
- SMS has strict rate limits; don't let it block push
- Independent scaling (more email workers during campaigns)
- Failure isolation

## Deep Dive: Priority Queue System (8 minutes)

The queue design determines how we balance urgency vs. throughput.

### Priority Scoring

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
  }

  calculateScore(priority, timestamp) {
    // Priority determines the "bucket", timestamp orders within bucket
    const priorityWeights = {
      critical: 0,                  // 0-999B
      high:     1_000_000_000_000,  // 1T-2T
      normal:   2_000_000_000_000,  // 2T-3T
      low:      3_000_000_000_000   // 3T+
    };

    return priorityWeights[priority] + timestamp;
  }

  async dequeue(batchSize = 100) {
    // Pop items with lowest scores (highest priority, oldest first)
    const items = await redis.zpopmin(
      `queue:${this.channel}`,
      batchSize
    );

    return items.map(item => JSON.parse(item));
  }
}
```

### Queue Monitoring

```javascript
async getQueueDepth() {
  return {
    total: await redis.zcard(`queue:${this.channel}`),
    critical: await redis.zcount(`queue:${this.channel}`, 0, 999_999_999_999),
    high: await redis.zcount(`queue:${this.channel}`, 1_000_000_000_000, 1_999_999_999_999),
    normal: await redis.zcount(`queue:${this.channel}`, 2_000_000_000_000, 2_999_999_999_999),
    low: await redis.zcount(`queue:${this.channel}`, 3_000_000_000_000, Infinity)
  };
}
```

### Why Sorted Sets Over Separate Queues?

| Approach | Pros | Cons |
|----------|------|------|
| Separate queues per priority | Simple logic | Poll all queues |
| Single sorted set | Atomic dequeue | Score calculation |
| Multiple lists with polling | Simple | Priority inversion |

Sorted sets let us atomically pop the highest-priority items in O(log N) without polling multiple queues.

## Deep Dive: Multi-Channel Workers (7 minutes)

Each channel has unique characteristics requiring specialized handling.

### Push Notification Worker

```javascript
class PushWorker {
  async processNotification(notification) {
    const { notificationId, content, userId } = notification;

    // Get user's registered devices
    const devices = await this.getDevices(userId);
    if (devices.length === 0) {
      await this.markDelivered(notificationId, 'no_devices');
      return;
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
          await this.deregisterDevice(device.id);
        }
      }
    }

    const allFailed = results.every(r => r.status === 'failed');
    await this.updateStatus(notificationId, 'push', allFailed ? 'failed' : 'sent', results);
  }
}
```

### Email Worker with Templates

```javascript
class EmailWorker {
  async processNotification(notification) {
    const { notificationId, content, userId } = notification;

    const user = await this.getUser(userId);
    if (!user.email || !user.emailVerified) {
      await this.markDelivered(notificationId, 'no_email');
      return;
    }

    // Render template with user data
    const emailContent = await this.renderEmail(content);

    try {
      const result = await this.emailProvider.send({
        to: user.email,
        from: emailContent.from || this.defaultFrom,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
        headers: {
          'X-Notification-Id': notificationId,
          'List-Unsubscribe': this.getUnsubscribeUrl(userId)
        }
      });

      await this.updateStatus(notificationId, 'email', 'sent', {
        messageId: result.messageId
      });

    } catch (error) {
      if (this.isRetryable(error)) {
        await this.retry(notification, error);
      } else {
        await this.updateStatus(notificationId, 'email', 'failed', {
          error: error.message
        });
      }
    }
  }
}
```

### Channel-Specific Considerations

| Channel | Rate Limits | Retries | Latency |
|---------|-------------|---------|---------|
| Push (APNs) | High | 3x exponential | <100ms |
| Push (FCM) | High | 3x exponential | <100ms |
| Email | 100/sec typical | 5x with backoff | 1-5s |
| SMS | 10/sec typical | 2x | 1-3s |

## Deep Dive: User Preferences and Rate Limiting (5 minutes)

### Preference Management

```javascript
class PreferencesService {
  async getPreferences(userId) {
    // Check cache first (5 minute TTL)
    const cached = await redis.get(`prefs:${userId}`);
    if (cached) return JSON.parse(cached);

    const prefs = await db.query(`
      SELECT * FROM notification_preferences WHERE user_id = $1
    `, [userId]);

    const preferences = prefs.rows[0] || this.getDefaults();
    await redis.setex(`prefs:${userId}`, 300, JSON.stringify(preferences));

    return preferences;
  }

  filterChannels(requestedChannels, preferences) {
    return requestedChannels.filter(channel => {
      return preferences.channels[channel]?.enabled !== false;
    });
  }

  isQuietHours(preferences) {
    if (!preferences.quietHoursStart || !preferences.quietHoursEnd) {
      return false;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    if (start < end) {
      return currentMinutes >= start && currentMinutes < end;
    } else {
      // Quiet hours span midnight (e.g., 22:00 - 07:00)
      return currentMinutes >= start || currentMinutes < end;
    }
  }
}
```

### Rate Limiting

Two levels: per-user (prevent spam) and global (protect downstream services).

```javascript
class RateLimiter {
  async checkLimit(userId, channels) {
    const limits = {
      user: {
        push: { count: 50, window: 3600 },    // 50/hour
        email: { count: 10, window: 3600 },   // 10/hour
        sms: { count: 5, window: 3600 }       // 5/hour
      },
      global: {
        push: { count: 100000, window: 60 },  // 100k/min
        email: { count: 10000, window: 60 },  // 10k/min
        sms: { count: 1000, window: 60 }      // 1k/min
      }
    };

    for (const channel of channels) {
      // User limit check
      const userKey = `ratelimit:user:${userId}:${channel}`;
      const userCount = await redis.incr(userKey);
      if (userCount === 1) {
        await redis.expire(userKey, limits.user[channel].window);
      }
      if (userCount > limits.user[channel].count) {
        return { limited: true, reason: 'user_limit', channel };
      }

      // Global limit check
      const globalKey = `ratelimit:global:${channel}`;
      const globalCount = await redis.incr(globalKey);
      if (globalCount === 1) {
        await redis.expire(globalKey, limits.global[channel].window);
      }
      if (globalCount > limits.global[channel].count) {
        return { limited: true, reason: 'global_limit', channel };
      }
    }

    return { limited: false };
  }
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. At-Least-Once vs. Exactly-Once Delivery

**Chose: At-least-once**
- Pro: Simpler, more reliable
- Pro: Users prefer duplicate over missing
- Con: Client must handle duplicates
- Alternative: Exactly-once requires distributed transactions (complex)

### 2. Queue Technology

**Chose: Redis sorted sets**
- Pro: Simple priority implementation
- Pro: Low latency
- Con: Not as durable as dedicated message queue
- Alternative: RabbitMQ or Kafka (more durable, higher latency)

### 3. Preference Caching

**Chose: 5-minute cache TTL**
- Pro: Reduces database load
- Pro: Fast preference lookups
- Con: Preference changes take up to 5 min
- Trade-off: Acceptable for most preferences

### 4. Channel Worker Scaling

**Chose: Independent worker pools per channel**
- Pro: Scale channels independently
- Pro: Failure isolation
- Con: More operational complexity
- Alternative: Single worker type handling all channels

### 5. Retry Strategy

**Chose: Exponential backoff with max retries**
- 1st retry: 1 minute
- 2nd retry: 5 minutes
- 3rd retry: 30 minutes
- Then: Dead letter queue for manual review

### Database Schema Highlights

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  template_id VARCHAR(100),
  content JSONB NOT NULL,
  channels TEXT[] NOT NULL,
  priority VARCHAR(20) DEFAULT 'normal',
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  delivered_at TIMESTAMP
);

CREATE TABLE delivery_status (
  notification_id UUID REFERENCES notifications(id),
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  details JSONB DEFAULT '{}',
  attempts INTEGER DEFAULT 1,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (notification_id, channel)
);

CREATE TABLE device_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  platform VARCHAR(20) NOT NULL,  -- ios, android, web
  token TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  last_used TIMESTAMP
);
```

## Closing Summary (1 minute)

"The notification system is built around three core principles:

1. **Priority-based queue processing** using Redis sorted sets - critical notifications like security alerts bypass normal processing, while still maintaining ordering within each priority level.

2. **Channel-specific worker pools** - each channel (push, email, SMS) has dedicated workers that understand the unique characteristics and rate limits of their providers, enabling independent scaling and failure isolation.

3. **At-least-once delivery with comprehensive tracking** - we prioritize reliability over exactly-once semantics, tracking delivery status per channel and implementing exponential backoff retries.

The main trade-off is complexity vs. reliability. We chose separate queues per channel and at-least-once delivery because notification reliability directly impacts user trust. For future improvements, I'd add circuit breakers per downstream provider and implement a digest feature to batch low-priority notifications."
