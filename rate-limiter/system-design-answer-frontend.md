# Rate Limiter - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a rate limiter dashboard that allows developers to configure rate limiting rules, visualize usage metrics, and test their API limits interactively. As a frontend engineer, I'll focus on the dashboard UI, real-time metrics visualization, interactive testing interface, and responsive design. Let me clarify the requirements."

---

## 1. Requirements Clarification (4 minutes)

### Functional Requirements

1. **Algorithm Visualization** - Interactive demo of all 5 rate limiting algorithms
2. **Metrics Dashboard** - Real-time charts showing allowed/denied requests
3. **Testing Interface** - Send test requests and observe rate limiting behavior
4. **Configuration Panel** - Set limits, window sizes, burst capacity
5. **Response Headers Display** - Show X-RateLimit-* headers in real-time

### Non-Functional Requirements

- **Real-time Updates** - Metrics refresh within 1 second
- **Responsive Design** - Work on desktop and tablet
- **Performance** - Handle 1000+ data points in charts smoothly
- **Accessibility** - Keyboard navigation, screen reader support

### Frontend-Specific Considerations

- State management for complex form state and API responses
- Chart library selection for time-series visualization
- WebSocket vs polling for real-time updates
- Error handling and loading states

---

## 2. High-Level Architecture (5 minutes)

```
+------------------------------------------------------------------+
|                         React Application                         |
+------------------------------------------------------------------+
|                                                                    |
|  +------------------+  +------------------+  +------------------+  |
|  | Algorithm Panel  |  |  Metrics Charts  |  |  Request Tester  |  |
|  | - Algorithm pick |  |  - Line chart    |  |  - Send requests |  |
|  | - Configuration  |  |  - Success/deny  |  |  - View headers  |  |
|  | - Visual demo    |  |  - Latency hist  |  |  - Batch test    |  |
|  +--------+---------+  +--------+---------+  +--------+---------+  |
|           |                     |                     |            |
|           +---------------------+---------------------+            |
|                                 |                                  |
|                    +------------v------------+                     |
|                    |     Zustand Store       |                     |
|                    |  - selectedAlgorithm    |                     |
|                    |  - config (limit, win)  |                     |
|                    |  - metrics[]            |                     |
|                    |  - testResults[]        |                     |
|                    +------------+------------+                     |
|                                 |                                  |
|                    +------------v------------+                     |
|                    |    API Service Layer    |                     |
|                    |  - fetchMetrics()       |                     |
|                    |  - testRateLimit()      |                     |
|                    |  - batchTest()          |                     |
|                    +-------------------------+                     |
|                                                                    |
+------------------------------------------------------------------+
                                 |
                                 v
                    +------------------------+
                    |    Backend API         |
                    |    /api/ratelimit/*    |
                    +------------------------+
```

---

## 3. Deep Dive: Zustand State Management (8 minutes)

### Store Definition

```typescript
interface Algorithm {
  id: 'fixed' | 'sliding' | 'sliding_log' | 'token' | 'leaky';
  name: string;
  description: string;
  configFields: ConfigField[];
}

interface ConfigField {
  name: string;
  type: 'number' | 'select';
  label: string;
  default: number;
  min?: number;
  max?: number;
}

interface TestResult {
  id: string;
  timestamp: number;
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: number;
  latencyMs: number;
}

interface MetricPoint {
  timestamp: number;
  allowed: number;
  denied: number;
  p50Latency: number;
  p99Latency: number;
}

interface RateLimiterState {
  // Algorithm selection
  selectedAlgorithm: Algorithm['id'];
  algorithms: Algorithm[];

  // Configuration
  config: {
    identifier: string;
    limit: number;
    windowSeconds: number;
    burstCapacity: number;
    refillRate: number;
    leakRate: number;
  };

  // Test results
  testResults: TestResult[];
  isTestRunning: boolean;

  // Metrics
  metrics: MetricPoint[];
  metricsLoading: boolean;

  // Connection state
  isConnected: boolean;

  // Actions
  setAlgorithm: (id: Algorithm['id']) => void;
  updateConfig: (partial: Partial<RateLimiterState['config']>) => void;
  runTest: () => Promise<void>;
  runBatchTest: (count: number, intervalMs: number) => Promise<void>;
  clearResults: () => void;
  fetchMetrics: () => Promise<void>;
}

export const useRateLimiterStore = create<RateLimiterState>((set, get) => ({
  // Initial state
  selectedAlgorithm: 'sliding',
  algorithms: [
    {
      id: 'fixed',
      name: 'Fixed Window',
      description: 'Simple counter that resets at fixed intervals',
      configFields: [
        { name: 'limit', type: 'number', label: 'Requests per window', default: 10, min: 1 },
        { name: 'windowSeconds', type: 'number', label: 'Window (seconds)', default: 60, min: 1 }
      ]
    },
    {
      id: 'sliding',
      name: 'Sliding Window',
      description: 'Weighted average of current and previous window',
      configFields: [
        { name: 'limit', type: 'number', label: 'Requests per window', default: 10, min: 1 },
        { name: 'windowSeconds', type: 'number', label: 'Window (seconds)', default: 60, min: 1 }
      ]
    },
    {
      id: 'token',
      name: 'Token Bucket',
      description: 'Tokens refill over time, requests consume tokens',
      configFields: [
        { name: 'burstCapacity', type: 'number', label: 'Bucket capacity', default: 10, min: 1 },
        { name: 'refillRate', type: 'number', label: 'Tokens per second', default: 1, min: 0.1 }
      ]
    },
    {
      id: 'leaky',
      name: 'Leaky Bucket',
      description: 'Requests queue and drain at fixed rate',
      configFields: [
        { name: 'burstCapacity', type: 'number', label: 'Queue size', default: 10, min: 1 },
        { name: 'leakRate', type: 'number', label: 'Requests per second', default: 1, min: 0.1 }
      ]
    }
  ],

  config: {
    identifier: 'test-user',
    limit: 10,
    windowSeconds: 60,
    burstCapacity: 10,
    refillRate: 1,
    leakRate: 1
  },

  testResults: [],
  isTestRunning: false,
  metrics: [],
  metricsLoading: false,
  isConnected: true,

  // Actions
  setAlgorithm: (id) => set({ selectedAlgorithm: id }),

  updateConfig: (partial) => set((state) => ({
    config: { ...state.config, ...partial }
  })),

  runTest: async () => {
    const { selectedAlgorithm, config } = get();

    const start = performance.now();
    const response = await fetch('/api/ratelimit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: config.identifier,
        algorithm: selectedAlgorithm,
        ...config
      })
    });

    const latencyMs = performance.now() - start;
    const data = await response.json();

    const result: TestResult = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      allowed: data.allowed,
      remaining: data.remaining,
      limit: config.limit || config.burstCapacity,
      resetAt: data.resetAt,
      latencyMs
    };

    set((state) => ({
      testResults: [result, ...state.testResults].slice(0, 100)
    }));
  },

  runBatchTest: async (count, intervalMs) => {
    set({ isTestRunning: true });

    for (let i = 0; i < count; i++) {
      await get().runTest();
      if (i < count - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    set({ isTestRunning: false });
  },

  clearResults: () => set({ testResults: [] }),

  fetchMetrics: async () => {
    set({ metricsLoading: true });
    try {
      const response = await fetch('/api/metrics');
      const data = await response.json();
      set({ metrics: data.points, metricsLoading: false });
    } catch {
      set({ metricsLoading: false });
    }
  }
}));
```

---

## 4. Deep Dive: Algorithm Visualization Panel (8 minutes)

### Algorithm Selector Component

```tsx
function AlgorithmPanel() {
  const { algorithms, selectedAlgorithm, setAlgorithm, config, updateConfig } =
    useRateLimiterStore();

  const currentAlgorithm = algorithms.find(a => a.id === selectedAlgorithm)!;

  return (
    <div className="space-y-6">
      {/* Algorithm Selection */}
      <div className="grid grid-cols-2 gap-3">
        {algorithms.map(algo => (
          <button
            key={algo.id}
            onClick={() => setAlgorithm(algo.id)}
            className={`
              p-4 rounded-lg border-2 text-left transition-all
              ${selectedAlgorithm === algo.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300'}
            `}
          >
            <div className="font-semibold">{algo.name}</div>
            <div className="text-sm text-gray-500">{algo.description}</div>
          </button>
        ))}
      </div>

      {/* Configuration Fields */}
      <div className="space-y-4">
        <h3 className="font-semibold">Configuration</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Identifier
            </label>
            <input
              type="text"
              value={config.identifier}
              onChange={(e) => updateConfig({ identifier: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>

          {currentAlgorithm.configFields.map(field => (
            <div key={field.name}>
              <label className="block text-sm text-gray-600 mb-1">
                {field.label}
              </label>
              <input
                type="number"
                value={config[field.name as keyof typeof config] as number}
                onChange={(e) => updateConfig({
                  [field.name]: parseFloat(e.target.value)
                })}
                min={field.min}
                max={field.max}
                step={field.type === 'number' && field.min === 0.1 ? 0.1 : 1}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Algorithm Visualization */}
      <AlgorithmVisualization algorithm={selectedAlgorithm} config={config} />
    </div>
  );
}
```

### Algorithm Visualization Component

```tsx
function AlgorithmVisualization({
  algorithm,
  config
}: {
  algorithm: Algorithm['id'];
  config: RateLimiterState['config'];
}) {
  const [animationState, setAnimationState] = useState({
    tokens: config.burstCapacity,
    water: 0,
    windowCount: 0
  });

  // Animate token refill or water leak
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationState(prev => {
        if (algorithm === 'token') {
          return {
            ...prev,
            tokens: Math.min(config.burstCapacity, prev.tokens + config.refillRate * 0.1)
          };
        } else if (algorithm === 'leaky') {
          return {
            ...prev,
            water: Math.max(0, prev.water - config.leakRate * 0.1)
          };
        }
        return prev;
      });
    }, 100);

    return () => clearInterval(interval);
  }, [algorithm, config]);

  if (algorithm === 'token') {
    return (
      <div className="p-4 bg-gray-50 rounded-lg">
        <div className="text-sm font-medium mb-2">Token Bucket</div>
        <div className="flex items-end gap-1 h-20">
          {Array.from({ length: config.burstCapacity }).map((_, i) => (
            <div
              key={i}
              className={`
                flex-1 rounded-t transition-all duration-200
                ${i < Math.floor(animationState.tokens)
                  ? 'bg-green-500 h-full'
                  : 'bg-gray-200 h-full'}
              `}
            />
          ))}
        </div>
        <div className="text-center mt-2 text-sm text-gray-600">
          {Math.floor(animationState.tokens)} / {config.burstCapacity} tokens
        </div>
      </div>
    );
  }

  if (algorithm === 'leaky') {
    const waterPercent = (animationState.water / config.burstCapacity) * 100;

    return (
      <div className="p-4 bg-gray-50 rounded-lg">
        <div className="text-sm font-medium mb-2">Leaky Bucket</div>
        <div className="relative h-24 w-16 mx-auto border-2 border-gray-400 rounded-b-lg overflow-hidden">
          <div
            className="absolute bottom-0 left-0 right-0 bg-blue-400 transition-all duration-200"
            style={{ height: `${waterPercent}%` }}
          />
          {/* Leak indicator */}
          <div className="absolute -bottom-2 left-1/2 transform -translate-x-1/2">
            <div className="w-1 h-4 bg-blue-400 animate-pulse" />
          </div>
        </div>
        <div className="text-center mt-4 text-sm text-gray-600">
          {animationState.water.toFixed(1)} / {config.burstCapacity} queued
        </div>
      </div>
    );
  }

  // Fixed/Sliding window visualization
  return (
    <div className="p-4 bg-gray-50 rounded-lg">
      <div className="text-sm font-medium mb-2">
        {algorithm === 'fixed' ? 'Fixed' : 'Sliding'} Window
      </div>
      <div className="relative h-8 bg-gray-200 rounded overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-blue-500 transition-all"
          style={{ width: `${(animationState.windowCount / config.limit) * 100}%` }}
        />
      </div>
      <div className="text-center mt-2 text-sm text-gray-600">
        {animationState.windowCount} / {config.limit} requests in window
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: Metrics Charts (8 minutes)

### Chart Component with Recharts

```tsx
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';

function MetricsDashboard() {
  const { metrics, metricsLoading, fetchMetrics } = useRateLimiterStore();

  // Refresh metrics every 5 seconds
  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const formattedData = metrics.map(point => ({
    ...point,
    time: new Date(point.timestamp).toLocaleTimeString(),
    successRate: point.allowed / (point.allowed + point.denied) * 100
  }));

  return (
    <div className="space-y-6">
      {/* Request Volume Chart */}
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="font-semibold mb-4">Request Volume</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={formattedData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Area
              type="monotone"
              dataKey="allowed"
              stackId="1"
              stroke="#22c55e"
              fill="#22c55e"
              name="Allowed"
            />
            <Area
              type="monotone"
              dataKey="denied"
              stackId="1"
              stroke="#ef4444"
              fill="#ef4444"
              name="Denied"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Latency Chart */}
      <div className="bg-white p-4 rounded-lg shadow">
        <h3 className="font-semibold mb-4">Latency (ms)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={formattedData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="time" />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="p50Latency"
              stroke="#3b82f6"
              name="P50"
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="p99Latency"
              stroke="#f59e0b"
              name="P99"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Success Rate Gauge */}
      <SuccessRateGauge
        rate={formattedData.length > 0
          ? formattedData[formattedData.length - 1].successRate
          : 100}
      />
    </div>
  );
}

function SuccessRateGauge({ rate }: { rate: number }) {
  const color = rate >= 90 ? '#22c55e' : rate >= 70 ? '#f59e0b' : '#ef4444';

  return (
    <div className="bg-white p-4 rounded-lg shadow text-center">
      <h3 className="font-semibold mb-4">Success Rate</h3>
      <div className="relative w-32 h-32 mx-auto">
        <svg className="w-full h-full transform -rotate-90">
          {/* Background circle */}
          <circle
            cx="64"
            cy="64"
            r="56"
            stroke="#e5e7eb"
            strokeWidth="12"
            fill="none"
          />
          {/* Progress circle */}
          <circle
            cx="64"
            cy="64"
            r="56"
            stroke={color}
            strokeWidth="12"
            fill="none"
            strokeDasharray={`${rate * 3.52} 352`}
            strokeLinecap="round"
            className="transition-all duration-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold">{rate.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}
```

---

## 6. Deep Dive: Request Tester (6 minutes)

### Test Interface Component

```tsx
function RequestTester() {
  const { testResults, isTestRunning, runTest, runBatchTest, clearResults } =
    useRateLimiterStore();

  const [batchCount, setBatchCount] = useState(20);
  const [batchInterval, setBatchInterval] = useState(100);

  return (
    <div className="space-y-4">
      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={runTest}
          disabled={isTestRunning}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg
                     hover:bg-blue-600 disabled:opacity-50"
        >
          Send Request
        </button>

        <button
          onClick={() => runBatchTest(batchCount, batchInterval)}
          disabled={isTestRunning}
          className="px-4 py-2 bg-green-500 text-white rounded-lg
                     hover:bg-green-600 disabled:opacity-50"
        >
          {isTestRunning ? 'Running...' : 'Batch Test'}
        </button>

        <button
          onClick={clearResults}
          className="px-4 py-2 border border-gray-300 rounded-lg
                     hover:bg-gray-50"
        >
          Clear
        </button>
      </div>

      {/* Batch Settings */}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          Count:
          <input
            type="number"
            value={batchCount}
            onChange={(e) => setBatchCount(parseInt(e.target.value))}
            className="w-20 px-2 py-1 border rounded"
            min={1}
            max={100}
          />
        </label>
        <label className="flex items-center gap-2">
          Interval (ms):
          <input
            type="number"
            value={batchInterval}
            onChange={(e) => setBatchInterval(parseInt(e.target.value))}
            className="w-20 px-2 py-1 border rounded"
            min={0}
            max={5000}
          />
        </label>
      </div>

      {/* Results List */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {testResults.map(result => (
          <TestResultCard key={result.id} result={result} />
        ))}
      </div>
    </div>
  );
}

function TestResultCard({ result }: { result: TestResult }) {
  return (
    <div
      className={`
        p-3 rounded-lg border-l-4 transition-all
        ${result.allowed
          ? 'bg-green-50 border-green-500'
          : 'bg-red-50 border-red-500'}
      `}
    >
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {result.allowed ? (
            <CheckIcon className="w-5 h-5 text-green-600" />
          ) : (
            <XIcon className="w-5 h-5 text-red-600" />
          )}
          <span className="font-medium">
            {result.allowed ? 'Allowed' : 'Denied'}
          </span>
        </div>
        <span className="text-sm text-gray-500">
          {result.latencyMs.toFixed(1)}ms
        </span>
      </div>

      <div className="mt-2 text-sm text-gray-600 font-mono">
        <div>X-RateLimit-Remaining: {result.remaining}</div>
        <div>X-RateLimit-Limit: {result.limit}</div>
        <div>X-RateLimit-Reset: {new Date(result.resetAt).toLocaleTimeString()}</div>
      </div>
    </div>
  );
}
```

---

## 7. Trade-offs Summary

| Decision | Choice | Trade-off | Alternative |
|----------|--------|-----------|-------------|
| State management | Zustand | Less tooling than Redux | Redux (more ecosystem) |
| Charts | Recharts | Learning curve | Chart.js (simpler) |
| Styling | Tailwind CSS | Utility classes everywhere | CSS Modules (scoped) |
| Updates | Polling (5s) | Not truly real-time | WebSocket (complexity) |
| Animations | CSS transitions | Limited control | Framer Motion (heavier) |

---

## 8. Accessibility Considerations

```tsx
// Keyboard navigation for algorithm selection
function AlgorithmSelector() {
  const [focusIndex, setFocusIndex] = useState(0);
  const algorithms = useRateLimiterStore(s => s.algorithms);

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowRight':
        setFocusIndex((i) => (i + 1) % algorithms.length);
        break;
      case 'ArrowLeft':
        setFocusIndex((i) => (i - 1 + algorithms.length) % algorithms.length);
        break;
      case 'Enter':
      case ' ':
        useRateLimiterStore.getState().setAlgorithm(algorithms[focusIndex].id);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Select rate limiting algorithm"
      onKeyDown={handleKeyDown}
    >
      {algorithms.map((algo, i) => (
        <button
          key={algo.id}
          role="radio"
          aria-checked={focusIndex === i}
          tabIndex={focusIndex === i ? 0 : -1}
        >
          {algo.name}
        </button>
      ))}
    </div>
  );
}
```

---

## 9. Future Enhancements

1. **WebSocket Updates** - Real-time metrics without polling
2. **Dark Mode** - Theme toggle with system preference detection
3. **Export Data** - Download test results as CSV/JSON
4. **Comparison Mode** - Run same test with different algorithms
5. **Mobile App** - React Native version for on-the-go monitoring

---

## Summary

"To summarize, I've designed a rate limiter dashboard with:

1. **Algorithm visualization panel** with interactive animations showing token refill, water leak, and window counters
2. **Zustand state management** for clean, TypeScript-friendly state with minimal boilerplate
3. **Recharts-based metrics** showing request volume, latency percentiles, and success rates
4. **Interactive request tester** with batch testing and real-time header display
5. **Responsive design** with Tailwind CSS working on desktop and tablet
6. **Accessibility support** with keyboard navigation and ARIA attributes

The key insight is that rate limiting concepts can be abstract and confusing. Visual animations of token buckets filling and leaking, combined with immediate feedback from test requests, make the system behavior intuitive and helps developers choose the right algorithm for their use case."
