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

### Preferences Panel Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Preferences Panel                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  NOTIFICATION CHANNELS                                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [Bell Icon]  Push Notifications                    [====Toggle]  │  │
│  │               Receive alerts on your mobile device                │  │
│  │               ┌─────────────────────────────────────┐            │  │
│  │               │ Category Quick Settings (expanded)  │            │  │
│  │               │ [x] Security  [x] Orders  [ ] Marketing         │  │
│  │               └─────────────────────────────────────┘            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [Envelope]   Email                                 [====Toggle]  │  │
│  │               Get notifications in your inbox                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [Phone Icon] SMS Text Messages                     [    Toggle]  │  │
│  │               Receive text messages for urgent alerts             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [Device]     In-App Notifications                  [====Toggle]  │  │
│  │               See notifications within the app                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  QUIET HOURS                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Enable Quiet Hours                                 [====Toggle]  │  │
│  │  Pause non-critical notifications during specified hours         │  │
│  │                                                                   │  │
│  │  │  Start Time        End Time                                   │  │
│  │  │  [22:00    ]       [07:00    ]                               │  │
│  │  │                                                               │  │
│  │  │  Timezone                                                     │  │
│  │  │  [America/New_York              v]                           │  │
│  │  │                                                               │  │
│  │  │  ┌─────────────────────────────────────────┐                 │  │
│  │  │  │ [Moon Icon] Quiet hours are currently   │  amber bg      │  │
│  │  │  │             active                       │                 │  │
│  │  │  └─────────────────────────────────────────┘                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  NOTIFICATION CATEGORIES                                                 │
│  [Expandable category preferences per channel]                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Channel Toggle Component Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ChannelToggle Component                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Props:                                                                  │
│  ├── channel: ChannelPreference                                         │
│  ├── onToggle: (enabled: boolean) => void                               │
│  └── disabled?: boolean                                                 │
│                                                                          │
│  Layout:                                                                 │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ┌──────────┐  ┌──────────────────────────────────┐  ┌────────┐  │  │
│  │  │  Icon    │  │  Label (for="channel-{id}")      │  │ Switch │  │  │
│  │  │  Box     │  │  Description (aria-describedby)  │  │        │  │  │
│  │  │ bg-gray  │  │                                  │  │        │  │  │
│  │  └──────────┘  └──────────────────────────────────┘  └────────┘  │  │
│  │                                                                   │  │
│  │  {channel.enabled && (                                            │  │
│  │    <CategoryQuickSettings>  // Nested category toggles            │  │
│  │  )}                                                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Icons by channel:                                                       │
│  ├── push    ──▶ BellIcon                                               │
│  ├── email   ──▶ EnvelopeIcon                                           │
│  ├── sms     ──▶ PhoneIcon                                              │
│  └── in_app  ──▶ DevicePhoneMobileIcon                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

> "I chose to show category settings inline when a channel is enabled rather than in a separate section. This creates a clear visual hierarchy - toggle the channel, then fine-tune categories - and reduces the cognitive load of navigating to a separate settings area."

---

## Deep Dive: Notification Center (10 minutes)

### Notification Center Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Notification Center                                │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Notifications                 [12 new]      "Mark all as read"   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  [All] [Unread]    |    [Category Filter v]                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Notification List (virtualized):                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ [Blue dot]                                                        │  │
│  │  [ShieldIcon]  Security Alert                           2m ago   │  │
│  │  red           New login detected from Chrome on Windows          │  │
│  │                [push: Delivered] [email: Sent]            [X]     │  │
│  ├───────────────────────────────────────────────────────────────────┤  │
│  │  [ShoppingBag] Order Shipped                            1h ago   │  │
│  │  green         Your order #12345 is on its way                   │  │
│  │                [push: Delivered] [sms: Delivered]                 │  │
│  ├───────────────────────────────────────────────────────────────────┤  │
│  │  [UserGroup]   New Follower                             3h ago   │  │
│  │  blue          @johndoe started following you                     │  │
│  │                [in_app: Delivered]                                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Empty State:                                                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │            [BellSlashIcon]                                        │  │
│  │            "No notifications"                                     │  │
│  │            "You're all caught up!" (if unread filter)             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Notification Card Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   NotificationCard Component                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Structure:                                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <article>                                                        │  │
│  │    role="button"                                                  │  │
│  │    tabIndex={0}                                                   │  │
│  │    aria-label="{Unread: }{title}"                                │  │
│  │    className={readAt ? 'bg-white' : 'bg-blue-50'}                │  │
│  │                                                                   │  │
│  │    ┌─────────┐ ┌─────────────────────────────────────┐ ┌──────┐  │  │
│  │    │Category │ │ Title (font-semibold if unread)     │ │ Time │  │  │
│  │    │  Icon   │ │ Body (line-clamp-2)                 │ │      │  │  │
│  │    └─────────┘ │ [ChannelBadge] [ChannelBadge]       │ └──────┘  │  │
│  │                └─────────────────────────────────────┘           │  │
│  │                                                                   │  │
│  │    {!readAt && <BlueDotIndicator />}                             │  │
│  │    <DismissButton onClick={onDismiss} />                         │  │
│  │  </article>                                                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Category Icons:                                                         │
│  ├── security  ──▶ ShieldCheckIcon (red)                                │
│  ├── order     ──▶ ShoppingBagIcon (green)                              │
│  ├── social    ──▶ UserGroupIcon (blue)                                 │
│  ├── marketing ──▶ MegaphoneIcon (purple)                               │
│  └── system    ──▶ CogIcon (gray)                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Channel Delivery Status Badge

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     ChannelBadge Component                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Visual: [ChannelIcon] [Channel Name] [Status Icon if failed]           │
│                                                                          │
│  Status Styles:                                                          │
│  ├── sent / delivered  ──▶ bg-green-100 text-green-800                  │
│  ├── pending           ──▶ bg-yellow-100 text-yellow-800                │
│  ├── failed            ──▶ bg-red-100 text-red-800 + ExclamationIcon    │
│  └── suppressed        ──▶ bg-gray-100 text-gray-600                    │
│                                                                          │
│  Example badges:                                                         │
│  ┌────────────────┐ ┌─────────────────┐ ┌───────────────────┐           │
│  │ [Phone] Push   │ │ [Envelope] Email│ │ [!] SMS Failed    │           │
│  │ green          │ │ green           │ │ red               │           │
│  └────────────────┘ └─────────────────┘ └───────────────────┘           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Real-Time Notifications (8 minutes)

### Toast Notification System

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  NotificationToastProvider                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Architecture:                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  WebSocket Connection                                            │    │
│  │    │                                                             │    │
│  │    └── onmessage ──▶ if type === 'NEW_NOTIFICATION':            │    │
│  │                        ├── Create toast object                   │    │
│  │                        ├── Add to toasts[]                       │    │
│  │                        └── setTimeout(dismiss, 5000)             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Toast Container (fixed bottom-right, z-50):                             │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <div role="region" aria-label="Notifications" aria-live="polite">│  │
│  │                                                                   │  │
│  │    <AnimatePresence>  (Framer Motion)                            │  │
│  │      {toasts.map(toast => (                                      │  │
│  │        <motion.div                                                │  │
│  │          initial={{ opacity: 0, y: 20, scale: 0.95 }}            │  │
│  │          animate={{ opacity: 1, y: 0, scale: 1 }}                │  │
│  │          exit={{ opacity: 0, scale: 0.95 }}                      │  │
│  │        >                                                          │  │
│  │          <ToastNotification toast={toast} />                     │  │
│  │        </motion.div>                                              │  │
│  │      ))}                                                          │  │
│  │    </AnimatePresence>                                             │  │
│  │                                                                   │  │
│  │  </div>                                                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Toast Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ToastNotification Component                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  <div role="alert">                                               │  │
│  │                                                                   │  │
│  │    ┌─────────┐ ┌───────────────────────────────┐ ┌─────────┐     │  │
│  │    │Category │ │ Title (font-medium)           │ │ Dismiss │     │  │
│  │    │  Icon   │ │ Body (line-clamp-2)           │ │   [X]   │     │  │
│  │    └─────────┘ └───────────────────────────────┘ └─────────┘     │  │
│  │                                                                   │  │
│  │    Progress Bar (auto-dismiss timer):                             │  │
│  │    ┌─────────────────────────────────────────────────────────┐   │  │
│  │    │ [==================================                     ]│   │  │
│  │    │  bg-blue-500, animates from 100% to 0% over 5 seconds   │   │  │
│  │    └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  </div>                                                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Interactions:                                                           │
│  ├── Click toast ──▶ Navigate to actionUrl (if present), dismiss       │
│  ├── Click [X]   ──▶ Dismiss immediately                                │
│  └── Hover       ──▶ Pause auto-dismiss timer (optional enhancement)   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Notification Bell Button

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   NotificationBellButton                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Normal State:                                                           │
│  ┌─────────┐                                                            │
│  │  [Bell] │  aria-label="Notifications"                                │
│  └─────────┘                                                            │
│                                                                          │
│  With Unread Count:                                                      │
│  ┌─────────┐                                                            │
│  │  [Bell] │  aria-label="Notifications, 12 unread"                     │
│  │    [12] │  ──▶ Badge: min-w-20px, bg-red-500, rounded-full           │
│  └─────────┘      animate: { scale: [1, 1.3, 1] } when count increases  │
│                                                                          │
│  Popover Panel (on click):                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  [Popover.Panel className="w-96"]                                │    │
│  │    ├── origin-top-right                                          │    │
│  │    ├── ring-1 ring-black/5                                       │    │
│  │    └── <NotificationCenter />  (embedded)                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Badge Animation Logic:                                                  │
│  ├── Track previous count with useRef                                   │
│  ├── On count increase: trigger bounce animation                        │
│  └── Clear animation after 500ms                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The animated badge is a small detail that makes notifications feel more alive. When a new notification arrives, the badge bounces to draw attention without being disruptive. This is especially important when users are focused on other tasks."

---

## Deep Dive: State Management (7 minutes)

### Notification Store (Zustand)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     NotificationStore                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                                                                  │
│  ├── notifications: Notification[]                                      │
│  ├── unreadCount: number                                                │
│  ├── loading: boolean                                                   │
│  └── error: Error | null                                                │
│                                                                          │
│  Actions:                                                                │
│  ├── fetchNotifications() ──▶ GET /notifications                        │
│  │                            set { notifications, unreadCount }        │
│  │                                                                      │
│  ├── markAsRead(id) ──▶ Optimistic update:                              │
│  │                      ├── Update notification.readAt locally          │
│  │                      ├── Decrement unreadCount                       │
│  │                      ├── POST /notifications/{id}/read              │
│  │                      └── On error: refetch to revert                 │
│  │                                                                      │
│  ├── markAllAsRead() ──▶ Optimistic update:                             │
│  │                       ├── Set all readAt timestamps                  │
│  │                       ├── Set unreadCount = 0                        │
│  │                       └── POST /notifications/read-all              │
│  │                                                                      │
│  ├── addNotification(n) ──▶ Prepend to list, increment unreadCount     │
│  │                                                                      │
│  └── dismissNotification(id) ──▶ Filter from list                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Preferences Store with Persistence

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     PreferencesStore                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                                                                  │
│  ├── preferences: UserPreferences | null                                │
│  ├── loading: boolean                                                   │
│  ├── saving: boolean                                                    │
│  ├── error: Error | null                                                │
│  └── pendingChanges: Partial<UserPreferences>                          │
│                                                                          │
│  Actions:                                                                │
│  ├── fetchPreferences() ──▶ GET /preferences                            │
│  │                          set { preferences }, clear pendingChanges   │
│  │                                                                      │
│  ├── updatePreferences(updates) ──▶                                     │
│  │     ├── Merge into preferences (immediate UI update)                 │
│  │     ├── Merge into pendingChanges                                    │
│  │     └── Trigger debounced auto-save                                  │
│  │                                                                      │
│  ├── savePreferences() ──▶                                              │
│  │     ├── PUT /preferences with pendingChanges                         │
│  │     └── Clear pendingChanges on success                              │
│  │                                                                      │
│  └── discardChanges() ──▶ Refetch to revert                             │
│                                                                          │
│  Persistence (Zustand persist middleware):                               │
│  ├── name: 'notification-preferences'                                   │
│  └── partialize: only persist { preferences }                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

> "I use debounced auto-save rather than explicit save buttons. When a user toggles a preference, it updates immediately in the UI (optimistic), queues the change, and auto-saves after 500ms of inactivity. This feels more responsive while still being efficient with API calls."

### Offline Support Hook

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     useOfflineSync Hook                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State:                                                                  │
│  ├── isOnline: navigator.onLine (updates via event listeners)           │
│  └── pendingActions: Action[] (queued when offline)                     │
│                                                                          │
│  Behavior:                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  User Action                                                     │    │
│  │       │                                                          │    │
│  │       ▼                                                          │    │
│  │  isOnline?                                                       │    │
│  │    ├── Yes ──▶ Execute immediately                               │    │
│  │    └── No  ──▶ Queue action with timestamp                       │    │
│  │                                                                  │    │
│  │  On 'online' event:                                              │    │
│  │    ├── Process all pending actions                               │    │
│  │    └── Re-queue any that fail                                    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Return:                                                                 │
│  ├── isOnline: boolean                                                  │
│  ├── queueAction: (action) => Promise<void>                            │
│  └── pendingCount: number                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive: Admin Dashboard (5 minutes)

### Delivery Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Delivery Dashboard                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Delivery Dashboard                        [1h] [24h] [7d]        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  Metric Cards (grid-cols-4):                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│  │ Total Sent   │ │ Delivered    │ │ Failed       │ │ Queue Depth  │   │
│  │ [Plane Icon] │ │ [Check Icon] │ │ [X Icon]     │ │ [Queue Icon] │   │
│  │              │ │              │ │              │ │              │   │
│  │   125,432    │ │   123,891    │ │     541      │ │    1,847     │   │
│  │   +12%       │ │   98.7%      │ │   0.4%       │ │  (warning    │   │
│  │              │ │  (success)   │ │  (danger)    │ │   if >10K)   │   │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘   │
│                                                                          │
│  Charts (grid-cols-2):                                                   │
│  ┌────────────────────────────────┐ ┌────────────────────────────────┐  │
│  │  Throughput (per minute)       │ │  Success Rate by Channel       │  │
│  │  ┌──────────────────────────┐  │ │  ┌──────────────────────────┐  │  │
│  │  │        ____/\            │  │ │  │  Push   [========] 99%  │  │  │
│  │  │   ___/       \___        │  │ │  │  Email  [=======] 97%   │  │  │
│  │  │  /               \_      │  │ │  │  SMS    [======] 94%    │  │  │
│  │  └──────────────────────────┘  │ │  │  InApp  [=========] 100%│  │  │
│  └────────────────────────────────┘ └──────────────────────────────────┘│
│                                                                          │
│  Circuit Breaker Status:                                                 │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐              │ │
│  │  │  Push    │ │  Email   │ │  SMS     │ │  In-App  │              │ │
│  │  │ [CLOSED] │ │ [CLOSED] │ │ [OPEN]   │ │ [CLOSED] │              │ │
│  │  │  green   │ │  green   │ │  red     │ │  green   │              │ │
│  │  │          │ │          │ │Fail: 15  │ │          │              │ │
│  │  │          │ │          │ │[Reset]   │ │          │              │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘              │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Circuit Breaker Panel

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   CircuitBreakerPanel                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State Badge Styles:                                                     │
│  ├── CLOSED    ──▶ bg-green-100 text-green-800  "Healthy"               │
│  ├── OPEN      ──▶ bg-red-100 text-red-800      "Circuit Open"          │
│  └── HALF_OPEN ──▶ bg-yellow-100 text-yellow-800 "Testing"              │
│                                                                          │
│  Card Structure (for OPEN state):                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  border-red-200 bg-red-50                                         │  │
│  │                                                                   │  │
│  │  SMS                                            [OPEN]            │  │
│  │                                                  red badge        │  │
│  │  Failures: 15                                                     │  │
│  │  Last failure: 2 minutes ago                                      │  │
│  │                                                                   │  │
│  │  [Force Reset]  (blue link, calls resetCircuitBreaker(channel))  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

> "The circuit breaker panel is critical for ops visibility. When a channel is unhealthy, admins need to see it immediately and have the ability to force a reset. The red styling and 'Force Reset' button make this actionable at a glance."

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

1. **Push Notification Permission Flow**: Native browser notification permission request with fallback guidance
2. **Notification Grouping**: Group similar notifications (e.g., "5 new followers") to reduce noise
3. **Snooze Functionality**: Allow users to snooze individual notifications for 1h, 1d, 1w
4. **Rich Media Notifications**: Support images and action buttons in toasts
5. **Notification Scheduling Preview**: Show when scheduled notifications will arrive
6. **Analytics Dashboard**: Open/click rate tracking for admin users with A/B test support
