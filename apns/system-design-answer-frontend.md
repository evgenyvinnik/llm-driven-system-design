# APNs (Apple Push Notification Service) - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement (1 minute)

"I'll design APNs from a frontend engineering perspective, focusing on building an admin dashboard for monitoring and managing the push notification infrastructure. The key challenges are real-time visualization of notification delivery metrics, managing device tokens and subscriptions, and providing a responsive interface for operations teams.

For this discussion, I'll emphasize the React component architecture, real-time data updates via WebSocket, state management patterns, and building accessible, performant admin interfaces."

## Requirements Clarification (3 minutes)

### Functional Requirements
1. **Dashboard Overview**: Real-time metrics showing notification throughput, delivery rates, and queue depth
2. **Device Management**: Search, view, and manage registered device tokens
3. **Notification Testing**: Send test notifications to specific devices
4. **Topic Management**: View and manage topic subscriptions
5. **Feedback Viewer**: Browse invalid token reports for debugging

### Non-Functional Requirements
1. **Real-time Updates**: Dashboard refreshes within 5 seconds of new data
2. **Responsiveness**: Usable on tablet and desktop (admin tool)
3. **Performance**: Handle displaying 10,000+ device records with virtualization
4. **Accessibility**: WCAG 2.1 AA compliance for admin interfaces

### Key User Personas
- **DevOps Engineer**: Monitors delivery health, responds to alerts
- **App Developer**: Tests notifications, debugs token issues
- **Support Agent**: Looks up device status for user tickets

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           APNs Admin Dashboard                                       │
│                                                                                      │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │   Dashboard    │  │    Devices     │  │    Topics      │  │   Feedback     │   │
│  │                │  │                │  │                │  │                │   │
│  │ - Metrics      │  │ - Token search │  │ - Topic list   │  │ - Invalid list │   │
│  │ - Charts       │  │ - Device table │  │ - Subscribers  │  │ - Export       │   │
│  │ - Alerts       │  │ - Actions      │  │ - Broadcast    │  │ - Filtering    │   │
│  └────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐   │
│  │                         Shared Components                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │   │
│  │  │  Metric  │  │ DataTable│  │ Timeline │  │  Modal   │  │  Toast   │       │   │
│  │  │   Card   │  │          │  │  Chart   │  │  Dialog  │  │ Notifier │       │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              State Management                                        │
│                                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐                 │
│  │  TanStack Query │    │     Zustand     │    │    WebSocket    │                 │
│  │                 │    │                 │    │                 │                 │
│  │ - API caching   │    │ - UI state      │    │ - Real-time     │                 │
│  │ - Mutations     │    │ - Filters       │    │ - Live metrics  │                 │
│  │ - Pagination    │    │ - Selection     │    │ - Delivery feed │                 │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              Backend API                                             │
│         GET /admin/stats  |  GET /admin/devices  |  POST /admin/send-test          │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Real-Time Dashboard (8 minutes)

### Metrics Overview Component

```tsx
// routes/index.tsx - Dashboard home
import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { MetricCard } from '../components/MetricCard';
import { DeliveryChart } from '../components/DeliveryChart';

export function DashboardRoute() {
  // Initial stats from API
  const { data: stats } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => fetch('/api/v1/admin/stats').then(r => r.json()),
    refetchInterval: 30000, // Fallback refresh
  });

  // Real-time updates via WebSocket
  const { metrics } = useWebSocket('/api/v1/admin/ws');

  // Merge API data with real-time updates
  const currentStats = metrics || stats;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-6">
      <MetricCard
        title="Notifications/sec"
        value={currentStats?.throughput || 0}
        trend={currentStats?.throughputTrend}
        icon={<BellIcon />}
      />
      <MetricCard
        title="Delivery Rate"
        value={`${(currentStats?.deliveryRate * 100).toFixed(2)}%`}
        target="99.99%"
        status={currentStats?.deliveryRate >= 0.9999 ? 'healthy' : 'warning'}
        icon={<CheckCircleIcon />}
      />
      <MetricCard
        title="Active Connections"
        value={currentStats?.activeConnections || 0}
        icon={<LinkIcon />}
      />
      <MetricCard
        title="Pending Queue"
        value={currentStats?.pendingCount || 0}
        status={currentStats?.pendingCount > 10000 ? 'warning' : 'healthy'}
        icon={<QueueIcon />}
      />

      {/* Delivery Timeline Chart */}
      <div className="col-span-full">
        <DeliveryChart data={currentStats?.timeline || []} />
      </div>

      {/* Live Notification Feed */}
      <div className="col-span-full lg:col-span-2">
        <LiveDeliveryFeed />
      </div>

      {/* Recent Errors */}
      <div className="col-span-full lg:col-span-2">
        <RecentErrors />
      </div>
    </div>
  );
}
```

### WebSocket Hook for Real-Time Updates

```tsx
// hooks/useWebSocket.ts
import { useEffect, useState, useRef, useCallback } from 'react';

interface WebSocketState {
  metrics: AdminMetrics | null;
  deliveries: DeliveryEvent[];
  connectionStatus: 'connecting' | 'connected' | 'disconnected';
}

export function useWebSocket(url: string) {
  const [state, setState] = useState<WebSocketState>({
    metrics: null,
    deliveries: [],
    connectionStatus: 'connecting',
  });
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();

  const connect = useCallback(() => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setState(prev => ({ ...prev, connectionStatus: 'connected' }));
      // Subscribe to admin metrics channel
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'admin_metrics' }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);

      switch (message.type) {
        case 'metrics_update':
          setState(prev => ({ ...prev, metrics: message.data }));
          break;
        case 'delivery_event':
          setState(prev => ({
            ...prev,
            deliveries: [message.data, ...prev.deliveries.slice(0, 99)],
          }));
          break;
      }
    };

    ws.onclose = () => {
      setState(prev => ({ ...prev, connectionStatus: 'disconnected' }));
      // Reconnect with exponential backoff
      reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
    };

    wsRef.current = ws;
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connect]);

  return state;
}
```

### MetricCard Component with Animations

```tsx
// components/MetricCard.tsx
import { motion } from 'framer-motion';
import { ReactNode } from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  icon: ReactNode;
  trend?: number;
  target?: string;
  status?: 'healthy' | 'warning' | 'critical';
}

export function MetricCard({
  title,
  value,
  icon,
  trend,
  target,
  status = 'healthy',
}: MetricCardProps) {
  const statusColors = {
    healthy: 'bg-green-100 border-green-500',
    warning: 'bg-yellow-100 border-yellow-500',
    critical: 'bg-red-100 border-red-500',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={`
        p-6 rounded-lg border-l-4 shadow-sm
        ${statusColors[status]}
      `}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <motion.p
            key={String(value)}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            className="text-2xl font-bold text-gray-900"
          >
            {value}
          </motion.p>
          {target && (
            <p className="text-xs text-gray-500">Target: {target}</p>
          )}
        </div>
        <div className="text-gray-400">{icon}</div>
      </div>

      {trend !== undefined && (
        <div className={`mt-2 flex items-center text-sm ${
          trend >= 0 ? 'text-green-600' : 'text-red-600'
        }`}>
          {trend >= 0 ? <ArrowUpIcon /> : <ArrowDownIcon />}
          <span>{Math.abs(trend)}% from last hour</span>
        </div>
      )}
    </motion.div>
  );
}
```

## Deep Dive: Device Management (7 minutes)

### Device Table with Virtualization

```tsx
// routes/devices.tsx
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, useState } from 'react';
import { useDeviceStore } from '../stores/deviceStore';

export function DevicesRoute() {
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { selectedDevices, toggleDevice, clearSelection } = useDeviceStore();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['admin', 'devices', searchQuery],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await fetch(
        `/api/v1/admin/devices?offset=${pageParam}&limit=50&q=${searchQuery}`
      );
      return res.json();
    },
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? pages.length * 50 : undefined,
  });

  const allDevices = data?.pages.flatMap(p => p.devices) || [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allDevices.length + 1 : allDevices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  // Fetch more when scrolling near bottom
  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  if (lastItem && lastItem.index >= allDevices.length - 5 && hasNextPage && !isFetchingNextPage) {
    fetchNextPage();
  }

  return (
    <div className="p-6">
      {/* Search and Filters */}
      <div className="flex gap-4 mb-4">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by token, bundle ID, or device ID..."
        />
        <FilterDropdown />
        {selectedDevices.length > 0 && (
          <BulkActions
            count={selectedDevices.length}
            onClear={clearSelection}
          />
        )}
      </div>

      {/* Device Table */}
      <div
        ref={parentRef}
        className="h-[calc(100vh-200px)] overflow-auto border rounded-lg"
      >
        <table className="w-full">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              <th className="w-12 p-3">
                <Checkbox
                  checked={selectedDevices.length === allDevices.length}
                  onChange={() => /* select all */}
                />
              </th>
              <th className="text-left p-3">Device ID</th>
              <th className="text-left p-3">App Bundle</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Last Seen</th>
              <th className="text-left p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ height: virtualizer.getTotalSize() }}>
              <td colSpan={6} className="relative">
                {items.map((virtualRow) => {
                  const device = allDevices[virtualRow.index];
                  if (!device) {
                    return (
                      <div
                        key="loader"
                        style={{
                          position: 'absolute',
                          top: virtualRow.start,
                          height: virtualRow.size,
                        }}
                        className="flex items-center justify-center w-full"
                      >
                        <Spinner />
                      </div>
                    );
                  }

                  return (
                    <DeviceRow
                      key={device.device_id}
                      device={device}
                      style={{
                        position: 'absolute',
                        top: virtualRow.start,
                        height: virtualRow.size,
                      }}
                      isSelected={selectedDevices.includes(device.device_id)}
                      onToggle={() => toggleDevice(device.device_id)}
                    />
                  );
                })}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

### Device Row Component

```tsx
// components/DeviceRow.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';

interface DeviceRowProps {
  device: Device;
  style: React.CSSProperties;
  isSelected: boolean;
  onToggle: () => void;
}

export function DeviceRow({ device, style, isSelected, onToggle }: DeviceRowProps) {
  const queryClient = useQueryClient();

  const invalidateMutation = useMutation({
    mutationFn: async () => {
      await fetch(`/api/v1/admin/devices/${device.device_id}/invalidate`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'devices'] });
    },
  });

  const sendTestMutation = useMutation({
    mutationFn: async () => {
      await fetch(`/api/v1/admin/devices/${device.device_id}/send-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: {
            aps: { alert: { title: 'Test', body: 'Test notification' } },
          },
        }),
      });
    },
  });

  return (
    <div
      style={style}
      className={`
        flex items-center border-b hover:bg-gray-50
        ${isSelected ? 'bg-blue-50' : ''}
      `}
    >
      <div className="w-12 p-3">
        <Checkbox checked={isSelected} onChange={onToggle} />
      </div>
      <div className="flex-1 p-3 font-mono text-sm truncate">
        {device.device_id}
      </div>
      <div className="w-48 p-3 text-sm">{device.app_bundle_id}</div>
      <div className="w-24 p-3">
        <StatusBadge status={device.is_valid ? 'active' : 'invalid'} />
      </div>
      <div className="w-36 p-3 text-sm text-gray-500">
        {formatDistanceToNow(new Date(device.last_seen), { addSuffix: true })}
      </div>
      <div className="w-32 p-3 flex gap-2">
        <IconButton
          icon={<SendIcon />}
          onClick={() => sendTestMutation.mutate()}
          loading={sendTestMutation.isPending}
          title="Send test notification"
        />
        <IconButton
          icon={<TrashIcon />}
          onClick={() => invalidateMutation.mutate()}
          loading={invalidateMutation.isPending}
          variant="danger"
          title="Invalidate token"
        />
      </div>
    </div>
  );
}
```

### Device Store (Zustand)

```tsx
// stores/deviceStore.ts
import { create } from 'zustand';

interface DeviceStore {
  selectedDevices: string[];
  searchQuery: string;
  filters: {
    status: 'all' | 'active' | 'invalid';
    appBundle: string | null;
  };
  toggleDevice: (deviceId: string) => void;
  selectAll: (deviceIds: string[]) => void;
  clearSelection: () => void;
  setSearchQuery: (query: string) => void;
  setFilter: (key: keyof DeviceStore['filters'], value: any) => void;
}

export const useDeviceStore = create<DeviceStore>((set) => ({
  selectedDevices: [],
  searchQuery: '',
  filters: {
    status: 'all',
    appBundle: null,
  },

  toggleDevice: (deviceId) =>
    set((state) => ({
      selectedDevices: state.selectedDevices.includes(deviceId)
        ? state.selectedDevices.filter((id) => id !== deviceId)
        : [...state.selectedDevices, deviceId],
    })),

  selectAll: (deviceIds) =>
    set({ selectedDevices: deviceIds }),

  clearSelection: () =>
    set({ selectedDevices: [] }),

  setSearchQuery: (query) =>
    set({ searchQuery: query }),

  setFilter: (key, value) =>
    set((state) => ({
      filters: { ...state.filters, [key]: value },
    })),
}));
```

## Deep Dive: Notification Testing Modal (5 minutes)

### Send Test Notification Form

```tsx
// components/SendTestModal.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';

const testNotificationSchema = z.object({
  deviceToken: z.string().min(64).max(64),
  priority: z.enum(['10', '5', '1']),
  collapseId: z.string().optional(),
  payload: z.object({
    aps: z.object({
      alert: z.union([
        z.string(),
        z.object({
          title: z.string().min(1),
          body: z.string().min(1),
        }),
      ]),
      badge: z.number().optional(),
      sound: z.string().optional(),
    }),
  }),
});

type TestNotificationForm = z.infer<typeof testNotificationSchema>;

interface SendTestModalProps {
  deviceToken?: string;
  onClose: () => void;
}

export function SendTestModal({ deviceToken, onClose }: SendTestModalProps) {
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<TestNotificationForm>({
    resolver: zodResolver(testNotificationSchema),
    defaultValues: {
      deviceToken: deviceToken || '',
      priority: '10',
      payload: {
        aps: {
          alert: { title: 'Test Notification', body: 'This is a test.' },
        },
      },
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (data: TestNotificationForm) => {
      const res = await fetch(
        `/api/v1/admin/devices/${data.deviceToken}/send-test`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            priority: parseInt(data.priority),
            collapseId: data.collapseId,
            payload: data.payload,
          }),
        }
      );
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (result) => {
      toast.success(`Notification sent: ${result.notificationId}`);
      onClose();
    },
    onError: (error) => {
      toast.error(`Failed: ${error.message}`);
    },
  });

  // JSON editor for advanced payload editing
  const [showJsonEditor, setShowJsonEditor] = useState(false);
  const payloadValue = watch('payload');

  return (
    <Modal onClose={onClose} title="Send Test Notification">
      <form onSubmit={handleSubmit((data) => sendMutation.mutate(data))}>
        {/* Device Token */}
        <FormField
          label="Device Token"
          error={errors.deviceToken?.message}
        >
          <input
            {...register('deviceToken')}
            className="font-mono text-sm"
            placeholder="64-character hex token"
          />
        </FormField>

        {/* Priority */}
        <FormField label="Priority">
          <select {...register('priority')}>
            <option value="10">10 - Immediate (wake device)</option>
            <option value="5">5 - Background (power nap)</option>
            <option value="1">1 - Low (opportunistic)</option>
          </select>
        </FormField>

        {/* Collapse ID */}
        <FormField label="Collapse ID (optional)">
          <input
            {...register('collapseId')}
            placeholder="e.g., sports-score-12345"
          />
        </FormField>

        {/* Payload Editor */}
        <FormField label="Notification Payload">
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              onClick={() => setShowJsonEditor(false)}
              className={!showJsonEditor ? 'bg-blue-100' : ''}
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => setShowJsonEditor(true)}
              className={showJsonEditor ? 'bg-blue-100' : ''}
            >
              JSON Editor
            </button>
          </div>

          {showJsonEditor ? (
            <JsonEditor
              value={payloadValue}
              onChange={(val) => setValue('payload', val)}
            />
          ) : (
            <div className="space-y-2">
              <input
                placeholder="Title"
                onChange={(e) =>
                  setValue('payload.aps.alert.title', e.target.value)
                }
                defaultValue={
                  typeof payloadValue.aps.alert === 'object'
                    ? payloadValue.aps.alert.title
                    : ''
                }
              />
              <textarea
                placeholder="Body"
                onChange={(e) =>
                  setValue('payload.aps.alert.body', e.target.value)
                }
                defaultValue={
                  typeof payloadValue.aps.alert === 'object'
                    ? payloadValue.aps.alert.body
                    : ''
                }
              />
            </div>
          )}
        </FormField>

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            disabled={sendMutation.isPending}
            className="btn-primary"
          >
            {sendMutation.isPending ? <Spinner /> : 'Send Notification'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
```

## Deep Dive: Delivery Timeline Chart (5 minutes)

### Recharts Timeline Visualization

```tsx
// components/DeliveryChart.tsx
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format } from 'date-fns';

interface TimelineDataPoint {
  timestamp: string;
  delivered: number;
  queued: number;
  failed: number;
  latencyP99: number;
}

interface DeliveryChartProps {
  data: TimelineDataPoint[];
}

export function DeliveryChart({ data }: DeliveryChartProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-semibold mb-4">Delivery Timeline</h3>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 5, right: 30, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={(val) => format(new Date(val), 'HH:mm')}
          />
          <YAxis yAxisId="count" orientation="left" />
          <YAxis yAxisId="latency" orientation="right" unit="ms" />

          <Tooltip
            labelFormatter={(val) => format(new Date(val), 'MMM d, HH:mm:ss')}
            formatter={(value: number, name: string) => {
              if (name === 'latencyP99') return [`${value}ms`, 'P99 Latency'];
              return [value, name];
            }}
          />

          <Legend />

          {/* SLO Reference Line for latency */}
          <ReferenceLine
            y={500}
            yAxisId="latency"
            stroke="#f97316"
            strokeDasharray="5 5"
            label={{ value: 'SLO: 500ms', position: 'right' }}
          />

          <Line
            yAxisId="count"
            type="monotone"
            dataKey="delivered"
            stroke="#22c55e"
            strokeWidth={2}
            dot={false}
            name="Delivered"
          />
          <Line
            yAxisId="count"
            type="monotone"
            dataKey="queued"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            name="Queued"
          />
          <Line
            yAxisId="count"
            type="monotone"
            dataKey="failed"
            stroke="#ef4444"
            strokeWidth={2}
            dot={false}
            name="Failed"
          />
          <Line
            yAxisId="latency"
            type="monotone"
            dataKey="latencyP99"
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={false}
            name="P99 Latency"
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Quick Stats */}
      <div className="grid grid-cols-4 gap-4 mt-4 pt-4 border-t">
        <QuickStat
          label="Total Delivered"
          value={data.reduce((sum, d) => sum + d.delivered, 0)}
        />
        <QuickStat
          label="Total Queued"
          value={data.reduce((sum, d) => sum + d.queued, 0)}
        />
        <QuickStat
          label="Total Failed"
          value={data.reduce((sum, d) => sum + d.failed, 0)}
          variant="danger"
        />
        <QuickStat
          label="Avg P99"
          value={`${Math.round(
            data.reduce((sum, d) => sum + d.latencyP99, 0) / data.length
          )}ms`}
        />
      </div>
    </div>
  );
}
```

## Deep Dive: Accessibility and Keyboard Navigation (5 minutes)

### Accessible Data Table

```tsx
// components/AccessibleTable.tsx
import { useRef, useCallback } from 'react';

interface AccessibleTableProps<T> {
  data: T[];
  columns: Column<T>[];
  onRowAction?: (row: T, action: string) => void;
  getRowId: (row: T) => string;
}

export function AccessibleTable<T>({
  data,
  columns,
  onRowAction,
  getRowId,
}: AccessibleTableProps<T>) {
  const tableRef = useRef<HTMLTableElement>(null);

  const handleKeyDown = useCallback((
    e: React.KeyboardEvent,
    row: T,
    rowIndex: number
  ) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(rowIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(rowIndex - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onRowAction?.(row, 'select');
        break;
      case 'Delete':
        e.preventDefault();
        onRowAction?.(row, 'delete');
        break;
    }
  }, [onRowAction]);

  const focusRow = (index: number) => {
    const rows = tableRef.current?.querySelectorAll('[role="row"]');
    if (rows && index >= 0 && index < rows.length) {
      (rows[index] as HTMLElement).focus();
    }
  };

  return (
    <table
      ref={tableRef}
      role="grid"
      aria-label="Devices table"
      className="w-full"
    >
      <thead role="rowgroup">
        <tr role="row">
          {columns.map((col) => (
            <th
              key={col.key}
              role="columnheader"
              scope="col"
              aria-sort={col.sortable ? 'none' : undefined}
            >
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {data.map((row, index) => (
          <tr
            key={getRowId(row)}
            role="row"
            tabIndex={0}
            onKeyDown={(e) => handleKeyDown(e, row, index)}
            aria-selected={false}
          >
            {columns.map((col) => (
              <td key={col.key} role="gridcell">
                {col.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Skip Navigation and Focus Management

```tsx
// components/Layout.tsx
export function AdminLayout({ children }: { children: ReactNode }) {
  const mainRef = useRef<HTMLElement>(null);

  return (
    <div>
      {/* Skip Navigation */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 bg-blue-600 text-white px-4 py-2 rounded"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>

      <header role="banner">
        <nav aria-label="Main navigation">
          <NavLink to="/">Dashboard</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/topics">Topics</NavLink>
          <NavLink to="/feedback">Feedback</NavLink>
        </nav>
      </header>

      <main
        id="main-content"
        ref={mainRef}
        tabIndex={-1}
        role="main"
        className="outline-none"
      >
        {children}
      </main>

      {/* Live Region for Announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="announcements"
      />
    </div>
  );
}

// Announce messages to screen readers
export function announce(message: string) {
  const el = document.getElementById('announcements');
  if (el) {
    el.textContent = message;
    // Clear after announcement
    setTimeout(() => { el.textContent = ''; }, 1000);
  }
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Frontend Rationale |
|----------|--------|-------------|---------------------|
| Real-time updates | WebSocket | Polling | Lower latency, reduced server load |
| Large data display | Virtual scrolling | Pagination | Better UX for browsing devices |
| State management | TanStack Query + Zustand | Redux | Query handles server state, Zustand for UI |
| Charts | Recharts | D3 | Declarative React API, good defaults |
| Form validation | Zod + react-hook-form | Formik | Type inference, smaller bundle |
| Styling | Tailwind CSS | CSS Modules | Rapid iteration, consistent design system |

## Future Frontend Enhancements

1. **Advanced Visualization**
   - Geographic heat map of device connections
   - Real-time delivery flow animation
   - Topic subscription network graph

2. **Developer Experience**
   - Notification payload builder with preview
   - API explorer with cURL export
   - WebSocket connection debugger

3. **Performance**
   - Service Worker for offline dashboard access
   - Optimistic updates for admin actions
   - Background sync for batch operations

4. **Accessibility**
   - Screen reader announcements for real-time updates
   - High contrast theme
   - Reduced motion support
