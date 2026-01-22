# Notification System - Full-Stack Engineer Interview Answer

## System Design Interview (45 minutes)

### Opening Statement (1 minute)

"I'll design a complete notification system that delivers messages across push, email, SMS, and in-app channels with reliability guarantees. The system needs to handle millions of notifications per minute while respecting user preferences and providing real-time delivery feedback.

As a full-stack engineer, I'll focus on the integration between frontend and backend components - from the API contract for preference management to real-time delivery status updates via WebSocket, ensuring a seamless user experience backed by scalable infrastructure."

---

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Multi-Channel Delivery**: Push (iOS/Android), Email, SMS, In-App
- **Priority Handling**: Critical notifications bypass normal queues
- **User Preferences**: Respect opt-outs, quiet hours, channel preferences
- **Real-Time Feedback**: Immediate delivery status in UI
- **Template System**: Dynamic content with variable substitution

### Non-Functional Requirements
- **Throughput**: 1M+ notifications per minute
- **Latency**: < 100ms for critical notifications
- **Reliability**: 99.99% delivery rate
- **UI Responsiveness**: Sub-100ms preference updates

---

## Shared Type Definitions (5 minutes)

### Core Domain Types

```typescript
// shared/types/notification.ts

export type NotificationChannel = 'push' | 'email' | 'sms' | 'in_app';
export type NotificationPriority = 'critical' | 'high' | 'normal' | 'low';
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'suppressed';

export interface Notification {
  id: string;
  userId: string;
  templateId: string;
  content: NotificationContent;
  channels: NotificationChannel[];
  priority: NotificationPriority;
  category: NotificationCategory;
  status: DeliveryStatus;
  deliveryStatus: ChannelDeliveryStatus[];
  createdAt: string;
  deliveredAt?: string;
  readAt?: string;
  actionUrl?: string;
}

export interface NotificationContent {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  imageUrl?: string;
}

export interface ChannelDeliveryStatus {
  channel: NotificationChannel;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  error?: string;
}

export type NotificationCategory =
  | 'security'
  | 'order'
  | 'social'
  | 'marketing'
  | 'system'
  | 'reminder';
```

### User Preferences Types

```typescript
// shared/types/preferences.ts

export interface UserPreferences {
  userId: string;
  channels: ChannelPreferences;
  categories: CategoryPreferences;
  quietHours: QuietHoursSettings;
  timezone: string;
  updatedAt: string;
}

export interface ChannelPreferences {
  push: ChannelSetting;
  email: ChannelSetting;
  sms: ChannelSetting;
  in_app: ChannelSetting;
}

export interface ChannelSetting {
  enabled: boolean;
  categories: Record<NotificationCategory, boolean>;
}

export interface CategoryPreferences {
  [category: string]: {
    enabled: boolean;
    channels: NotificationChannel[];
  };
}

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;  // "22:00"
  end: string;    // "07:00"
  allowCritical: boolean;
}
```

### API Request/Response Types

```typescript
// shared/types/api.ts

export interface SendNotificationRequest {
  userId: string;
  templateId: string;
  data?: Record<string, unknown>;
  channels?: NotificationChannel[];
  priority?: NotificationPriority;
  scheduledAt?: string;
  idempotencyKey?: string;
}

export interface SendNotificationResponse {
  notificationId: string;
  status: 'queued' | 'suppressed';
  channels: NotificationChannel[];
  reason?: string;
}

export interface NotificationListResponse {
  notifications: Notification[];
  unreadCount: number;
  cursor?: string;
  hasMore: boolean;
}

export interface PreferencesUpdateRequest {
  channels?: Partial<ChannelPreferences>;
  categories?: Partial<CategoryPreferences>;
  quietHours?: Partial<QuietHoursSettings>;
  timezone?: string;
}

export interface DeliveryMetrics {
  totalSent: number;
  delivered: number;
  failed: number;
  queueDepth: number;
  channelStats: ChannelMetrics[];
  circuitBreakers: CircuitBreakerStatus[];
  throughput: ThroughputDataPoint[];
}
```

### WebSocket Event Types

```typescript
// shared/types/events.ts

export type WSEventType =
  | 'NEW_NOTIFICATION'
  | 'DELIVERY_UPDATE'
  | 'PREFERENCE_SYNC'
  | 'QUEUE_DEPTH_UPDATE';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: string;
}

export interface NewNotificationEvent {
  notification: Notification;
}

export interface DeliveryUpdateEvent {
  notificationId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  error?: string;
}
```

---

## Deep Dive: Notification Sending Flow (10 minutes)

### Backend: Notification Service

```typescript
// backend/src/services/notificationService.ts

import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { queue } from '../shared/queue';

export class NotificationService {
  private preferencesService: PreferencesService;
  private rateLimiter: RateLimiter;
  private templateService: TemplateService;

  async sendNotification(
    request: SendNotificationRequest,
    serviceId: string
  ): Promise<SendNotificationResponse> {
    const { userId, templateId, data, channels, priority, idempotencyKey } = request;

    // Check idempotency
    if (idempotencyKey) {
      const existing = await this.checkIdempotency(idempotencyKey);
      if (existing) return existing;
    }

    // Validate template exists
    const template = await this.templateService.getTemplate(templateId);
    if (!template) {
      throw new NotFoundError('Template not found');
    }

    // Get user preferences
    const preferences = await this.preferencesService.getPreferences(userId);

    // Determine channels to use
    const requestedChannels = channels || template.defaultChannels;
    const allowedChannels = this.filterChannels(requestedChannels, preferences, priority);

    if (allowedChannels.length === 0) {
      return {
        notificationId: generateId(),
        status: 'suppressed',
        channels: [],
        reason: 'user_preferences'
      };
    }

    // Check quiet hours
    if (this.isQuietHours(preferences) && priority !== 'critical') {
      return this.scheduleAfterQuietHours(request, preferences);
    }

    // Check rate limits
    const rateLimitResult = await this.rateLimiter.checkLimit(userId, serviceId, allowedChannels);
    if (rateLimitResult.limited) {
      throw new RateLimitError(rateLimitResult);
    }

    // Render content
    const content = await this.templateService.render(template, data);

    // Create notification record
    const notificationId = generateId();
    await pool.query(`
      INSERT INTO notifications
        (id, user_id, template_id, content, channels, priority, status, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
    `, [notificationId, userId, templateId, content, allowedChannels, priority, idempotencyKey]);

    // Queue for each channel
    for (const channel of allowedChannels) {
      await queue.publish(`notifications.${channel}`, {
        notificationId,
        userId,
        channel,
        content,
        priority
      });

      // Create delivery status record
      await pool.query(`
        INSERT INTO delivery_status (notification_id, channel, status)
        VALUES ($1, $2, 'pending')
      `, [notificationId, channel]);
    }

    // Cache result for idempotency
    if (idempotencyKey) {
      await this.cacheIdempotencyResult(idempotencyKey, {
        notificationId,
        status: 'queued',
        channels: allowedChannels
      });
    }

    // Emit real-time event
    await this.emitNewNotification(userId, notificationId);

    return {
      notificationId,
      status: 'queued',
      channels: allowedChannels
    };
  }

  private filterChannels(
    requested: NotificationChannel[],
    preferences: UserPreferences,
    priority: NotificationPriority
  ): NotificationChannel[] {
    return requested.filter(channel => {
      const channelPref = preferences.channels[channel];
      if (!channelPref.enabled) return false;

      // Critical notifications bypass category filters
      if (priority === 'critical') return true;

      return true;
    });
  }

  private async emitNewNotification(userId: string, notificationId: string) {
    const notification = await this.getNotification(notificationId);

    redis.publish(`user:${userId}:notifications`, JSON.stringify({
      type: 'NEW_NOTIFICATION',
      payload: { notification },
      timestamp: new Date().toISOString()
    }));
  }
}
```

### Frontend: Send Notification Hook

```typescript
// frontend/src/hooks/useSendNotification.ts

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';

export function useSendNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: SendNotificationRequest) => {
      const response = await api.post<SendNotificationResponse>('/notifications', request);
      return response.data;
    },
    onSuccess: (data) => {
      // Invalidate notification list to show new notification
      queryClient.invalidateQueries({ queryKey: ['notifications'] });

      // Show success toast
      toast.success(`Notification ${data.status === 'queued' ? 'sent' : 'scheduled'}`);
    },
    onError: (error: ApiError) => {
      if (error.code === 'RATE_LIMITED') {
        toast.error(`Rate limited. Try again in ${error.retryAfter}s`);
      } else {
        toast.error('Failed to send notification');
      }
    }
  });
}
```

---

## Deep Dive: Real-Time Delivery Updates (10 minutes)

### Backend: WebSocket Handler

```typescript
// backend/src/websocket/notificationWebSocket.ts

import { WebSocketServer, WebSocket } from 'ws';
import { redis } from '../shared/cache';

export class NotificationWebSocketHandler {
  private connections: Map<string, Set<WebSocket>> = new Map();
  private redisSubscriber: RedisClient;

  async initialize(wss: WebSocketServer) {
    this.redisSubscriber = redis.duplicate();

    wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage) {
    const userId = await this.authenticateConnection(req);
    if (!userId) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Add to user's connection set
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
      await this.subscribeToUserChannel(userId);
    }
    this.connections.get(userId)!.add(ws);

    // Send initial state
    await this.sendInitialState(ws, userId);

    // Handle messages
    ws.on('message', (data) => this.handleMessage(ws, userId, data));

    // Handle disconnect
    ws.on('close', () => this.handleDisconnect(ws, userId));

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => clearInterval(heartbeat));
  }

  private async subscribeToUserChannel(userId: string) {
    await this.redisSubscriber.subscribe(`user:${userId}:notifications`);

    this.redisSubscriber.on('message', (channel, message) => {
      if (channel === `user:${userId}:notifications`) {
        this.broadcastToUser(userId, JSON.parse(message));
      }
    });
  }

  private broadcastToUser(userId: string, event: WSEvent) {
    const connections = this.connections.get(userId);
    if (!connections) return;

    const message = JSON.stringify(event);
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  private async sendInitialState(ws: WebSocket, userId: string) {
    // Send unread count
    const unreadCount = await this.getUnreadCount(userId);
    ws.send(JSON.stringify({
      type: 'INITIAL_STATE',
      payload: { unreadCount },
      timestamp: new Date().toISOString()
    }));
  }

  // Called when delivery status changes
  async notifyDeliveryUpdate(userId: string, update: DeliveryUpdateEvent) {
    redis.publish(`user:${userId}:notifications`, JSON.stringify({
      type: 'DELIVERY_UPDATE',
      payload: update,
      timestamp: new Date().toISOString()
    }));
  }
}
```

### Backend: Delivery Status Update

```typescript
// backend/src/workers/deliveryWorker.ts

import { wsHandler } from '../websocket';

export class DeliveryWorker {
  async updateDeliveryStatus(
    notificationId: string,
    channel: NotificationChannel,
    status: DeliveryStatus,
    error?: string
  ) {
    // Update database
    await pool.query(`
      UPDATE delivery_status
      SET status = $3, updated_at = NOW(), error = $4
      WHERE notification_id = $1 AND channel = $2
    `, [notificationId, channel, status, error]);

    // Get user ID for WebSocket notification
    const result = await pool.query(
      'SELECT user_id FROM notifications WHERE id = $1',
      [notificationId]
    );

    if (result.rows.length > 0) {
      const userId = result.rows[0].user_id;

      // Emit real-time update
      await wsHandler.notifyDeliveryUpdate(userId, {
        notificationId,
        channel,
        status,
        error
      });
    }

    // Update notification aggregate status
    await this.updateNotificationStatus(notificationId);
  }

  private async updateNotificationStatus(notificationId: string) {
    const statuses = await pool.query(`
      SELECT channel, status FROM delivery_status
      WHERE notification_id = $1
    `, [notificationId]);

    const allSent = statuses.rows.every(s => s.status === 'sent' || s.status === 'delivered');
    const allFailed = statuses.rows.every(s => s.status === 'failed');

    let overallStatus: DeliveryStatus;
    if (allSent) overallStatus = 'delivered';
    else if (allFailed) overallStatus = 'failed';
    else overallStatus = 'pending';

    await pool.query(`
      UPDATE notifications
      SET status = $2, delivered_at = CASE WHEN $2 = 'delivered' THEN NOW() ELSE NULL END
      WHERE id = $1
    `, [notificationId, overallStatus]);
  }
}
```

### Frontend: WebSocket Hook

```typescript
// frontend/src/hooks/useNotificationSocket.ts

import { useEffect, useCallback, useRef } from 'react';
import { useNotificationStore } from '../stores/notificationStore';

export function useNotificationSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const { addNotification, updateDeliveryStatus, setUnreadCount } = useNotificationStore();

  const connect = useCallback(() => {
    const ws = new WebSocket(getWebSocketUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts.current = 0;
    };

    ws.onmessage = (event) => {
      const message: WSEvent = JSON.parse(event.data);

      switch (message.type) {
        case 'INITIAL_STATE':
          setUnreadCount(message.payload.unreadCount);
          break;

        case 'NEW_NOTIFICATION':
          addNotification(message.payload.notification);
          showToastNotification(message.payload.notification);
          break;

        case 'DELIVERY_UPDATE':
          updateDeliveryStatus(
            message.payload.notificationId,
            message.payload.channel,
            message.payload.status
          );
          break;
      }
    };

    ws.onclose = () => {
      // Reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
      reconnectAttempts.current++;

      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          connect();
        }
      }, delay);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [addNotification, updateDeliveryStatus, setUnreadCount]);

  useEffect(() => {
    connect();

    // Reconnect when tab becomes visible
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' &&
          (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)) {
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      wsRef.current?.close();
    };
  }, [connect]);

  return wsRef.current;
}
```

### Frontend: Live Delivery Status Component

```tsx
// frontend/src/components/DeliveryStatusTracker.tsx

function DeliveryStatusTracker({ notification }: { notification: Notification }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <span>Delivery Status</span>
        <ChevronDownIcon className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {notification.deliveryStatus.map(status => (
            <ChannelStatusRow
              key={status.channel}
              status={status}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ChannelStatusRow({ status }: { status: ChannelDeliveryStatus }) {
  const statusConfig = {
    pending: { icon: ClockIcon, color: 'text-yellow-500', label: 'Pending' },
    sent: { icon: PaperAirplaneIcon, color: 'text-blue-500', label: 'Sent' },
    delivered: { icon: CheckCircleIcon, color: 'text-green-500', label: 'Delivered' },
    failed: { icon: XCircleIcon, color: 'text-red-500', label: 'Failed' },
    suppressed: { icon: MinusCircleIcon, color: 'text-gray-400', label: 'Suppressed' }
  };

  const config = statusConfig[status.status];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-3 p-2 bg-gray-50 rounded">
      <ChannelIcon channel={status.channel} className="w-4 h-4 text-gray-500" />
      <span className="flex-1 text-sm capitalize">{status.channel}</span>
      <div className={`flex items-center gap-1 ${config.color}`}>
        <Icon className="w-4 h-4" />
        <span className="text-sm">{config.label}</span>
      </div>
      {status.status === 'pending' && (
        <span className="text-xs text-gray-400">
          Attempt {status.attempts}
        </span>
      )}
    </div>
  );
}
```

---

## Deep Dive: Preference Sync (8 minutes)

### Backend: Preferences API

```typescript
// backend/src/routes/preferences.ts

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { PreferencesService } from '../services/preferencesService';

const router = Router();
const preferencesService = new PreferencesService();

router.get('/', requireAuth, async (req, res) => {
  try {
    const preferences = await preferencesService.getPreferences(req.session.userId);
    res.json(preferences);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.put('/', requireAuth, async (req, res) => {
  try {
    const updates: PreferencesUpdateRequest = req.body;

    // Validate updates
    const validation = validatePreferencesUpdate(updates);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors });
    }

    const updated = await preferencesService.updatePreferences(
      req.session.userId,
      updates
    );

    // Broadcast update to other connected clients
    await preferencesService.broadcastPreferenceUpdate(req.session.userId, updated);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

export { router as preferencesRouter };
```

### Backend: Preferences Service with Caching

```typescript
// backend/src/services/preferencesService.ts

export class PreferencesService {
  private readonly CACHE_TTL = 300; // 5 minutes

  async getPreferences(userId: string): Promise<UserPreferences> {
    // Check cache first
    const cached = await redis.get(`prefs:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Load from database
    const result = await pool.query(`
      SELECT * FROM notification_preferences WHERE user_id = $1
    `, [userId]);

    const preferences = result.rows[0] || this.getDefaults(userId);

    // Cache for future requests
    await redis.setex(`prefs:${userId}`, this.CACHE_TTL, JSON.stringify(preferences));

    return preferences;
  }

  async updatePreferences(
    userId: string,
    updates: PreferencesUpdateRequest
  ): Promise<UserPreferences> {
    const current = await this.getPreferences(userId);

    const updated: UserPreferences = {
      ...current,
      channels: updates.channels ? { ...current.channels, ...updates.channels } : current.channels,
      categories: updates.categories ? { ...current.categories, ...updates.categories } : current.categories,
      quietHours: updates.quietHours ? { ...current.quietHours, ...updates.quietHours } : current.quietHours,
      timezone: updates.timezone || current.timezone,
      updatedAt: new Date().toISOString()
    };

    // Persist to database
    await pool.query(`
      INSERT INTO notification_preferences
        (user_id, channels, categories, quiet_hours_start, quiet_hours_end, timezone, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        channels = EXCLUDED.channels,
        categories = EXCLUDED.categories,
        quiet_hours_start = EXCLUDED.quiet_hours_start,
        quiet_hours_end = EXCLUDED.quiet_hours_end,
        timezone = EXCLUDED.timezone,
        updated_at = NOW()
    `, [
      userId,
      JSON.stringify(updated.channels),
      JSON.stringify(updated.categories),
      updated.quietHours.enabled ? this.parseTime(updated.quietHours.start) : null,
      updated.quietHours.enabled ? this.parseTime(updated.quietHours.end) : null,
      updated.timezone
    ]);

    // Invalidate cache
    await redis.del(`prefs:${userId}`);

    return updated;
  }

  async broadcastPreferenceUpdate(userId: string, preferences: UserPreferences) {
    redis.publish(`user:${userId}:notifications`, JSON.stringify({
      type: 'PREFERENCE_SYNC',
      payload: { preferences },
      timestamp: new Date().toISOString()
    }));
  }

  private getDefaults(userId: string): UserPreferences {
    return {
      userId,
      channels: {
        push: { enabled: true, categories: {} },
        email: { enabled: true, categories: {} },
        sms: { enabled: false, categories: {} },
        in_app: { enabled: true, categories: {} }
      },
      categories: {},
      quietHours: {
        enabled: false,
        start: '22:00',
        end: '07:00',
        allowCritical: true
      },
      timezone: 'UTC',
      updatedAt: new Date().toISOString()
    };
  }
}
```

### Frontend: Preferences Store with Sync

```typescript
// frontend/src/stores/preferencesStore.ts

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { debounce } from 'lodash-es';
import { api } from '../services/api';

interface PreferencesStore {
  preferences: UserPreferences | null;
  loading: boolean;
  saving: boolean;
  pendingUpdates: Partial<UserPreferences>;
  lastSyncedAt: string | null;

  fetchPreferences: () => Promise<void>;
  updatePreference: <K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ) => void;
  syncPreferences: () => Promise<void>;
  handleRemoteUpdate: (preferences: UserPreferences) => void;
}

export const usePreferencesStore = create<PreferencesStore>()(
  persist(
    (set, get) => {
      // Debounced sync function
      const debouncedSync = debounce(async () => {
        const { pendingUpdates, preferences } = get();
        if (Object.keys(pendingUpdates).length === 0) return;

        set({ saving: true });
        try {
          const response = await api.put<UserPreferences>('/preferences', pendingUpdates);
          set({
            preferences: response.data,
            pendingUpdates: {},
            saving: false,
            lastSyncedAt: new Date().toISOString()
          });
        } catch (error) {
          console.error('Failed to sync preferences:', error);
          set({ saving: false });
          // Keep pending updates for retry
        }
      }, 1000);

      return {
        preferences: null,
        loading: false,
        saving: false,
        pendingUpdates: {},
        lastSyncedAt: null,

        fetchPreferences: async () => {
          set({ loading: true });
          try {
            const response = await api.get<UserPreferences>('/preferences');
            set({
              preferences: response.data,
              loading: false,
              lastSyncedAt: new Date().toISOString()
            });
          } catch (error) {
            set({ loading: false });
            throw error;
          }
        },

        updatePreference: (key, value) => {
          set(state => ({
            preferences: state.preferences ? { ...state.preferences, [key]: value } : null,
            pendingUpdates: { ...state.pendingUpdates, [key]: value }
          }));

          // Trigger debounced sync
          debouncedSync();
        },

        syncPreferences: async () => {
          debouncedSync.flush();
        },

        handleRemoteUpdate: (preferences) => {
          // Remote update from another tab/device
          set(state => {
            // Only update if no pending local changes
            if (Object.keys(state.pendingUpdates).length === 0) {
              return { preferences };
            }
            // Merge remote with local pending
            return {
              preferences: { ...preferences, ...state.pendingUpdates }
            };
          });
        }
      };
    },
    {
      name: 'notification-preferences',
      partialize: (state) => ({
        preferences: state.preferences,
        lastSyncedAt: state.lastSyncedAt
      })
    }
  )
);
```

### Frontend: Multi-Tab Sync

```typescript
// frontend/src/hooks/usePreferenceSync.ts

import { useEffect } from 'react';
import { usePreferencesStore } from '../stores/preferencesStore';

export function usePreferenceSync() {
  const { handleRemoteUpdate } = usePreferencesStore();

  useEffect(() => {
    // Listen for WebSocket preference updates
    const handleWSMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      if (message.type === 'PREFERENCE_SYNC') {
        handleRemoteUpdate(message.payload.preferences);
      }
    };

    // Listen for updates from other tabs via BroadcastChannel
    const channel = new BroadcastChannel('notification-preferences');

    channel.onmessage = (event) => {
      if (event.data.type === 'PREFERENCE_UPDATE') {
        handleRemoteUpdate(event.data.preferences);
      }
    };

    return () => {
      channel.close();
    };
  }, [handleRemoteUpdate]);

  // Broadcast local updates to other tabs
  const broadcastUpdate = (preferences: UserPreferences) => {
    const channel = new BroadcastChannel('notification-preferences');
    channel.postMessage({ type: 'PREFERENCE_UPDATE', preferences });
    channel.close();
  };

  return { broadcastUpdate };
}
```

---

## Deep Dive: Error Handling (5 minutes)

### Backend: Centralized Error Handling

```typescript
// backend/src/middleware/errorHandler.ts

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export class RateLimitError extends AppError {
  constructor(details: { retryAfter: number; current: number; limit: number }) {
    super(429, 'RATE_LIMITED', 'Rate limit exceeded', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  logger.error({ err, path: req.path, method: req.method }, 'Request error');

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details
      }
    });
  }

  // Unexpected error
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    }
  });
}
```

### Frontend: Error Boundary with Recovery

```tsx
// frontend/src/components/ErrorBoundary.tsx

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class NotificationErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });

    // Log to error tracking service
    logError(error, {
      component: 'NotificationSystem',
      errorInfo
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    // Refetch data
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <ExclamationTriangleIcon className="w-12 h-12 text-red-500 mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Something went wrong
          </h2>
          <p className="text-gray-600 mb-4">
            We couldn't load your notifications. Please try again.
          </p>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### API Error Hook

```typescript
// frontend/src/hooks/useApiError.ts

export function useApiError() {
  const handleError = useCallback((error: unknown) => {
    if (axios.isAxiosError(error)) {
      const apiError = error.response?.data?.error;

      switch (apiError?.code) {
        case 'RATE_LIMITED':
          toast.error(`Rate limited. Try again in ${apiError.details.retryAfter}s`);
          break;
        case 'UNAUTHORIZED':
          // Redirect to login
          window.location.href = '/login';
          break;
        case 'NOT_FOUND':
          toast.error(apiError.message);
          break;
        default:
          toast.error('An error occurred. Please try again.');
      }
    } else {
      toast.error('Network error. Please check your connection.');
    }
  }, []);

  return { handleError };
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Real-Time Updates | WebSocket | SSE/Polling | Bi-directional needed for acks |
| Preference Sync | Debounced auto-save | Manual save | Better UX, fewer clicks |
| State Management | Zustand + persist | Redux | Simpler API, built-in persistence |
| Multi-Tab Sync | BroadcastChannel | localStorage events | More reliable, structured data |
| Error Handling | Centralized + codes | Per-endpoint | Consistent client handling |
| Cache Invalidation | Delete on update | TTL only | Immediate preference effect |
| Type Sharing | Shared package | Duplicate types | Single source of truth |

---

## Future Enhancements

1. **GraphQL Subscriptions**: Replace WebSocket with GraphQL subscriptions for unified API
2. **Optimistic UI**: Show notifications as sent before backend confirmation
3. **Offline Queue**: Queue sends when offline, sync when connected
4. **Push Notification Service Worker**: Background notification handling
5. **A/B Testing Integration**: Test different notification strategies
6. **Analytics Events**: Track notification interactions across channels
