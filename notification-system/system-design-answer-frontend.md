# Notification System - Frontend Engineer Interview Answer

## System Design Interview (45 minutes)

### Opening Statement (1 minute)

"I'll design the frontend for a notification management system that enables users to configure their notification preferences, view notification history, and provides an admin dashboard for monitoring delivery metrics. The core challenge is building intuitive preference controls with real-time status updates while maintaining accessibility and performance.

From a frontend perspective, I'll focus on preference management UI, notification center design, real-time delivery status, and the admin analytics dashboard."

---

## Requirements Clarification (3 minutes)

### User-Facing Features
- **Preference Management**: Channel toggles, category settings, quiet hours
- **Notification Center**: View history, mark as read, filter by type
- **Device Management**: Register/unregister devices, platform selection
- **Real-Time Updates**: Live delivery status, in-app notifications

### Admin Features
- **Delivery Dashboard**: Throughput metrics, success rates, queue depth
- **Template Management**: Create/edit notification templates
- **Channel Monitoring**: Per-channel health, circuit breaker status
- **User Search**: Look up specific user's notification history

### UI/UX Requirements
- **Accessibility**: WCAG 2.1 AA compliance
- **Responsive**: Desktop and mobile layouts
- **Performance**: Sub-100ms interactions for preference changes
- **Offline Support**: Queue preference changes when disconnected

---

## Deep Dive: Preference Management UI (10 minutes)

### Channel Preferences Component

```tsx
interface ChannelPreference {
  channel: 'push' | 'email' | 'sms' | 'in_app';
  enabled: boolean;
  categories: Record<string, boolean>;
}

interface PreferencesState {
  channels: ChannelPreference[];
  quietHours: {
    enabled: boolean;
    start: string; // "22:00"
    end: string;   // "07:00"
  };
  timezone: string;
  loading: boolean;
  saving: boolean;
}

function PreferencesPanel() {
  const { preferences, updatePreferences, saving } = usePreferences();

  return (
    <div className="space-y-8">
      <section aria-labelledby="channels-heading">
        <h2 id="channels-heading" className="text-lg font-semibold mb-4">
          Notification Channels
        </h2>
        <div className="space-y-4">
          {preferences.channels.map(channel => (
            <ChannelToggle
              key={channel.channel}
              channel={channel}
              onToggle={(enabled) => updatePreferences({
                channels: preferences.channels.map(c =>
                  c.channel === channel.channel ? { ...c, enabled } : c
                )
              })}
              disabled={saving}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="quiet-hours-heading">
        <h2 id="quiet-hours-heading" className="text-lg font-semibold mb-4">
          Quiet Hours
        </h2>
        <QuietHoursSettings
          settings={preferences.quietHours}
          timezone={preferences.timezone}
          onChange={(quietHours) => updatePreferences({ quietHours })}
          disabled={saving}
        />
      </section>

      <section aria-labelledby="categories-heading">
        <h2 id="categories-heading" className="text-lg font-semibold mb-4">
          Notification Categories
        </h2>
        <CategoryPreferences
          channels={preferences.channels}
          onChange={(categories) => updatePreferences({ categories })}
          disabled={saving}
        />
      </section>
    </div>
  );
}
```

### Channel Toggle with Status

```tsx
interface ChannelToggleProps {
  channel: ChannelPreference;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

function ChannelToggle({ channel, onToggle, disabled }: ChannelToggleProps) {
  const icons: Record<string, React.ReactNode> = {
    push: <BellIcon className="w-5 h-5" />,
    email: <EnvelopeIcon className="w-5 h-5" />,
    sms: <PhoneIcon className="w-5 h-5" />,
    in_app: <DevicePhoneMobileIcon className="w-5 h-5" />
  };

  const labels: Record<string, string> = {
    push: 'Push Notifications',
    email: 'Email',
    sms: 'SMS Text Messages',
    in_app: 'In-App Notifications'
  };

  const descriptions: Record<string, string> = {
    push: 'Receive alerts on your mobile device',
    email: 'Get notifications in your inbox',
    sms: 'Receive text messages for urgent alerts',
    in_app: 'See notifications within the app'
  };

  return (
    <div className="flex items-start gap-4 p-4 bg-white rounded-lg border border-gray-200">
      <div className="flex-shrink-0 p-2 bg-gray-100 rounded-lg">
        {icons[channel.channel]}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <label
            htmlFor={`channel-${channel.channel}`}
            className="font-medium text-gray-900"
          >
            {labels[channel.channel]}
          </label>
          <Switch
            id={`channel-${channel.channel}`}
            checked={channel.enabled}
            onChange={onToggle}
            disabled={disabled}
            aria-describedby={`channel-${channel.channel}-description`}
          />
        </div>
        <p
          id={`channel-${channel.channel}-description`}
          className="mt-1 text-sm text-gray-500"
        >
          {descriptions[channel.channel]}
        </p>

        {channel.enabled && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <CategoryQuickSettings
              channel={channel.channel}
              categories={channel.categories}
              onChange={(categories) => onToggle({ ...channel, categories })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

### Quiet Hours Time Picker

```tsx
function QuietHoursSettings({ settings, timezone, onChange, disabled }) {
  const timezones = Intl.supportedValuesOf('timeZone');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium">Enable Quiet Hours</span>
          <p className="text-sm text-gray-500">
            Pause non-critical notifications during specified hours
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onChange={(enabled) => onChange({ ...settings, enabled })}
          disabled={disabled}
          aria-label="Enable quiet hours"
        />
      </div>

      {settings.enabled && (
        <div className="pl-4 border-l-2 border-gray-200 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Start Time
              </label>
              <TimeInput
                value={settings.start}
                onChange={(start) => onChange({ ...settings, start })}
                disabled={disabled}
                aria-label="Quiet hours start time"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                End Time
              </label>
              <TimeInput
                value={settings.end}
                onChange={(end) => onChange({ ...settings, end })}
                disabled={disabled}
                aria-label="Quiet hours end time"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => onChange({ ...settings, timezone: e.target.value })}
              disabled={disabled}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              {timezones.map(tz => (
                <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>

          <QuietHoursPreview start={settings.start} end={settings.end} timezone={timezone} />
        </div>
      )}
    </div>
  );
}

function QuietHoursPreview({ start, end, timezone }) {
  const currentTime = new Date().toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit'
  });

  const isActive = isWithinQuietHours(currentTime, start, end);

  return (
    <div className={`p-3 rounded-lg ${isActive ? 'bg-amber-50' : 'bg-gray-50'}`}>
      <div className="flex items-center gap-2">
        {isActive ? (
          <>
            <MoonIcon className="w-4 h-4 text-amber-600" />
            <span className="text-sm text-amber-800">
              Quiet hours are currently active
            </span>
          </>
        ) : (
          <>
            <SunIcon className="w-4 h-4 text-gray-600" />
            <span className="text-sm text-gray-700">
              Quiet hours will start at {start}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
```

---

## Deep Dive: Notification Center (10 minutes)

### Notification Center Layout

```tsx
function NotificationCenter() {
  const { notifications, unreadCount, markAsRead, markAllAsRead, loading } = useNotifications();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const filteredNotifications = useMemo(() => {
    return notifications.filter(n => {
      if (filter === 'unread' && n.readAt) return false;
      if (categoryFilter && n.category !== categoryFilter) return false;
      return true;
    });
  }, [notifications, filter, categoryFilter]);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Notifications</h1>
          {unreadCount > 0 && (
            <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-800 rounded-full">
              {unreadCount} new
            </span>
          )}
        </div>

        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            Mark all as read
          </button>
        )}
      </header>

      <div className="flex items-center gap-2 px-4 py-2 border-b bg-gray-50">
        <FilterPills
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' }
          ]}
          selected={filter}
          onChange={setFilter}
        />

        <div className="w-px h-4 bg-gray-300" />

        <CategoryFilter
          selected={categoryFilter}
          onChange={setCategoryFilter}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <NotificationListSkeleton count={5} />
        ) : filteredNotifications.length === 0 ? (
          <EmptyState
            icon={<BellSlashIcon className="w-12 h-12" />}
            title="No notifications"
            description={filter === 'unread'
              ? "You're all caught up!"
              : "You haven't received any notifications yet"
            }
          />
        ) : (
          <VirtualizedNotificationList
            notifications={filteredNotifications}
            onMarkAsRead={markAsRead}
          />
        )}
      </div>
    </div>
  );
}
```

### Individual Notification Card

```tsx
interface NotificationCardProps {
  notification: Notification;
  onMarkAsRead: (id: string) => void;
  onDismiss: (id: string) => void;
}

function NotificationCard({ notification, onMarkAsRead, onDismiss }: NotificationCardProps) {
  const categoryIcons: Record<string, React.ReactNode> = {
    security: <ShieldCheckIcon className="w-5 h-5 text-red-500" />,
    order: <ShoppingBagIcon className="w-5 h-5 text-green-500" />,
    social: <UserGroupIcon className="w-5 h-5 text-blue-500" />,
    marketing: <MegaphoneIcon className="w-5 h-5 text-purple-500" />,
    system: <CogIcon className="w-5 h-5 text-gray-500" />
  };

  const handleClick = () => {
    if (!notification.readAt) {
      onMarkAsRead(notification.id);
    }
    if (notification.actionUrl) {
      window.location.href = notification.actionUrl;
    }
  };

  return (
    <article
      className={`
        relative p-4 border-b cursor-pointer transition-colors
        ${notification.readAt ? 'bg-white' : 'bg-blue-50'}
        hover:bg-gray-50
      `}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      aria-label={`${notification.readAt ? '' : 'Unread: '}${notification.title}`}
    >
      <div className="flex gap-3">
        <div className="flex-shrink-0 mt-1">
          {categoryIcons[notification.category] || categoryIcons.system}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className={`text-sm ${notification.readAt ? 'font-normal' : 'font-semibold'}`}>
              {notification.title}
            </h3>
            <time
              className="flex-shrink-0 text-xs text-gray-500"
              dateTime={notification.createdAt}
              title={new Date(notification.createdAt).toLocaleString()}
            >
              {formatRelativeTime(notification.createdAt)}
            </time>
          </div>

          <p className="mt-1 text-sm text-gray-600 line-clamp-2">
            {notification.body}
          </p>

          {notification.channels && (
            <div className="mt-2 flex gap-1">
              {notification.channels.map(channel => (
                <ChannelBadge
                  key={channel.name}
                  channel={channel.name}
                  status={channel.status}
                />
              ))}
            </div>
          )}
        </div>

        {!notification.readAt && (
          <div
            className="absolute left-1 top-1/2 -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full"
            aria-label="Unread indicator"
          />
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(notification.id);
        }}
        className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100"
        aria-label="Dismiss notification"
      >
        <XMarkIcon className="w-4 h-4" />
      </button>
    </article>
  );
}
```

### Channel Delivery Status Badge

```tsx
function ChannelBadge({ channel, status }: { channel: string; status: DeliveryStatus }) {
  const icons: Record<string, React.ReactNode> = {
    push: <DevicePhoneMobileIcon className="w-3 h-3" />,
    email: <EnvelopeIcon className="w-3 h-3" />,
    sms: <ChatBubbleLeftIcon className="w-3 h-3" />,
    in_app: <BellIcon className="w-3 h-3" />
  };

  const statusStyles: Record<DeliveryStatus, string> = {
    sent: 'bg-green-100 text-green-800',
    delivered: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    failed: 'bg-red-100 text-red-800',
    suppressed: 'bg-gray-100 text-gray-600'
  };

  const statusLabels: Record<DeliveryStatus, string> = {
    sent: 'Sent',
    delivered: 'Delivered',
    pending: 'Pending',
    failed: 'Failed',
    suppressed: 'Suppressed'
  };

  return (
    <span
      className={`
        inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium
        ${statusStyles[status]}
      `}
      title={`${channel}: ${statusLabels[status]}`}
    >
      {icons[channel]}
      <span className="capitalize">{channel}</span>
      {status === 'failed' && <ExclamationCircleIcon className="w-3 h-3" />}
    </span>
  );
}
```

---

## Deep Dive: Real-Time Notifications (8 minutes)

### In-App Notification Toast

```tsx
function NotificationToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<NotificationToast[]>([]);

  useEffect(() => {
    const ws = new WebSocket(getWebSocketUrl());

    ws.onmessage = (event) => {
      const notification = JSON.parse(event.data);

      if (notification.type === 'NEW_NOTIFICATION') {
        const toast: NotificationToast = {
          id: notification.id,
          title: notification.title,
          body: notification.body,
          category: notification.category,
          actionUrl: notification.actionUrl,
          createdAt: Date.now()
        };

        setToasts(prev => [...prev, toast]);

        // Auto-dismiss after 5 seconds
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toast.id));
        }, 5000);
      }
    };

    return () => ws.close();
  }, []);

  const dismissToast = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  return (
    <>
      {children}

      <div
        className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.1 } }}
            >
              <ToastNotification
                toast={toast}
                onDismiss={() => dismissToast(toast.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </>
  );
}

function ToastNotification({ toast, onDismiss }: { toast: NotificationToast; onDismiss: () => void }) {
  return (
    <div
      className="bg-white rounded-lg shadow-lg border p-4 cursor-pointer hover:shadow-xl transition-shadow"
      onClick={() => {
        if (toast.actionUrl) {
          window.location.href = toast.actionUrl;
        }
        onDismiss();
      }}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <CategoryIcon category={toast.category} className="w-5 h-5 flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-900">{toast.title}</h4>
          <p className="mt-1 text-sm text-gray-500 line-clamp-2">{toast.body}</p>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
          aria-label="Dismiss"
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-2 h-1 bg-gray-200 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-blue-500"
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: 5, ease: 'linear' }}
        />
      </div>
    </div>
  );
}
```

### Notification Badge with Animation

```tsx
function NotificationBellButton() {
  const { unreadCount } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const [animate, setAnimate] = useState(false);
  const prevCount = useRef(unreadCount);

  // Animate badge when count increases
  useEffect(() => {
    if (unreadCount > prevCount.current) {
      setAnimate(true);
      const timeout = setTimeout(() => setAnimate(false), 500);
      return () => clearTimeout(timeout);
    }
    prevCount.current = unreadCount;
  }, [unreadCount]);

  return (
    <Popover className="relative">
      <Popover.Button
        className="relative p-2 text-gray-600 hover:text-gray-900"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      >
        <BellIcon className="w-6 h-6" />

        {unreadCount > 0 && (
          <motion.span
            className={`
              absolute -top-1 -right-1 flex items-center justify-center
              min-w-[20px] h-5 px-1.5 text-xs font-bold
              bg-red-500 text-white rounded-full
            `}
            animate={animate ? { scale: [1, 1.3, 1] } : {}}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </motion.span>
        )}
      </Popover.Button>

      <Popover.Panel className="absolute right-0 z-10 mt-2 w-96 origin-top-right">
        <div className="rounded-lg shadow-lg ring-1 ring-black ring-opacity-5 bg-white overflow-hidden">
          <NotificationCenter />
        </div>
      </Popover.Panel>
    </Popover>
  );
}
```

---

## Deep Dive: State Management (7 minutes)

### Zustand Stores

```typescript
// Notification store
interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  error: Error | null;

  fetchNotifications: () => Promise<void>;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  addNotification: (notification: Notification) => void;
  dismissNotification: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  loading: false,
  error: null,

  fetchNotifications: async () => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('/notifications');
      set({
        notifications: response.data.notifications,
        unreadCount: response.data.unreadCount,
        loading: false
      });
    } catch (error) {
      set({ error: error as Error, loading: false });
    }
  },

  markAsRead: async (id) => {
    // Optimistic update
    set(state => ({
      notifications: state.notifications.map(n =>
        n.id === id ? { ...n, readAt: new Date().toISOString() } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1)
    }));

    try {
      await api.post(`/notifications/${id}/read`);
    } catch (error) {
      // Revert on failure
      get().fetchNotifications();
    }
  },

  markAllAsRead: async () => {
    set(state => ({
      notifications: state.notifications.map(n => ({
        ...n,
        readAt: n.readAt || new Date().toISOString()
      })),
      unreadCount: 0
    }));

    try {
      await api.post('/notifications/read-all');
    } catch (error) {
      get().fetchNotifications();
    }
  },

  addNotification: (notification) => {
    set(state => ({
      notifications: [notification, ...state.notifications],
      unreadCount: state.unreadCount + 1
    }));
  },

  dismissNotification: (id) => {
    set(state => ({
      notifications: state.notifications.filter(n => n.id !== id)
    }));
  }
}));

// Preferences store with persistence
interface PreferencesState {
  preferences: UserPreferences | null;
  loading: boolean;
  saving: boolean;
  error: Error | null;
  pendingChanges: Partial<UserPreferences>;

  fetchPreferences: () => Promise<void>;
  updatePreferences: (updates: Partial<UserPreferences>) => void;
  savePreferences: () => Promise<void>;
  discardChanges: () => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set, get) => ({
      preferences: null,
      loading: false,
      saving: false,
      error: null,
      pendingChanges: {},

      fetchPreferences: async () => {
        set({ loading: true, error: null });
        try {
          const response = await api.get('/preferences');
          set({ preferences: response.data, loading: false, pendingChanges: {} });
        } catch (error) {
          set({ error: error as Error, loading: false });
        }
      },

      updatePreferences: (updates) => {
        set(state => ({
          preferences: state.preferences ? { ...state.preferences, ...updates } : null,
          pendingChanges: { ...state.pendingChanges, ...updates }
        }));

        // Debounced auto-save
        get().debouncedSave();
      },

      savePreferences: async () => {
        const { pendingChanges, preferences } = get();
        if (Object.keys(pendingChanges).length === 0) return;

        set({ saving: true });
        try {
          await api.put('/preferences', pendingChanges);
          set({ saving: false, pendingChanges: {} });
        } catch (error) {
          set({ saving: false, error: error as Error });
          // Keep pending changes for retry
        }
      },

      discardChanges: () => {
        get().fetchPreferences();
      }
    }),
    {
      name: 'notification-preferences',
      partialize: (state) => ({ preferences: state.preferences })
    }
  )
);
```

### Offline Support Hook

```typescript
function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingActions, setPendingActions] = useState<Action[]>([]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncPendingActions();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const queueAction = (action: Action) => {
    if (isOnline) {
      return executeAction(action);
    }

    setPendingActions(prev => [...prev, { ...action, queuedAt: Date.now() }]);
    return Promise.resolve();
  };

  const syncPendingActions = async () => {
    const actions = [...pendingActions];
    setPendingActions([]);

    for (const action of actions) {
      try {
        await executeAction(action);
      } catch (error) {
        // Re-queue failed actions
        setPendingActions(prev => [...prev, action]);
      }
    }
  };

  return { isOnline, queueAction, pendingCount: pendingActions.length };
}
```

---

## Deep Dive: Admin Dashboard (5 minutes)

### Delivery Metrics Dashboard

```tsx
function DeliveryDashboard() {
  const { metrics, loading } = useDeliveryMetrics();
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d'>('24h');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Delivery Dashboard</h1>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricCard
          title="Total Sent"
          value={metrics.totalSent}
          trend={metrics.sentTrend}
          icon={<PaperAirplaneIcon />}
        />
        <MetricCard
          title="Delivered"
          value={metrics.delivered}
          percentage={(metrics.delivered / metrics.totalSent * 100).toFixed(1)}
          icon={<CheckCircleIcon />}
          variant="success"
        />
        <MetricCard
          title="Failed"
          value={metrics.failed}
          percentage={(metrics.failed / metrics.totalSent * 100).toFixed(1)}
          icon={<XCircleIcon />}
          variant="danger"
        />
        <MetricCard
          title="Queue Depth"
          value={metrics.queueDepth}
          icon={<QueueListIcon />}
          variant={metrics.queueDepth > 10000 ? 'warning' : 'default'}
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardHeader title="Throughput (per minute)" />
          <ThroughputChart data={metrics.throughput} timeRange={timeRange} />
        </Card>

        <Card>
          <CardHeader title="Success Rate by Channel" />
          <ChannelSuccessChart data={metrics.channelStats} />
        </Card>
      </div>

      <Card>
        <CardHeader title="Circuit Breaker Status" />
        <CircuitBreakerPanel breakers={metrics.circuitBreakers} />
      </Card>
    </div>
  );
}
```

### Circuit Breaker Status Panel

```tsx
function CircuitBreakerPanel({ breakers }: { breakers: CircuitBreakerStatus[] }) {
  const stateColors: Record<string, string> = {
    CLOSED: 'bg-green-100 text-green-800',
    OPEN: 'bg-red-100 text-red-800',
    HALF_OPEN: 'bg-yellow-100 text-yellow-800'
  };

  return (
    <div className="grid grid-cols-4 gap-4">
      {breakers.map(breaker => (
        <div
          key={breaker.channel}
          className={`
            p-4 rounded-lg border
            ${breaker.state === 'OPEN' ? 'border-red-200 bg-red-50' : 'border-gray-200'}
          `}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium capitalize">{breaker.channel}</span>
            <span className={`px-2 py-1 rounded text-xs font-medium ${stateColors[breaker.state]}`}>
              {breaker.state}
            </span>
          </div>

          <div className="mt-2 text-sm text-gray-500">
            <div>Failures: {breaker.failures}</div>
            {breaker.lastFailure && (
              <div>Last failure: {formatRelativeTime(breaker.lastFailure)}</div>
            )}
          </div>

          {breaker.state === 'OPEN' && (
            <button
              onClick={() => resetCircuitBreaker(breaker.channel)}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              Force Reset
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand with persist | Redux Toolkit | Simpler API, built-in persistence |
| Real-Time Updates | WebSocket | Server-Sent Events | Bi-directional communication needed |
| Notification Display | Toast + Center | Only Toast | Users need history access |
| Preference Updates | Debounced auto-save | Explicit save button | Better UX, fewer clicks |
| Time Display | Relative time | Absolute time | More intuitive for recent notifications |
| Animation Library | Framer Motion | CSS transitions | Smooth list animations, exit support |
| Virtualization | @tanstack/react-virtual | Full render | Performance with large notification lists |

---

## Future Enhancements

1. **Push Notification Permission Flow**: Native browser notification permission request
2. **Notification Grouping**: Group similar notifications to reduce noise
3. **Snooze Functionality**: Allow users to snooze individual notifications
4. **Rich Media Notifications**: Support images and action buttons in toasts
5. **Notification Scheduling Preview**: Show when scheduled notifications will arrive
6. **Analytics Dashboard**: Open/click rate tracking for admin users
