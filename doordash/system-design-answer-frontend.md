# DoorDash - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Opening Statement

"Today I'll design the frontend architecture for a food delivery platform like DoorDash, which requires building three distinct client applications: a customer ordering app, a restaurant management dashboard, and a driver delivery app. The core frontend challenges are real-time location tracking on maps, live order status updates via WebSocket, responsive design across device sizes, and managing complex UI state for a three-sided marketplace."

---

## Step 1: Requirements Clarification (3 minutes)

### Frontend-Specific Requirements

1. **Customer App**: Browse restaurants, build cart, track orders in real-time
2. **Restaurant Dashboard**: Manage orders, update menu, view analytics
3. **Driver App**: Accept deliveries, navigate routes, update status
4. **Real-Time Updates**: Live order status and driver location on map
5. **Offline Capability**: Driver app must work with intermittent connectivity

### User Experience Goals

| User | Primary Device | Key UX Goals |
|------|----------------|--------------|
| Customer | Mobile (70%) / Desktop (30%) | Fast browsing, easy checkout, live tracking |
| Restaurant | Tablet (80%) / Desktop (20%) | Quick order management, clear notifications |
| Driver | Mobile (100%) | One-handed operation, turn-by-turn navigation |

---

## Step 2: Component Architecture (7 minutes)

### Customer App Component Structure

```
src/
├── components/
│   ├── common/
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Modal.tsx
│   │   ├── LoadingSpinner.tsx
│   │   └── ErrorBoundary.tsx
│   ├── restaurant/
│   │   ├── RestaurantCard.tsx
│   │   ├── RestaurantList.tsx
│   │   ├── RestaurantFilters.tsx
│   │   ├── MenuItemCard.tsx
│   │   └── MenuCategoryTabs.tsx
│   ├── cart/
│   │   ├── CartDrawer.tsx
│   │   ├── CartItem.tsx
│   │   ├── CartSummary.tsx
│   │   └── QuantitySelector.tsx
│   ├── order/
│   │   ├── OrderStatus.tsx
│   │   ├── OrderTimeline.tsx
│   │   ├── OrderCard.tsx
│   │   └── OrderHistory.tsx
│   ├── tracking/
│   │   ├── DeliveryMap.tsx
│   │   ├── DriverMarker.tsx
│   │   ├── ETADisplay.tsx
│   │   └── LiveTrackingPanel.tsx
│   └── icons/
│       ├── index.ts
│       ├── LocationIcon.tsx
│       ├── CartIcon.tsx
│       └── DeliveryIcon.tsx
├── routes/
│   ├── __root.tsx
│   ├── index.tsx              # Home / Restaurant list
│   ├── restaurant.$id.tsx     # Restaurant detail + menu
│   ├── checkout.tsx           # Checkout flow
│   ├── orders/
│   │   ├── index.tsx          # Order history
│   │   └── $orderId.tsx       # Live order tracking
│   └── account.tsx            # User profile
├── stores/
│   ├── authStore.ts
│   ├── cartStore.ts
│   ├── orderStore.ts
│   └── locationStore.ts
└── services/
    ├── api.ts
    ├── websocket.ts
    └── geolocation.ts
```

### Why This Structure?

**Separate by Feature Domain**: Components grouped by feature (restaurant, cart, order, tracking) makes it easy to find related code and enables code splitting per route.

**Shared Common Components**: Reusable UI primitives in `common/` ensure consistent styling and reduce duplication.

**Services Layer**: API calls, WebSocket management, and geolocation abstracted from components for testability.

---

## Step 3: Restaurant Browsing UI (8 minutes)

### Restaurant List with Filters

```tsx
// components/restaurant/RestaurantList.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

interface Restaurant {
  id: number;
  name: string;
  cuisineType: string;
  rating: number;
  prepTimeMinutes: number;
  deliveryFee: number;
  distance: number;
  imageUrl: string;
  isOpen: boolean;
}

export function RestaurantList({ restaurants }: { restaurants: Restaurant[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: restaurants.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180, // Estimated card height
    overscan: 3,
  });

  return (
    <div ref={parentRef} className="h-[calc(100vh-200px)] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const restaurant = restaurants[virtualItem.index];
          return (
            <div
              key={restaurant.id}
              className="absolute top-0 left-0 w-full"
              style={{
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <RestaurantCard restaurant={restaurant} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### Restaurant Card Component

```tsx
// components/restaurant/RestaurantCard.tsx
import { Link } from '@tanstack/react-router';

interface RestaurantCardProps {
  restaurant: Restaurant;
}

export function RestaurantCard({ restaurant }: RestaurantCardProps) {
  return (
    <Link
      to="/restaurant/$id"
      params={{ id: restaurant.id.toString() }}
      className="block p-4"
    >
      <div className="bg-white rounded-xl shadow-sm hover:shadow-md transition-shadow overflow-hidden">
        {/* Image with lazy loading */}
        <div className="relative h-40 bg-gray-100">
          <img
            src={restaurant.imageUrl}
            alt={restaurant.name}
            loading="lazy"
            className="w-full h-full object-cover"
          />
          {!restaurant.isOpen && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
              <span className="text-white font-medium">Currently Closed</span>
            </div>
          )}
        </div>

        {/* Content */}
        <div className="p-4">
          <div className="flex justify-between items-start mb-2">
            <h3 className="font-semibold text-lg text-gray-900 truncate">
              {restaurant.name}
            </h3>
            <div className="flex items-center gap-1 shrink-0">
              <StarIcon className="w-4 h-4 text-yellow-400" />
              <span className="text-sm font-medium">{restaurant.rating.toFixed(1)}</span>
            </div>
          </div>

          <p className="text-sm text-gray-500 mb-3">{restaurant.cuisineType}</p>

          {/* Delivery info */}
          <div className="flex items-center gap-4 text-sm text-gray-600">
            <div className="flex items-center gap-1">
              <ClockIcon className="w-4 h-4" />
              <span>{restaurant.prepTimeMinutes}-{restaurant.prepTimeMinutes + 10} min</span>
            </div>
            <div className="flex items-center gap-1">
              <TruckIcon className="w-4 h-4" />
              <span>${restaurant.deliveryFee.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-1">
              <LocationIcon className="w-4 h-4" />
              <span>{restaurant.distance.toFixed(1)} mi</span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
```

### Filter Bar with Cuisine Types

```tsx
// components/restaurant/RestaurantFilters.tsx
interface FiltersProps {
  cuisines: string[];
  selectedCuisine: string | null;
  sortBy: 'rating' | 'distance' | 'delivery_time';
  onCuisineChange: (cuisine: string | null) => void;
  onSortChange: (sort: 'rating' | 'distance' | 'delivery_time') => void;
}

export function RestaurantFilters({
  cuisines,
  selectedCuisine,
  sortBy,
  onCuisineChange,
  onSortChange,
}: FiltersProps) {
  return (
    <div className="sticky top-0 z-10 bg-white border-b border-gray-200 p-4">
      {/* Cuisine pills - horizontal scroll on mobile */}
      <div className="flex gap-2 overflow-x-auto pb-3 -mx-4 px-4 scrollbar-hide">
        <button
          onClick={() => onCuisineChange(null)}
          className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
            selectedCuisine === null
              ? 'bg-red-500 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          }`}
        >
          All
        </button>
        {cuisines.map((cuisine) => (
          <button
            key={cuisine}
            onClick={() => onCuisineChange(cuisine)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
              selectedCuisine === cuisine
                ? 'bg-red-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {cuisine}
          </button>
        ))}
      </div>

      {/* Sort dropdown */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-500">Sort by:</span>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as typeof sortBy)}
          className="text-sm font-medium text-gray-700 bg-transparent border-none focus:ring-0 cursor-pointer"
        >
          <option value="rating">Top Rated</option>
          <option value="distance">Nearest</option>
          <option value="delivery_time">Fastest Delivery</option>
        </select>
      </div>
    </div>
  );
}
```

---

## Step 4: Shopping Cart with Zustand (7 minutes)

### Cart State Management

```typescript
// stores/cartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CartItem {
  menuItemId: number;
  name: string;
  price: number;
  quantity: number;
  specialInstructions?: string;
}

interface CartState {
  restaurantId: number | null;
  restaurantName: string | null;
  items: CartItem[];
  deliveryAddress: DeliveryAddress | null;

  // Actions
  addItem: (restaurantId: number, restaurantName: string, item: CartItem) => void;
  removeItem: (menuItemId: number) => void;
  updateQuantity: (menuItemId: number, quantity: number) => void;
  updateInstructions: (menuItemId: number, instructions: string) => void;
  setDeliveryAddress: (address: DeliveryAddress) => void;
  clearCart: () => void;

  // Computed
  getSubtotal: () => number;
  getItemCount: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      restaurantId: null,
      restaurantName: null,
      items: [],
      deliveryAddress: null,

      addItem: (restaurantId, restaurantName, item) => {
        const state = get();

        // If adding from different restaurant, clear cart first
        if (state.restaurantId && state.restaurantId !== restaurantId) {
          // Could show confirmation dialog here
          set({
            restaurantId,
            restaurantName,
            items: [item],
          });
          return;
        }

        // Check if item already exists
        const existingIndex = state.items.findIndex(
          (i) => i.menuItemId === item.menuItemId
        );

        if (existingIndex >= 0) {
          const newItems = [...state.items];
          newItems[existingIndex].quantity += item.quantity;
          set({ items: newItems });
        } else {
          set({
            restaurantId,
            restaurantName,
            items: [...state.items, item],
          });
        }
      },

      removeItem: (menuItemId) => {
        const newItems = get().items.filter((i) => i.menuItemId !== menuItemId);
        set({
          items: newItems,
          restaurantId: newItems.length === 0 ? null : get().restaurantId,
          restaurantName: newItems.length === 0 ? null : get().restaurantName,
        });
      },

      updateQuantity: (menuItemId, quantity) => {
        if (quantity <= 0) {
          get().removeItem(menuItemId);
          return;
        }

        set({
          items: get().items.map((i) =>
            i.menuItemId === menuItemId ? { ...i, quantity } : i
          ),
        });
      },

      updateInstructions: (menuItemId, instructions) => {
        set({
          items: get().items.map((i) =>
            i.menuItemId === menuItemId ? { ...i, specialInstructions: instructions } : i
          ),
        });
      },

      setDeliveryAddress: (address) => {
        set({ deliveryAddress: address });
      },

      clearCart: () => {
        set({
          restaurantId: null,
          restaurantName: null,
          items: [],
        });
      },

      getSubtotal: () => {
        return get().items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      },

      getItemCount: () => {
        return get().items.reduce((sum, item) => sum + item.quantity, 0);
      },
    }),
    {
      name: 'doordash-cart',
    }
  )
);
```

### Cart Drawer Component

```tsx
// components/cart/CartDrawer.tsx
import { useCartStore } from '@/stores/cartStore';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CartDrawer({ isOpen, onClose }: CartDrawerProps) {
  const { items, restaurantName, getSubtotal, getItemCount } = useCartStore();
  const navigate = useNavigate();

  const subtotal = getSubtotal();
  const deliveryFee = 2.99;
  const serviceFee = subtotal * 0.15;
  const total = subtotal + deliveryFee + serviceFee;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">Your Cart</h2>
            {restaurantName && (
              <p className="text-sm text-gray-500">{restaurantName}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-full"
            aria-label="Close cart"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Items */}
        <div className="flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="text-center py-12">
              <CartIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">Your cart is empty</p>
            </div>
          ) : (
            <div className="space-y-4">
              {items.map((item) => (
                <CartItem key={item.menuItemId} item={item} />
              ))}
            </div>
          )}
        </div>

        {/* Summary */}
        {items.length > 0 && (
          <div className="border-t p-4 space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Subtotal</span>
                <span>${subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Delivery Fee</span>
                <span>${deliveryFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Service Fee</span>
                <span>${serviceFee.toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-semibold text-base pt-2 border-t">
                <span>Total</span>
                <span>${total.toFixed(2)}</span>
              </div>
            </div>

            <button
              onClick={() => {
                onClose();
                navigate({ to: '/checkout' });
              }}
              className="w-full bg-red-500 text-white py-3 rounded-lg font-semibold hover:bg-red-600 transition-colors"
            >
              Checkout ({getItemCount()} items)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## Step 5: Real-Time Order Tracking (10 minutes)

### WebSocket Connection Manager

```typescript
// services/websocket.ts
type OrderUpdate = {
  orderId: number;
  status: string;
  eta?: string;
  driverLocation?: { lat: number; lon: number };
};

type MessageHandler = (update: OrderUpdate) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<number, MessageHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect(token: string) {
    const wsUrl = `${import.meta.env.VITE_WS_URL}/orders?token=${token}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      const update: OrderUpdate = JSON.parse(event.data);
      const handlers = this.handlers.get(update.orderId) || [];
      handlers.forEach((handler) => handler(update));
    };

    this.ws.onclose = () => {
      this.attemptReconnect(token);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private attemptReconnect(token: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      setTimeout(() => this.connect(token), delay);
    }
  }

  subscribeToOrder(orderId: number, handler: MessageHandler) {
    const handlers = this.handlers.get(orderId) || [];
    handlers.push(handler);
    this.handlers.set(orderId, handlers);

    // Send subscription message
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', orderId }));
    }

    // Return unsubscribe function
    return () => {
      const updatedHandlers = this.handlers.get(orderId)?.filter((h) => h !== handler) || [];
      if (updatedHandlers.length === 0) {
        this.handlers.delete(orderId);
        this.ws?.send(JSON.stringify({ type: 'unsubscribe', orderId }));
      } else {
        this.handlers.set(orderId, updatedHandlers);
      }
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}

export const wsService = new WebSocketService();
```

### Live Tracking Map Component

```tsx
// components/tracking/DeliveryMap.tsx
import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

interface DeliveryMapProps {
  driverLocation: { lat: number; lon: number } | null;
  restaurantLocation: { lat: number; lon: number };
  deliveryLocation: { lat: number; lon: number };
  orderStatus: string;
}

export function DeliveryMap({
  driverLocation,
  restaurantLocation,
  deliveryLocation,
  orderStatus,
}: DeliveryMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const driverMarker = useRef<mapboxgl.Marker | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [deliveryLocation.lon, deliveryLocation.lat],
      zoom: 14,
    });

    // Add restaurant marker
    new mapboxgl.Marker({ color: '#EF4444' })
      .setLngLat([restaurantLocation.lon, restaurantLocation.lat])
      .setPopup(new mapboxgl.Popup().setText('Restaurant'))
      .addTo(map.current);

    // Add delivery location marker
    new mapboxgl.Marker({ color: '#10B981' })
      .setLngLat([deliveryLocation.lon, deliveryLocation.lat])
      .setPopup(new mapboxgl.Popup().setText('Delivery Address'))
      .addTo(map.current);

    // Fit bounds to show all markers
    const bounds = new mapboxgl.LngLatBounds()
      .extend([restaurantLocation.lon, restaurantLocation.lat])
      .extend([deliveryLocation.lon, deliveryLocation.lat]);

    map.current.fitBounds(bounds, { padding: 60 });

    return () => {
      map.current?.remove();
    };
  }, [restaurantLocation, deliveryLocation]);

  // Update driver marker position in real-time
  useEffect(() => {
    if (!map.current || !driverLocation) return;

    if (driverMarker.current) {
      // Animate marker movement
      driverMarker.current.setLngLat([driverLocation.lon, driverLocation.lat]);
    } else {
      // Create driver marker with custom element
      const el = document.createElement('div');
      el.className = 'driver-marker';
      el.innerHTML = `
        <div class="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center shadow-lg">
          <svg class="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 3a.75.75 0 01.75.75v10.638l2.72-2.72a.75.75 0 111.06 1.06l-4 4a.75.75 0 01-1.06 0l-4-4a.75.75 0 011.06-1.06l2.72 2.72V3.75A.75.75 0 0110 3z"/>
          </svg>
        </div>
      `;

      driverMarker.current = new mapboxgl.Marker({ element: el })
        .setLngLat([driverLocation.lon, driverLocation.lat])
        .addTo(map.current);
    }

    // Center map on driver when picked up
    if (orderStatus === 'PICKED_UP') {
      map.current.panTo([driverLocation.lon, driverLocation.lat]);
    }
  }, [driverLocation, orderStatus]);

  return (
    <div className="relative">
      <div ref={mapContainer} className="h-64 md:h-96 rounded-xl overflow-hidden" />

      {/* Legend */}
      <div className="absolute bottom-4 left-4 bg-white rounded-lg shadow-md p-3 text-sm">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <span>Restaurant</span>
        </div>
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span>Your Location</span>
        </div>
        {driverLocation && (
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span>Driver</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Order Status Timeline

```tsx
// components/order/OrderTimeline.tsx
interface OrderTimelineProps {
  status: string;
  timestamps: {
    placedAt?: string;
    confirmedAt?: string;
    preparingAt?: string;
    readyAt?: string;
    pickedUpAt?: string;
    deliveredAt?: string;
  };
}

const STEPS = [
  { status: 'PLACED', label: 'Order Placed', icon: ReceiptIcon },
  { status: 'CONFIRMED', label: 'Confirmed', icon: CheckIcon },
  { status: 'PREPARING', label: 'Preparing', icon: ChefHatIcon },
  { status: 'READY_FOR_PICKUP', label: 'Ready', icon: PackageIcon },
  { status: 'PICKED_UP', label: 'Picked Up', icon: TruckIcon },
  { status: 'DELIVERED', label: 'Delivered', icon: HomeIcon },
];

export function OrderTimeline({ status, timestamps }: OrderTimelineProps) {
  const currentStepIndex = STEPS.findIndex((s) => s.status === status);

  return (
    <div className="py-6">
      <div className="relative">
        {STEPS.map((step, index) => {
          const isComplete = index < currentStepIndex;
          const isCurrent = index === currentStepIndex;
          const Icon = step.icon;

          return (
            <div key={step.status} className="flex items-start mb-6 last:mb-0">
              {/* Connector line */}
              {index < STEPS.length - 1 && (
                <div
                  className={`absolute left-5 w-0.5 h-12 mt-10 ${
                    isComplete ? 'bg-green-500' : 'bg-gray-200'
                  }`}
                  style={{ top: `${index * 72}px` }}
                />
              )}

              {/* Icon */}
              <div
                className={`relative z-10 flex items-center justify-center w-10 h-10 rounded-full ${
                  isComplete
                    ? 'bg-green-500 text-white'
                    : isCurrent
                    ? 'bg-red-500 text-white animate-pulse'
                    : 'bg-gray-200 text-gray-400'
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>

              {/* Label and time */}
              <div className="ml-4">
                <p
                  className={`font-medium ${
                    isComplete || isCurrent ? 'text-gray-900' : 'text-gray-400'
                  }`}
                >
                  {step.label}
                </p>
                {(isComplete || isCurrent) && timestamps[`${step.status.toLowerCase()}At`] && (
                  <p className="text-sm text-gray-500">
                    {formatTime(timestamps[`${step.status.toLowerCase()}At`])}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}
```

### Live Tracking Page

```tsx
// routes/orders/$orderId.tsx
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { wsService } from '@/services/websocket';

export function OrderTrackingPage() {
  const { orderId } = useParams({ from: '/orders/$orderId' });
  const [order, setOrder] = useState<Order | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [eta, setEta] = useState<string | null>(null);

  // Fetch initial order data
  useEffect(() => {
    api.getOrder(parseInt(orderId)).then(setOrder);
  }, [orderId]);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubscribe = wsService.subscribeToOrder(parseInt(orderId), (update) => {
      if (update.status) {
        setOrder((prev) => prev ? { ...prev, status: update.status } : null);
      }
      if (update.driverLocation) {
        setDriverLocation(update.driverLocation);
      }
      if (update.eta) {
        setEta(update.eta);
      }
    });

    return unsubscribe;
  }, [orderId]);

  if (!order) {
    return <LoadingSpinner />;
  }

  return (
    <div className="max-w-2xl mx-auto p-4">
      {/* ETA Header */}
      <div className="bg-red-500 text-white rounded-xl p-6 mb-6">
        <p className="text-sm opacity-90">Estimated Arrival</p>
        <p className="text-3xl font-bold">
          {eta ? formatETA(eta) : 'Calculating...'}
        </p>
        <p className="text-sm mt-2 opacity-90">
          {getStatusMessage(order.status)}
        </p>
      </div>

      {/* Map */}
      {['PICKED_UP', 'READY_FOR_PICKUP'].includes(order.status) && (
        <DeliveryMap
          driverLocation={driverLocation}
          restaurantLocation={order.restaurant.location}
          deliveryLocation={order.deliveryAddress}
          orderStatus={order.status}
        />
      )}

      {/* Timeline */}
      <div className="bg-white rounded-xl shadow-sm p-6 mt-6">
        <h2 className="text-lg font-semibold mb-4">Order Status</h2>
        <OrderTimeline status={order.status} timestamps={order} />
      </div>

      {/* Order details */}
      <div className="bg-white rounded-xl shadow-sm p-6 mt-6">
        <h2 className="text-lg font-semibold mb-4">Order Details</h2>
        <p className="text-gray-600 mb-2">{order.restaurant.name}</p>
        {order.items.map((item) => (
          <div key={item.id} className="flex justify-between py-2 border-b last:border-0">
            <span>{item.quantity}x {item.name}</span>
            <span>${(item.price * item.quantity).toFixed(2)}</span>
          </div>
        ))}
      </div>

      {/* Contact driver button */}
      {order.driver && ['PICKED_UP', 'READY_FOR_PICKUP'].includes(order.status) && (
        <button className="w-full mt-6 py-3 border border-gray-300 rounded-lg font-medium hover:bg-gray-50 flex items-center justify-center gap-2">
          <PhoneIcon className="w-5 h-5" />
          Contact Driver
        </button>
      )}
    </div>
  );
}

function getStatusMessage(status: string): string {
  const messages: Record<string, string> = {
    PLACED: 'Waiting for restaurant to confirm',
    CONFIRMED: 'Restaurant is preparing your order',
    PREPARING: 'Your food is being prepared',
    READY_FOR_PICKUP: 'Driver is picking up your order',
    PICKED_UP: 'Driver is on the way',
    DELIVERED: 'Order delivered!',
  };
  return messages[status] || '';
}
```

---

## Step 6: Driver App UI (5 minutes)

### Driver Order Card (Mobile-Optimized)

```tsx
// components/driver/OrderCard.tsx
interface DriverOrderCardProps {
  order: DriverOrder;
  onAccept: () => void;
  onDecline: () => void;
  expiresIn: number; // seconds
}

export function DriverOrderCard({
  order,
  onAccept,
  onDecline,
  expiresIn,
}: DriverOrderCardProps) {
  const [timeLeft, setTimeLeft] = useState(expiresIn);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onDecline(); // Auto-decline when timer expires
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [onDecline]);

  return (
    <div className="fixed inset-x-0 bottom-0 bg-white rounded-t-3xl shadow-2xl p-6 animate-slide-up">
      {/* Timer bar */}
      <div className="h-1 bg-gray-200 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-red-500 transition-all duration-1000"
          style={{ width: `${(timeLeft / expiresIn) * 100}%` }}
        />
      </div>

      {/* Earnings */}
      <div className="text-center mb-4">
        <p className="text-3xl font-bold text-green-600">
          ${order.driverPayout.toFixed(2)}
        </p>
        <p className="text-sm text-gray-500">
          {order.estimatedDistance.toFixed(1)} mi total
        </p>
      </div>

      {/* Route summary */}
      <div className="space-y-3 mb-6">
        {/* Pickup */}
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
            <div className="w-2 h-2 rounded-full bg-red-500" />
          </div>
          <div>
            <p className="font-medium">{order.restaurant.name}</p>
            <p className="text-sm text-gray-500">{order.restaurant.address}</p>
            <p className="text-sm text-blue-600">{order.distanceToRestaurant.toFixed(1)} mi away</p>
          </div>
        </div>

        {/* Dropoff */}
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center shrink-0 mt-0.5">
            <div className="w-2 h-2 rounded-full bg-green-500" />
          </div>
          <div>
            <p className="font-medium">Customer</p>
            <p className="text-sm text-gray-500">{order.deliveryAddress.formatted}</p>
          </div>
        </div>
      </div>

      {/* Action buttons - large for thumb tap */}
      <div className="flex gap-4">
        <button
          onClick={onDecline}
          className="flex-1 py-4 rounded-xl border-2 border-gray-300 font-semibold text-gray-700 text-lg"
        >
          Decline
        </button>
        <button
          onClick={onAccept}
          className="flex-1 py-4 rounded-xl bg-green-500 text-white font-semibold text-lg"
        >
          Accept
        </button>
      </div>
    </div>
  );
}
```

---

## Step 7: Responsive Design Patterns (3 minutes)

### Mobile-First Breakpoints

```css
/* Tailwind config for DoorDash-style breakpoints */
module.exports = {
  theme: {
    screens: {
      'sm': '640px',   /* Mobile landscape */
      'md': '768px',   /* Tablet */
      'lg': '1024px',  /* Desktop */
      'xl': '1280px',  /* Large desktop */
    }
  }
}
```

### Responsive Grid for Restaurant List

```tsx
// Responsive grid layout
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
  {restaurants.map((restaurant) => (
    <RestaurantCard key={restaurant.id} restaurant={restaurant} />
  ))}
</div>
```

### Bottom Navigation for Mobile

```tsx
// components/layout/BottomNav.tsx
export function BottomNav() {
  const pathname = useLocation().pathname;

  const links = [
    { to: '/', icon: HomeIcon, label: 'Home' },
    { to: '/search', icon: SearchIcon, label: 'Search' },
    { to: '/orders', icon: ReceiptIcon, label: 'Orders' },
    { to: '/account', icon: UserIcon, label: 'Account' },
  ];

  return (
    <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 md:hidden z-40">
      <div className="flex justify-around py-2">
        {links.map(({ to, icon: Icon, label }) => (
          <Link
            key={to}
            to={to}
            className={`flex flex-col items-center py-2 px-4 ${
              pathname === to ? 'text-red-500' : 'text-gray-500'
            }`}
          >
            <Icon className="w-6 h-6" />
            <span className="text-xs mt-1">{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
```

---

## Step 8: Accessibility Considerations (2 minutes)

### WCAG 2.1 AA Compliance

```tsx
// Accessible cart button with live region
<button
  onClick={openCart}
  className="relative p-2"
  aria-label={`Shopping cart with ${itemCount} items`}
>
  <CartIcon className="w-6 h-6" />
  {itemCount > 0 && (
    <span
      className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center"
      aria-live="polite"
    >
      {itemCount}
    </span>
  )}
</button>

// Order status with screen reader announcements
<div role="status" aria-live="polite" className="sr-only">
  Order status updated: {getStatusMessage(order.status)}
</div>
```

### Color Contrast and Focus States

```css
/* Focus visible for keyboard navigation */
.focus-visible:focus {
  outline: 2px solid #3B82F6;
  outline-offset: 2px;
}

/* Ensure color contrast meets WCAG AA (4.5:1 for text) */
.text-gray-500 { color: #6B7280; } /* Passes on white background */
.text-red-500 { color: #EF4444; } /* Brand color, passes on white */
```

---

## Closing Summary

I've designed the frontend architecture for a food delivery platform with:

1. **Customer App**: Restaurant browsing with virtualized lists, cart management with Zustand persistence, and real-time order tracking with WebSocket and Mapbox integration

2. **Component Architecture**: Feature-based organization (restaurant, cart, order, tracking) with shared common components and a services layer for API/WebSocket abstraction

3. **Real-Time Tracking**: WebSocket service with automatic reconnection, live driver location updates on map, and animated status timeline

4. **Driver App**: Mobile-optimized UI with large touch targets, countdown timer for order acceptance, and one-handed operation design

5. **State Management**: Zustand stores for cart (with local storage persistence) and order tracking, with WebSocket updates flowing into React state

**Key Frontend Trade-offs:**
- Mapbox over Google Maps (better developer experience, competitive pricing)
- Zustand over Redux (simpler API for this scale of state management)
- TanStack Virtual for restaurant lists (performance with large datasets)
- WebSocket over polling (lower latency for real-time updates, more efficient)
