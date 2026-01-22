# APNs (Apple Push Notification Service) - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement (1 minute)

"I'll design APNs from a fullstack engineering perspective, focusing on the end-to-end flow from provider request to device delivery, and how the admin dashboard reflects system state in real-time. The key challenges are maintaining consistency between backend state and frontend visualization, optimizing the device token lookup path, and providing an intuitive interface for testing and debugging.

For this discussion, I'll emphasize the complete notification delivery flow, how frontend and backend coordinate for real-time updates, and the integration points that make the system cohesive."

## Requirements Clarification (3 minutes)

### Functional Requirements
1. **Provider API**: HTTP/2 endpoint for receiving notifications from app servers
2. **Device Registry**: Register, lookup, and invalidate device tokens
3. **Push Delivery**: Real-time delivery to connected devices, store-and-forward for offline
4. **Admin Dashboard**: Monitor delivery metrics, manage devices, send test notifications
5. **Feedback Loop**: Report invalid tokens back to providers

### Non-Functional Requirements
1. **End-to-End Latency**: < 500ms from provider request to device delivery
2. **Real-time Dashboard**: Metrics update within 5 seconds
3. **Consistency**: Frontend reflects actual backend state accurately
4. **Scale**: 580K notifications/second, 1B+ registered devices

### Key Integration Points
- Provider submits notification -> Dashboard shows live counter increase
- Device connects -> Pending notifications flush, delivery log updates
- Token invalidated -> Feedback queue populated, dashboard stats refresh
- Admin sends test -> Real-time delivery status displayed

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Provider Layer                                          │
│                    App Servers (Netflix, WhatsApp, etc.)                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │ HTTP/2 + JWT
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              APNs Backend                                            │
│                                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐                  │
│  │   API Gateway    │  │  Push Service    │  │  Store Service   │                  │
│  │                  │  │                  │  │                  │                  │
│  │ - Auth           │  │ - Connections    │  │ - Pending queue  │                  │
│  │ - Rate limiting  │  │ - Delivery       │  │ - Expiration     │                  │
│  │ - Routing        │  │ - WebSocket      │  │ - Collapse       │                  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘                  │
│           │                     │                     │                             │
│           └─────────────────────┼─────────────────────┘                             │
│                                 │                                                   │
│  ┌──────────────────────────────┴──────────────────────────────┐                   │
│  │                    Shared Infrastructure                      │                   │
│  │  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐        │                   │
│  │  │ PostgreSQL  │   │    Redis    │   │ WebSocket   │        │                   │
│  │  │ (Tokens)    │   │  (Cache)    │   │  (Pub/Sub)  │        │                   │
│  │  └─────────────┘   └─────────────┘   └─────────────┘        │                   │
│  └──────────────────────────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│    Admin Frontend    │  │   Device Layer       │  │   Provider SDK       │
│                      │  │                      │  │                      │
│ - Dashboard          │  │ - iOS devices        │  │ - Feedback polling   │
│ - Device management  │  │ - macOS devices      │  │ - Token cleanup      │
│ - Test notifications │  │ - watchOS devices    │  │ - Analytics          │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

## Deep Dive: End-to-End Notification Flow (8 minutes)

### Sequence Diagram

```
┌──────────┐   ┌───────────┐   ┌────────────┐   ┌───────┐   ┌──────────┐   ┌──────────┐
│ Provider │   │ Gateway   │   │ Token      │   │ Redis │   │ Push     │   │ Device   │
│          │   │           │   │ Registry   │   │       │   │ Service  │   │          │
└────┬─────┘   └─────┬─────┘   └─────┬──────┘   └───┬───┘   └────┬─────┘   └────┬─────┘
     │               │               │              │            │              │
     │ POST /3/device/{token}        │              │            │              │
     │──────────────►│               │              │            │              │
     │               │               │              │            │              │
     │               │ validateJWT() │              │            │              │
     │               │───────────────│              │            │              │
     │               │               │              │            │              │
     │               │ lookup(token) │              │            │              │
     │               │──────────────►│              │            │              │
     │               │               │              │            │              │
     │               │               │ GET cache:token:{hash}    │              │
     │               │               │─────────────►│            │              │
     │               │               │              │            │              │
     │               │               │ cache hit/miss            │              │
     │               │               │◄─────────────│            │              │
     │               │               │              │            │              │
     │               │ device info   │              │            │              │
     │               │◄──────────────│              │            │              │
     │               │               │              │            │              │
     │               │ deliver(notification)        │            │              │
     │               │──────────────────────────────────────────►│              │
     │               │               │              │            │              │
     │               │               │              │ GET conn:{deviceId}       │
     │               │               │              │◄───────────│              │
     │               │               │              │            │              │
     │               │               │              │ server:3001│              │
     │               │               │              │───────────►│              │
     │               │               │              │            │              │
     │               │               │              │            │ WebSocket    │
     │               │               │              │            │ send(payload)│
     │               │               │              │            │─────────────►│
     │               │               │              │            │              │
     │               │               │              │            │ ack          │
     │               │               │              │            │◄─────────────│
     │               │               │              │            │              │
     │ 200 OK (apns-id: xxx)         │              │            │              │
     │◄──────────────│               │              │            │              │
     │               │               │              │            │              │
```

### Backend: Notification Processing

```typescript
// routes/notifications.ts
import { Router } from 'express';
import { tokenRegistry } from '../services/tokenRegistry';
import { pushService } from '../services/pushService';
import { storeService } from '../services/storeService';
import { metricsPublisher } from '../services/metricsPublisher';

const router = Router();

// POST /3/device/:deviceToken
router.post('/3/device/:deviceToken', async (req, res) => {
  const startTime = Date.now();
  const { deviceToken } = req.params;
  const notificationId = req.headers['apns-id'] || crypto.randomUUID();
  const priority = parseInt(req.headers['apns-priority'] as string) || 10;
  const expiration = req.headers['apns-expiration']
    ? new Date(parseInt(req.headers['apns-expiration'] as string) * 1000)
    : null;
  const collapseId = req.headers['apns-collapse-id'] as string;

  try {
    // 1. Look up device (cache-aside pattern)
    const device = await tokenRegistry.lookup(deviceToken);
    if (!device) {
      return res.status(410).json({ reason: 'Unregistered' });
    }

    // 2. Create notification record
    const notification = {
      id: notificationId,
      deviceId: device.device_id,
      payload: req.body,
      priority,
      expiration,
      collapseId,
      createdAt: Date.now(),
    };

    // 3. Attempt delivery
    const result = await pushService.deliver(notification);

    // 4. If device offline, store for later
    if (!result.delivered) {
      await storeService.queue(notification);
    }

    // 5. Record metrics for dashboard
    const latency = Date.now() - startTime;
    metricsPublisher.recordDelivery({
      status: result.delivered ? 'delivered' : 'queued',
      priority,
      latency,
    });

    // 6. Publish to admin WebSocket for real-time dashboard
    metricsPublisher.broadcastToAdmin({
      type: 'delivery_event',
      data: {
        notificationId,
        deviceId: device.device_id,
        status: result.delivered ? 'delivered' : 'queued',
        latency,
      },
    });

    res.set('apns-id', notificationId);
    res.status(200).json({ success: true });

  } catch (error) {
    metricsPublisher.recordDelivery({ status: 'failed', priority });
    res.status(500).json({ reason: 'InternalServerError' });
  }
});

export default router;
```

### Push Service with WebSocket Routing

```typescript
// services/pushService.ts
import { redis } from '../shared/cache';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';

class PushService extends EventEmitter {
  private connections = new Map<string, WebSocket>();
  private serverId: string;

  constructor() {
    super();
    this.serverId = `server-${process.env.PORT || 3000}`;
  }

  async deliver(notification: Notification): Promise<DeliveryResult> {
    const { deviceId } = notification;

    // Check if device is connected to THIS server
    const localConnection = this.connections.get(deviceId);
    if (localConnection?.readyState === WebSocket.OPEN) {
      return this.sendToConnection(localConnection, notification);
    }

    // Check if device is connected to ANOTHER server
    const connectionInfo = await redis.get(`conn:${deviceId}`);
    if (connectionInfo) {
      const { serverId } = JSON.parse(connectionInfo);
      if (serverId !== this.serverId) {
        // Route to other server via Redis pub/sub
        return this.routeToServer(serverId, notification);
      }
    }

    // Device is offline
    return { delivered: false, reason: 'offline' };
  }

  private async sendToConnection(
    ws: WebSocket,
    notification: Notification
  ): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ delivered: false, reason: 'timeout' });
      }, 5000);

      // Wait for acknowledgment
      const ackHandler = (message: string) => {
        try {
          const data = JSON.parse(message);
          if (data.type === 'ack' && data.notificationId === notification.id) {
            clearTimeout(timeout);
            ws.off('message', ackHandler);
            resolve({ delivered: true });
          }
        } catch {}
      };

      ws.on('message', ackHandler);
      ws.send(JSON.stringify({
        type: 'notification',
        id: notification.id,
        payload: notification.payload,
        priority: notification.priority,
      }));
    });
  }

  private async routeToServer(
    targetServerId: string,
    notification: Notification
  ): Promise<DeliveryResult> {
    // Publish to Redis channel for target server
    await redis.publish(`apns:${targetServerId}`, JSON.stringify({
      type: 'route_notification',
      notification,
    }));

    // In practice, would wait for acknowledgment via another channel
    return { delivered: true, routed: true };
  }

  // Called when device connects
  async handleConnection(ws: WebSocket, deviceId: string) {
    this.connections.set(deviceId, ws);

    // Register connection in Redis
    await redis.setex(`conn:${deviceId}`, 300, JSON.stringify({
      serverId: this.serverId,
      connectedAt: Date.now(),
    }));

    // Deliver pending notifications
    const pending = await this.storeService.getPending(deviceId);
    for (const notification of pending) {
      const result = await this.sendToConnection(ws, notification);
      if (result.delivered) {
        await this.storeService.remove(notification.id);
      }
    }

    ws.on('close', () => {
      this.connections.delete(deviceId);
      redis.del(`conn:${deviceId}`);
    });
  }
}

export const pushService = new PushService();
```

## Deep Dive: Real-Time Dashboard Integration (7 minutes)

### Backend: Metrics Publisher

```typescript
// services/metricsPublisher.ts
import { redis } from '../shared/cache';
import { Counter, Histogram, Gauge } from 'prom-client';

class MetricsPublisher {
  private adminChannel = 'apns:admin:metrics';

  // Prometheus metrics
  private deliveryCounter = new Counter({
    name: 'apns_notifications_sent_total',
    help: 'Total notifications processed',
    labelNames: ['status', 'priority'],
  });

  private latencyHistogram = new Histogram({
    name: 'apns_notification_delivery_seconds',
    help: 'Delivery latency',
    labelNames: ['priority'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  });

  private pendingGauge = new Gauge({
    name: 'apns_pending_notifications',
    help: 'Pending notification count',
  });

  // Track rolling stats for dashboard
  private rollingStats = {
    lastMinuteDelivered: 0,
    lastMinuteQueued: 0,
    lastMinuteFailed: 0,
    totalPending: 0,
    activeConnections: 0,
  };

  recordDelivery(event: { status: string; priority: number; latency?: number }) {
    // Update Prometheus metrics
    this.deliveryCounter.labels(event.status, String(event.priority)).inc();
    if (event.latency) {
      this.latencyHistogram.labels(String(event.priority)).observe(event.latency / 1000);
    }

    // Update rolling stats
    if (event.status === 'delivered') this.rollingStats.lastMinuteDelivered++;
    if (event.status === 'queued') this.rollingStats.lastMinuteQueued++;
    if (event.status === 'failed') this.rollingStats.lastMinuteFailed++;
  }

  async broadcastToAdmin(event: AdminEvent) {
    // Publish to Redis channel (admin WebSocket connections subscribe)
    await redis.publish(this.adminChannel, JSON.stringify(event));
  }

  async getAggregatedStats(): Promise<DashboardStats> {
    // Query database for accurate counts
    const [deviceCount, pendingCount, recentDeliveries] = await Promise.all([
      db.query('SELECT COUNT(*) FROM device_tokens WHERE is_valid = true'),
      db.query('SELECT COUNT(*) FROM pending_notifications'),
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
          COUNT(*) FILTER (WHERE status = 'queued') as queued,
          COUNT(*) FILTER (WHERE status = 'failed') as failed,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)
            FILTER (WHERE status = 'delivered') as avg_latency
        FROM notifications
        WHERE created_at > NOW() - INTERVAL '5 minutes'
      `),
    ]);

    return {
      totalDevices: parseInt(deviceCount.rows[0].count),
      pendingCount: parseInt(pendingCount.rows[0].count),
      activeConnections: pushService.connectionCount,
      deliveryRate: this.calculateDeliveryRate(recentDeliveries.rows[0]),
      avgLatency: Math.round(recentDeliveries.rows[0].avg_latency || 0),
      throughput: this.rollingStats.lastMinuteDelivered,
    };
  }
}

export const metricsPublisher = new MetricsPublisher();
```

### Frontend: Real-Time Stats Hook

```tsx
// hooks/useAdminStats.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useCallback } from 'react';

interface AdminStats {
  totalDevices: number;
  pendingCount: number;
  activeConnections: number;
  deliveryRate: number;
  avgLatency: number;
  throughput: number;
}

interface DeliveryEvent {
  notificationId: string;
  deviceId: string;
  status: 'delivered' | 'queued' | 'failed';
  latency: number;
}

export function useAdminStats() {
  const queryClient = useQueryClient();
  const [recentDeliveries, setRecentDeliveries] = useState<DeliveryEvent[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  // Initial stats from API
  const { data: stats, isLoading } = useQuery<AdminStats>({
    queryKey: ['admin', 'stats'],
    queryFn: async () => {
      const res = await fetch('/api/v1/admin/stats');
      return res.json();
    },
    refetchInterval: 30000, // Fallback polling
  });

  // Real-time updates via WebSocket
  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/admin/ws`);

    ws.onopen = () => {
      setWsStatus('connected');
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'metrics' }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'stats_update':
          // Update cached stats
          queryClient.setQueryData(['admin', 'stats'], (old: AdminStats | undefined) => ({
            ...old,
            ...message.data,
          }));
          break;

        case 'delivery_event':
          // Add to recent deliveries (keep last 100)
          setRecentDeliveries(prev => [message.data, ...prev.slice(0, 99)]);
          break;

        case 'connection_change':
          queryClient.setQueryData(['admin', 'stats'], (old: AdminStats | undefined) => ({
            ...old,
            activeConnections: message.data.count,
          }));
          break;
      }
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      // Reconnect after delay
      setTimeout(() => {
        // Re-run effect
      }, 3000);
    };

    return () => ws.close();
  }, [queryClient]);

  // Calculate derived metrics
  const successRate = recentDeliveries.length > 0
    ? recentDeliveries.filter(d => d.status === 'delivered').length / recentDeliveries.length
    : stats?.deliveryRate || 0;

  const p99Latency = recentDeliveries.length > 0
    ? calculateP99(recentDeliveries.map(d => d.latency))
    : stats?.avgLatency || 0;

  return {
    stats,
    recentDeliveries,
    successRate,
    p99Latency,
    wsStatus,
    isLoading,
  };
}

function calculateP99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.99);
  return sorted[Math.min(index, sorted.length - 1)];
}
```

### Dashboard Component with Live Updates

```tsx
// routes/index.tsx
import { useAdminStats } from '../hooks/useAdminStats';
import { motion, AnimatePresence } from 'framer-motion';

export function DashboardRoute() {
  const {
    stats,
    recentDeliveries,
    successRate,
    p99Latency,
    wsStatus,
    isLoading,
  } = useAdminStats();

  return (
    <div className="p-6 space-y-6">
      {/* Connection Status Indicator */}
      <div className="flex justify-end">
        <ConnectionBadge status={wsStatus} />
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Throughput"
          value={`${stats?.throughput || 0}/s`}
          icon={<ActivityIcon />}
          loading={isLoading}
        />
        <MetricCard
          title="Success Rate"
          value={`${(successRate * 100).toFixed(2)}%`}
          target="99.99%"
          status={successRate >= 0.9999 ? 'healthy' : 'warning'}
          icon={<CheckIcon />}
        />
        <MetricCard
          title="P99 Latency"
          value={`${p99Latency}ms`}
          target="< 500ms"
          status={p99Latency < 500 ? 'healthy' : 'warning'}
          icon={<ClockIcon />}
        />
        <MetricCard
          title="Active Connections"
          value={stats?.activeConnections || 0}
          icon={<UsersIcon />}
        />
      </div>

      {/* Live Delivery Feed */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <h3 className="text-lg font-semibold mb-4">Live Delivery Feed</h3>
        <div className="h-64 overflow-hidden">
          <AnimatePresence initial={false}>
            {recentDeliveries.slice(0, 10).map((delivery) => (
              <motion.div
                key={delivery.notificationId}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-3 py-2 border-b"
              >
                <StatusIcon status={delivery.status} />
                <span className="font-mono text-sm text-gray-600">
                  {delivery.deviceId.slice(0, 8)}...
                </span>
                <span className="text-sm text-gray-500">
                  {delivery.latency}ms
                </span>
                <span className={`text-xs px-2 py-1 rounded ${
                  delivery.status === 'delivered'
                    ? 'bg-green-100 text-green-800'
                    : delivery.status === 'queued'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-red-100 text-red-800'
                }`}>
                  {delivery.status}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DeliveryTimelineChart />
        <LatencyDistributionChart />
      </div>
    </div>
  );
}
```

## Deep Dive: Device Token Lookup Optimization (5 minutes)

### Fullstack Token Lookup Flow

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│                           Token Lookup Flow                                         │
│                                                                                     │
│  Frontend Search Input                                                              │
│         │                                                                           │
│         │ debounce(300ms)                                                           │
│         ▼                                                                           │
│  ┌──────────────────┐                                                              │
│  │ TanStack Query   │  GET /api/v1/admin/devices?q=abc...                          │
│  │ (with cache)     │─────────────────────────────────────────────┐                │
│  └──────────────────┘                                              │                │
│                                                                     ▼                │
│                                                            ┌──────────────────┐    │
│                                                            │   API Gateway    │    │
│                                                            │                  │    │
│                                                            │ 1. Parse query   │    │
│                                                            │ 2. Rate limit    │    │
│                                                            └────────┬─────────┘    │
│                                                                     │              │
│                                                                     ▼              │
│  ┌──────────────────┐     cache hit?      ┌──────────────────┐                     │
│  │     Redis        │◄────────────────────│  Token Registry  │                     │
│  │                  │                      │                  │                     │
│  │ cache:token:*    │     cache miss       │ - lookup()       │                     │
│  │ 1hr TTL          │─────────────────────►│ - search()       │                     │
│  └──────────────────┘                      └────────┬─────────┘                     │
│                                                      │                              │
│                                                      │ SELECT * FROM device_tokens  │
│                                                      │ WHERE token_hash LIKE $1    │
│                                                      ▼                              │
│                                             ┌──────────────────┐                   │
│                                             │   PostgreSQL     │                   │
│                                             │                  │                   │
│                                             │ - Full text idx  │                   │
│                                             │ - Partial idx    │                   │
│                                             └──────────────────┘                   │
│                                                                                     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Optimized Search Endpoint

```typescript
// routes/admin.ts
router.get('/devices', async (req, res) => {
  const { q, offset = 0, limit = 50, status = 'all' } = req.query;

  let query = `
    SELECT device_id, token_hash, app_bundle_id, device_info,
           is_valid, created_at, last_seen
    FROM device_tokens
    WHERE 1=1
  `;
  const params: any[] = [];
  let paramIndex = 1;

  // Filter by search query
  if (q && typeof q === 'string') {
    // Search by partial token hash or app bundle
    query += ` AND (
      token_hash LIKE $${paramIndex}
      OR app_bundle_id ILIKE $${paramIndex + 1}
      OR device_id::text LIKE $${paramIndex}
    )`;
    params.push(`${q}%`, `%${q}%`);
    paramIndex += 2;
  }

  // Filter by status
  if (status === 'active') {
    query += ` AND is_valid = true`;
  } else if (status === 'invalid') {
    query += ` AND is_valid = false`;
  }

  // Pagination
  query += ` ORDER BY last_seen DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
  params.push(limit, offset);

  const result = await db.query(query, params);

  // Get total count for pagination
  const countResult = await db.query(
    `SELECT COUNT(*) FROM device_tokens WHERE is_valid = ${status === 'invalid' ? 'false' : 'true'}`
  );

  res.json({
    devices: result.rows,
    total: parseInt(countResult.rows[0].count),
    hasMore: parseInt(countResult.rows[0].count) > parseInt(offset as string) + result.rows.length,
  });
});
```

### Frontend: Debounced Search with Cache

```tsx
// hooks/useDeviceSearch.ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { useDebouncedValue } from './useDebouncedValue';

export function useDeviceSearch(searchQuery: string, filters: DeviceFilters) {
  const debouncedQuery = useDebouncedValue(searchQuery, 300);

  return useInfiniteQuery({
    queryKey: ['admin', 'devices', debouncedQuery, filters],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        q: debouncedQuery,
        offset: String(pageParam),
        limit: '50',
        status: filters.status,
      });

      const res = await fetch(`/api/v1/admin/devices?${params}`);
      return res.json();
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.length * 50 : undefined,
    staleTime: 30000, // Cache for 30 seconds
    enabled: true, // Always fetch (show all devices when no query)
  });
}

// hooks/useDebouncedValue.ts
import { useState, useEffect } from 'react';

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
```

## Deep Dive: Test Notification Flow (5 minutes)

### Complete Test Send Flow

```tsx
// Frontend: SendTestModal.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';

export function SendTestModal({ device, onClose }: Props) {
  const queryClient = useQueryClient();
  const [deliveryStatus, setDeliveryStatus] = useState<DeliveryStatus | null>(null);

  const sendMutation = useMutation({
    mutationFn: async (payload: NotificationPayload) => {
      const res = await fetch(`/api/v1/admin/devices/${device.device_id}/send-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: async (result) => {
      // Start polling for delivery status
      setDeliveryStatus({ notificationId: result.notificationId, status: 'pending' });

      // Subscribe to WebSocket for real-time status
      const ws = new WebSocket(`/api/v1/admin/ws`);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'subscribe',
          notificationId: result.notificationId,
        }));
      };
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.notificationId === result.notificationId) {
          setDeliveryStatus({ ...data });
          if (data.status === 'delivered' || data.status === 'failed') {
            ws.close();
          }
        }
      };
    },
  });

  return (
    <Modal onClose={onClose} title="Send Test Notification">
      {/* Form fields */}
      <PayloadEditor
        onSubmit={(payload) => sendMutation.mutate(payload)}
        isLoading={sendMutation.isPending}
      />

      {/* Delivery Status */}
      {deliveryStatus && (
        <DeliveryStatusCard status={deliveryStatus} />
      )}
    </Modal>
  );
}

function DeliveryStatusCard({ status }: { status: DeliveryStatus }) {
  return (
    <div className="mt-4 p-4 rounded-lg bg-gray-50">
      <h4 className="font-medium">Delivery Status</h4>
      <div className="flex items-center gap-2 mt-2">
        {status.status === 'pending' && <Spinner className="w-4 h-4" />}
        {status.status === 'delivered' && <CheckCircle className="w-4 h-4 text-green-500" />}
        {status.status === 'queued' && <Clock className="w-4 h-4 text-blue-500" />}
        {status.status === 'failed' && <XCircle className="w-4 h-4 text-red-500" />}
        <span className="capitalize">{status.status}</span>
      </div>
      {status.latency && (
        <p className="text-sm text-gray-500 mt-1">Latency: {status.latency}ms</p>
      )}
      {status.error && (
        <p className="text-sm text-red-600 mt-1">Error: {status.error}</p>
      )}
    </div>
  );
}
```

### Backend: Test Send Endpoint

```typescript
// routes/admin.ts
router.post('/devices/:deviceId/send-test', async (req, res) => {
  const { deviceId } = req.params;
  const { payload, priority = 10 } = req.body;
  const notificationId = crypto.randomUUID();

  try {
    // Verify device exists
    const device = await db.query(
      'SELECT * FROM device_tokens WHERE device_id = $1 AND is_valid = true',
      [deviceId]
    );

    if (device.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found or invalid' });
    }

    // Create notification
    const notification = {
      id: notificationId,
      deviceId,
      payload,
      priority,
      expiration: null,
      collapseId: null,
      createdAt: Date.now(),
    };

    // Attempt delivery
    const result = await pushService.deliver(notification);

    // Record in database
    await db.query(`
      INSERT INTO notifications (id, device_id, payload, priority, status, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [notificationId, deviceId, payload, priority, result.delivered ? 'delivered' : 'queued']);

    // Broadcast status to admin WebSocket
    metricsPublisher.broadcastToAdmin({
      type: 'test_notification_status',
      notificationId,
      status: result.delivered ? 'delivered' : 'queued',
      latency: Date.now() - notification.createdAt,
    });

    res.json({
      notificationId,
      status: result.delivered ? 'delivered' : 'queued',
      latency: Date.now() - notification.createdAt,
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to send notification' });
  }
});
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Fullstack Rationale |
|----------|--------|-------------|---------------------|
| Real-time updates | WebSocket + fallback polling | SSE | Better bidirectional support for subscriptions |
| Token lookup | Cache-aside with Redis | Write-through | Simpler invalidation, acceptable for read-heavy workload |
| Delivery tracking | Pub/sub to dashboard | Polling from frontend | Lower latency status updates |
| Search debounce | 300ms client-side | Server-side rate limit | Better UX, fewer wasted requests |
| Status subscription | Per-notification WebSocket | Polling | Immediate feedback for test notifications |
| Metrics aggregation | Backend aggregates, frontend displays | Frontend calculates | Consistent metrics across sessions |

## Future Fullstack Enhancements

1. **Improved Real-Time Experience**
   - Service Worker for background updates
   - Push notifications to admin when SLO breached
   - Offline-capable dashboard with sync

2. **Developer Tools**
   - Notification payload builder with live preview
   - Device simulator for testing without real iOS device
   - API request builder with cURL export

3. **Analytics Integration**
   - Historical trend analysis
   - Anomaly detection with ML
   - Custom alerting rules UI

4. **Performance Optimization**
   - GraphQL for flexible data fetching
   - Redis Streams for ordered event delivery
   - Edge caching for static dashboard assets
