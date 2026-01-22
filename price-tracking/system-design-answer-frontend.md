# Price Tracking Service - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The frontend challenge is building an intuitive dashboard with interactive price charts, responsive design, and a browser extension for quick product tracking.

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Product Tracking**: Users add products from various e-commerce sites
- **Price History Charts**: Interactive visualizations of price trends
- **Alert Management**: Configure and manage price alerts
- **Product Dashboard**: View all tracked products with current prices
- **Browser Extension**: Quick add products while browsing

### UI/UX Requirements
- Responsive design for desktop and mobile
- Interactive charts with zoom, tooltips, and range selection
- Real-time price update indicators
- Intuitive alert configuration
- Fast initial load and smooth interactions

### Non-Functional Requirements
- Dashboard loads in under 2 seconds
- Charts render smoothly with 1000+ data points
- Offline-capable for viewing cached data
- Accessible (WCAG 2.1 AA compliance)

## High-Level Architecture (5 minutes)

```
┌────────────────────────────────────────────────────────────────────────┐
│                         React Frontend                                  │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │   Product List   │  │  Price Chart     │  │   Alert Manager      │ │
│  │   with Virtual   │  │  (Recharts)      │  │   (Modal Forms)      │ │
│  │   Scrolling      │  │                  │  │                      │ │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘ │
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │   Add Product    │  │  Product Detail  │  │   Admin Dashboard    │ │
│  │   Form           │  │  View            │  │   (Stats/Config)     │ │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘ │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                      Zustand Store                                │ │
│  │   - auth state    - products    - alerts    - ui preferences     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ REST API
                                    ▼
                        ┌───────────────────────┐
                        │    Express Backend    │
                        └───────────────────────┘
```

## Deep Dive 1: Price History Charts (8 minutes)

### Chart Requirements

- Display price history over configurable time ranges (7d, 30d, 90d, 1y, all)
- Show min, max, average prices in the selected range
- Interactive tooltips on hover
- Zoom and pan capabilities
- Highlight price drops/increases
- Responsive sizing

### Recharts Implementation

```typescript
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Brush } from 'recharts';

interface PriceChartProps {
  data: PricePoint[];
  targetPrice?: number;
  currency: string;
}

export function PriceChart({ data, targetPrice, currency }: PriceChartProps) {
  const [range, setRange] = useState<'7d' | '30d' | '90d' | '1y' | 'all'>('30d');

  const filteredData = useMemo(() => {
    return filterByRange(data, range);
  }, [data, range]);

  const { minPrice, maxPrice, avgPrice } = useMemo(() => ({
    minPrice: Math.min(...filteredData.map(d => d.price)),
    maxPrice: Math.max(...filteredData.map(d => d.price)),
    avgPrice: filteredData.reduce((sum, d) => sum + d.price, 0) / filteredData.length,
  }), [filteredData]);

  return (
    <div className="price-chart">
      {/* Range selector */}
      <div className="flex gap-2 mb-4">
        {['7d', '30d', '90d', '1y', 'all'].map((r) => (
          <button
            key={r}
            onClick={() => setRange(r as typeof range)}
            className={`px-3 py-1 rounded ${range === r ? 'bg-blue-500 text-white' : 'bg-gray-100'}`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Price statistics */}
      <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
        <div className="text-center">
          <div className="text-gray-500">Lowest</div>
          <div className="text-green-600 font-semibold">{formatPrice(minPrice, currency)}</div>
        </div>
        <div className="text-center">
          <div className="text-gray-500">Average</div>
          <div className="font-semibold">{formatPrice(avgPrice, currency)}</div>
        </div>
        <div className="text-center">
          <div className="text-gray-500">Highest</div>
          <div className="text-red-600 font-semibold">{formatPrice(maxPrice, currency)}</div>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={filteredData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <XAxis
            dataKey="date"
            tickFormatter={(date) => formatDate(date, range)}
            tick={{ fontSize: 12 }}
          />
          <YAxis
            domain={['dataMin - 5', 'dataMax + 5']}
            tickFormatter={(value) => formatPrice(value, currency)}
            tick={{ fontSize: 12 }}
            width={80}
          />
          <Tooltip
            content={<CustomTooltip currency={currency} />}
          />

          {/* Target price reference line */}
          {targetPrice && (
            <ReferenceLine
              y={targetPrice}
              stroke="#22c55e"
              strokeDasharray="5 5"
              label={{ value: `Target: ${formatPrice(targetPrice, currency)}`, position: 'right' }}
            />
          )}

          <Line
            type="monotone"
            dataKey="price"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, stroke: '#3b82f6', strokeWidth: 2, fill: 'white' }}
          />

          {/* Brush for zooming */}
          <Brush
            dataKey="date"
            height={30}
            stroke="#8884d8"
            tickFormatter={(date) => formatDate(date, 'short')}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CustomTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null;

  const point = payload[0].payload;

  return (
    <div className="bg-white border rounded shadow-lg p-3">
      <div className="text-sm text-gray-500">{formatDate(label, 'full')}</div>
      <div className="text-lg font-semibold">{formatPrice(point.price, currency)}</div>
      {point.priceChange && (
        <div className={point.priceChange > 0 ? 'text-red-500' : 'text-green-500'}>
          {point.priceChange > 0 ? '+' : ''}{point.priceChange.toFixed(2)}%
        </div>
      )}
    </div>
  );
}
```

### Chart Performance Optimization

```typescript
// Downsample data for large datasets
function downsampleData(data: PricePoint[], maxPoints: number): PricePoint[] {
  if (data.length <= maxPoints) return data;

  const step = Math.ceil(data.length / maxPoints);
  const result: PricePoint[] = [];

  for (let i = 0; i < data.length; i += step) {
    // Take the point with the most significant price change in each bucket
    const bucket = data.slice(i, i + step);
    const significantPoint = bucket.reduce((max, point) =>
      Math.abs(point.priceChange ?? 0) > Math.abs(max.priceChange ?? 0) ? point : max
    );
    result.push(significantPoint);
  }

  // Always include first and last points
  if (result[0] !== data[0]) result.unshift(data[0]);
  if (result[result.length - 1] !== data[data.length - 1]) result.push(data[data.length - 1]);

  return result;
}
```

## Deep Dive 2: Product Dashboard with Virtual Scrolling (6 minutes)

### Product List Component

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

interface ProductListProps {
  products: Product[];
  onSelect: (product: Product) => void;
}

export function ProductList({ products, onSelect }: ProductListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: products.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120, // Estimated row height
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const product = products[virtualRow.index];
          return (
            <div
              key={product.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ProductCard product={product} onClick={() => onSelect(product)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProductCard({ product, onClick }: { product: Product; onClick: () => void }) {
  const priceChange = calculatePriceChange(product);

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-4 p-4 border-b hover:bg-gray-50 cursor-pointer"
    >
      {/* Product image */}
      <img
        src={product.imageUrl || '/placeholder.png'}
        alt={product.title}
        className="w-16 h-16 object-cover rounded"
        loading="lazy"
      />

      {/* Product info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-medium truncate">{product.title}</h3>
        <div className="text-sm text-gray-500">{product.domain}</div>
        <div className="text-xs text-gray-400">
          Last updated: {formatRelativeTime(product.lastScraped)}
        </div>
      </div>

      {/* Price info */}
      <div className="text-right">
        <div className="text-lg font-semibold">
          {formatPrice(product.currentPrice, product.currency)}
        </div>
        {priceChange !== null && (
          <div className={`text-sm ${priceChange < 0 ? 'text-green-500' : 'text-red-500'}`}>
            {priceChange > 0 ? '+' : ''}{priceChange.toFixed(1)}%
          </div>
        )}
      </div>

      {/* Alert indicator */}
      {product.hasAlert && (
        <div className="w-3 h-3 rounded-full bg-blue-500" title="Alert active" />
      )}
    </div>
  );
}
```

## Deep Dive 3: Alert Management UI (6 minutes)

### Alert Configuration Modal

```typescript
import { useState } from 'react';
import { z } from 'zod';

const alertSchema = z.object({
  targetPrice: z.number().positive().max(1000000),
  alertType: z.enum(['below', 'above', 'change_pct']),
  notifyAnyDrop: z.boolean(),
});

interface AlertModalProps {
  product: Product;
  existingAlert?: Alert;
  isOpen: boolean;
  onClose: () => void;
  onSave: (alert: AlertFormData) => Promise<void>;
}

export function AlertModal({ product, existingAlert, isOpen, onClose, onSave }: AlertModalProps) {
  const [targetPrice, setTargetPrice] = useState(existingAlert?.targetPrice ?? '');
  const [alertType, setAlertType] = useState<'below' | 'above' | 'change_pct'>(
    existingAlert?.alertType ?? 'below'
  );
  const [notifyAnyDrop, setNotifyAnyDrop] = useState(existingAlert?.notifyAnyDrop ?? false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      const data = alertSchema.parse({
        targetPrice: parseFloat(targetPrice as string),
        alertType,
        notifyAnyDrop,
      });

      setIsLoading(true);
      await onSave(data);
      onClose();
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.errors[0].message);
      } else {
        setError('Failed to save alert');
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h2 className="text-xl font-semibold mb-4">Set Price Alert</h2>

        {/* Current price reference */}
        <div className="mb-4 p-3 bg-gray-50 rounded">
          <div className="text-sm text-gray-500">Current price</div>
          <div className="text-lg font-semibold">
            {formatPrice(product.currentPrice, product.currency)}
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          {/* Alert type */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">Alert when price is</label>
            <div className="flex gap-2">
              {[
                { value: 'below', label: 'Below' },
                { value: 'above', label: 'Above' },
                { value: 'change_pct', label: 'Changes by %' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAlertType(option.value as typeof alertType)}
                  className={`flex-1 py-2 rounded border ${
                    alertType === option.value
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'border-gray-300'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Target price input */}
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              {alertType === 'change_pct' ? 'Change percentage' : 'Target price'}
            </label>
            <div className="relative">
              {alertType !== 'change_pct' && (
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
                  {product.currency === 'USD' ? '$' : product.currency}
                </span>
              )}
              <input
                type="number"
                step="0.01"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
                className={`w-full border rounded-lg py-2 ${
                  alertType !== 'change_pct' ? 'pl-8' : 'pl-3'
                } pr-3`}
                placeholder={alertType === 'change_pct' ? '10' : '29.99'}
              />
              {alertType === 'change_pct' && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>
              )}
            </div>
          </div>

          {/* Quick set buttons */}
          {alertType === 'below' && (
            <div className="mb-4 flex gap-2">
              {[0.1, 0.2, 0.3].map((discount) => (
                <button
                  key={discount}
                  type="button"
                  onClick={() =>
                    setTargetPrice((product.currentPrice * (1 - discount)).toFixed(2))
                  }
                  className="flex-1 py-1 text-sm border rounded hover:bg-gray-50"
                >
                  -{discount * 100}%
                </button>
              ))}
            </div>
          )}

          {/* Notify on any drop */}
          <div className="mb-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={notifyAnyDrop}
                onChange={(e) => setNotifyAnyDrop(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Also notify me on any price drop</span>
            </label>
          </div>

          {error && (
            <div className="mb-4 text-red-500 text-sm">{error}</div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50"
            >
              {isLoading ? 'Saving...' : existingAlert ? 'Update Alert' : 'Create Alert'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

## Deep Dive 4: Add Product Form (5 minutes)

### URL Input with Validation

```typescript
import { useState } from 'react';
import { useStore } from '../stores/priceStore';

const SUPPORTED_DOMAINS = ['amazon.com', 'walmart.com', 'bestbuy.com', 'target.com', 'ebay.com'];

export function AddProductForm() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addProduct = useStore((s) => s.addProduct);

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace('www.', '');
      return SUPPORTED_DOMAINS.some((d) => domain.includes(d));
    } catch {
      return false;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!validateUrl(url)) {
      setError('Please enter a URL from a supported retailer');
      return;
    }

    try {
      setIsLoading(true);
      await addProduct(url);
      setUrl('');
    } catch (err) {
      setError('Failed to add product. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const domain = (() => {
    try {
      return new URL(url).hostname.replace('www.', '');
    } catch {
      return null;
    }
  })();

  const isSupported = domain && SUPPORTED_DOMAINS.some((d) => domain.includes(d));

  return (
    <form onSubmit={handleSubmit} className="mb-6">
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste product URL from Amazon, Walmart, Best Buy..."
            className="w-full px-4 py-3 border rounded-lg pr-10"
            required
          />
          {domain && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {isSupported ? (
                <CheckIcon className="w-5 h-5 text-green-500" />
              ) : (
                <XIcon className="w-5 h-5 text-red-500" />
              )}
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={isLoading || !isSupported}
          className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Spinner className="w-5 h-5" />
          ) : (
            'Track Price'
          )}
        </button>
      </div>

      {error && <div className="mt-2 text-red-500 text-sm">{error}</div>}

      <div className="mt-2 text-sm text-gray-500">
        Supported: {SUPPORTED_DOMAINS.join(', ')}
      </div>
    </form>
  );
}
```

## Deep Dive 5: State Management with Zustand (5 minutes)

### Price Tracking Store

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../services/api';

interface Product {
  id: string;
  url: string;
  domain: string;
  title: string;
  imageUrl: string;
  currentPrice: number;
  currency: string;
  lastScraped: string;
  hasAlert: boolean;
}

interface Alert {
  id: string;
  productId: string;
  targetPrice: number;
  alertType: 'below' | 'above' | 'change_pct';
  notifyAnyDrop: boolean;
  isActive: boolean;
}

interface PriceStore {
  // State
  products: Product[];
  alerts: Alert[];
  selectedProduct: Product | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchProducts: () => Promise<void>;
  addProduct: (url: string) => Promise<void>;
  removeProduct: (id: string) => Promise<void>;
  selectProduct: (product: Product | null) => void;

  fetchAlerts: () => Promise<void>;
  createAlert: (productId: string, data: AlertFormData) => Promise<void>;
  updateAlert: (id: string, data: Partial<AlertFormData>) => Promise<void>;
  deleteAlert: (id: string) => Promise<void>;
}

export const useStore = create<PriceStore>()(
  persist(
    (set, get) => ({
      products: [],
      alerts: [],
      selectedProduct: null,
      isLoading: false,
      error: null,

      fetchProducts: async () => {
        set({ isLoading: true, error: null });
        try {
          const products = await api.get('/products');
          set({ products, isLoading: false });
        } catch (error) {
          set({ error: 'Failed to fetch products', isLoading: false });
        }
      },

      addProduct: async (url) => {
        set({ isLoading: true, error: null });
        try {
          const product = await api.post('/products', { url });
          set((state) => ({
            products: [product, ...state.products],
            isLoading: false,
          }));
        } catch (error) {
          set({ error: 'Failed to add product', isLoading: false });
          throw error;
        }
      },

      removeProduct: async (id) => {
        const previousProducts = get().products;
        // Optimistic update
        set((state) => ({
          products: state.products.filter((p) => p.id !== id),
        }));

        try {
          await api.delete(`/products/${id}`);
        } catch (error) {
          // Rollback on failure
          set({ products: previousProducts, error: 'Failed to remove product' });
          throw error;
        }
      },

      selectProduct: (product) => {
        set({ selectedProduct: product });
      },

      fetchAlerts: async () => {
        const alerts = await api.get('/alerts');
        set({ alerts });
      },

      createAlert: async (productId, data) => {
        const alert = await api.post('/alerts', { productId, ...data });
        set((state) => ({
          alerts: [...state.alerts, alert],
          products: state.products.map((p) =>
            p.id === productId ? { ...p, hasAlert: true } : p
          ),
        }));
      },

      updateAlert: async (id, data) => {
        const alert = await api.patch(`/alerts/${id}`, data);
        set((state) => ({
          alerts: state.alerts.map((a) => (a.id === id ? alert : a)),
        }));
      },

      deleteAlert: async (id) => {
        const alertToDelete = get().alerts.find((a) => a.id === id);
        await api.delete(`/alerts/${id}`);

        set((state) => {
          const newAlerts = state.alerts.filter((a) => a.id !== id);
          const productStillHasAlert = newAlerts.some(
            (a) => a.productId === alertToDelete?.productId
          );

          return {
            alerts: newAlerts,
            products: state.products.map((p) =>
              p.id === alertToDelete?.productId
                ? { ...p, hasAlert: productStillHasAlert }
                : p
            ),
          };
        });
      },
    }),
    {
      name: 'price-tracking-store',
      partialize: (state) => ({
        // Only persist user preferences, not data
        selectedProduct: state.selectedProduct,
      }),
    }
  )
);
```

## Deep Dive 6: Responsive Design (4 minutes)

### Responsive Layout

```typescript
export function Dashboard() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Add product form */}
        <AddProductForm />

        {/* Responsive grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Product list - full width on mobile, 1/3 on desktop */}
          <div className="lg:col-span-1 bg-white rounded-lg shadow">
            <ProductList />
          </div>

          {/* Product detail and chart - hidden on mobile until selected */}
          <div className="lg:col-span-2 space-y-6">
            {/* On mobile, this shows as a modal when product selected */}
            <ProductDetailPanel />
          </div>
        </div>
      </main>
    </div>
  );
}

// Mobile: full-screen modal for product details
function ProductDetailPanel() {
  const selectedProduct = useStore((s) => s.selectedProduct);
  const selectProduct = useStore((s) => s.selectProduct);
  const isMobile = useMediaQuery('(max-width: 1023px)');

  if (!selectedProduct) {
    return (
      <div className="hidden lg:flex items-center justify-center h-96 bg-white rounded-lg shadow">
        <p className="text-gray-500">Select a product to view details</p>
      </div>
    );
  }

  const content = (
    <>
      <div className="bg-white rounded-lg shadow p-6">
        <ProductHeader product={selectedProduct} />
        <PriceChart productId={selectedProduct.id} />
      </div>
      <div className="bg-white rounded-lg shadow p-6">
        <AlertSection product={selectedProduct} />
      </div>
    </>
  );

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 bg-white overflow-auto">
        <div className="sticky top-0 bg-white border-b p-4 flex items-center">
          <button onClick={() => selectProduct(null)} className="mr-4">
            <ArrowLeftIcon className="w-6 h-6" />
          </button>
          <h2 className="font-semibold truncate">{selectedProduct.title}</h2>
        </div>
        <div className="p-4 space-y-4">{content}</div>
      </div>
    );
  }

  return content;
}
```

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Charts | Recharts | D3, Chart.js | React-native, good time-series support |
| State | Zustand | Redux, Context | Simple API, good TypeScript support |
| List Rendering | TanStack Virtual | react-window | Better API, active maintenance |
| Styling | Tailwind CSS | CSS Modules | Rapid development, consistent design |
| Data Fetching | Custom hooks | TanStack Query | Simpler for this use case |
| Routing | TanStack Router | React Router | Type-safe routes |

## Future Frontend Enhancements

1. **Browser Extension**: Quick add while browsing e-commerce sites
2. **WebSocket Updates**: Real-time price change notifications
3. **Progressive Web App**: Offline viewing of tracked products
4. **Comparison View**: Compare price history of multiple products
5. **Export/Share**: Export price history data, share tracking lists
6. **Dark Mode**: Theme toggle with system preference detection
7. **Accessibility Audit**: Full WCAG 2.1 AA compliance
