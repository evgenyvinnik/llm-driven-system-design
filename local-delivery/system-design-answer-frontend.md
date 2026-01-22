# Local Delivery Service - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the frontend for a local delivery platform like DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver tracking with map visualization, responsive order management across customer/driver/admin interfaces, managing WebSocket connections for live updates, and optimizing performance for location-based browsing.

## Requirements Clarification

### Functional Requirements
- **Customer interface**: Browse merchants, build cart, place orders, track delivery
- **Driver dashboard**: Go online/offline, receive offers, manage active deliveries, update location
- **Admin dashboard**: View system statistics, monitor orders and drivers
- **Real-time tracking**: Live driver location updates with ETA display
- **Responsive design**: Work across desktop and mobile devices

### Non-Functional Requirements
- **Performance**: First contentful paint < 1.5s, time to interactive < 3s
- **Real-time latency**: Location updates render within 100ms of receipt
- **Offline capability**: Basic cart functionality without network
- **Accessibility**: WCAG 2.1 AA compliance

### User Personas
- **Customers**: Browse and order, expect familiar e-commerce UX
- **Drivers**: Need quick actions, minimal distraction while driving
- **Admins**: Data-dense dashboards, need to monitor multiple metrics

## High-Level Architecture

```
+------------------------------------------------------------------+
|                        Frontend Application                        |
+------------------------------------------------------------------+
|                                                                    |
|  +------------------+  +------------------+  +------------------+  |
|  |    Customer      |  |     Driver       |  |      Admin       |  |
|  |    Routes        |  |     Routes       |  |      Routes      |  |
|  |                  |  |                  |  |                  |  |
|  | - / (merchants)  |  | - /driver        |  | - /admin         |  |
|  | - /cart          |  |   (dashboard)    |  |   (stats)        |  |
|  | - /orders        |  |                  |  |                  |  |
|  | - /orders/:id    |  |                  |  |                  |  |
|  +------------------+  +------------------+  +------------------+  |
|           |                    |                    |              |
|           v                    v                    v              |
|  +----------------------------------------------------------+     |
|  |                    Shared Components                       |     |
|  |  LoadingSpinner, StatusBadge, Navbar, OrderCard, etc.     |     |
|  +----------------------------------------------------------+     |
|           |                    |                    |              |
|           v                    v                    v              |
|  +----------------------------------------------------------+     |
|  |                      State Layer                           |     |
|  |  +-------------+  +-------------+  +-----------------+     |     |
|  |  | authStore   |  | cartStore   |  | locationStore   |     |     |
|  |  | (Zustand)   |  | (Zustand)   |  | (Zustand)       |     |     |
|  |  +-------------+  +-------------+  +-----------------+     |     |
|  +----------------------------------------------------------+     |
|           |                    |                    |              |
|           v                    v                    v              |
|  +----------------------------------------------------------+     |
|  |                    Service Layer                           |     |
|  |  +------------------+       +------------------+            |     |
|  |  |     api.ts       |       |  websocket.ts    |            |     |
|  |  | (REST client)    |       | (WS manager)     |            |     |
|  |  +------------------+       +------------------+            |     |
|  +----------------------------------------------------------+     |
+------------------------------------------------------------------+
```

## Deep Dives

### 1. Component Architecture

The frontend follows a component-based architecture with clear separation between presentation and logic:

**Directory Structure:**

```
frontend/src/
├── components/
│   ├── driver/                    # Driver-specific components
│   │   ├── index.ts               # Barrel exports
│   │   ├── DriverStatusHeader.tsx
│   │   ├── DriverStatsGrid.tsx
│   │   ├── ActiveDeliveryCard.tsx
│   │   └── DeliveryOfferModal.tsx
│   ├── LoadingSpinner.tsx
│   ├── MenuItemCard.tsx
│   ├── MerchantCard.tsx
│   ├── Navbar.tsx
│   ├── OrderCard.tsx
│   └── StatusBadge.tsx
├── hooks/
│   └── useDriverDashboard.ts      # Complex logic extraction
├── routes/                        # Page components (Tanstack Router)
│   ├── __root.tsx
│   ├── index.tsx                  # Home (merchants)
│   ├── driver.tsx
│   ├── admin.tsx
│   ├── cart.tsx
│   ├── login.tsx
│   ├── register.tsx
│   ├── merchants.$merchantId.tsx
│   ├── orders.index.tsx
│   └── orders.$orderId.tsx
├── services/
│   ├── api.ts
│   └── websocket.ts
├── stores/
│   ├── authStore.ts
│   ├── cartStore.ts
│   └── locationStore.ts
└── types/
    └── index.ts
```

**Component Barrel Exports:**

```typescript
// components/driver/index.ts
export { DriverStatusHeader } from './DriverStatusHeader';
export { DriverStatsGrid } from './DriverStatsGrid';
export { ActiveDeliveryCard } from './ActiveDeliveryCard';
export { DeliveryOfferModal } from './DeliveryOfferModal';
```

**Usage in page component:**

```typescript
import {
  DriverStatusHeader,
  DriverStatsGrid,
  ActiveDeliveryCard,
  DeliveryOfferModal,
} from '../components/driver';
```

### 2. Driver Dashboard Components

**DriverStatusHeader Component:**

```typescript
/**
 * Props for DriverStatusHeader component
 */
interface DriverStatusHeaderProps {
  /** Driver's display name */
  name: string;
  /** Current online/offline status */
  isOnline: boolean;
  /** Handler for toggling online status */
  onToggleStatus: () => void;
  /** Whether status toggle is in progress */
  isLoading: boolean;
}

export function DriverStatusHeader({
  name,
  isOnline,
  onToggleStatus,
  isLoading,
}: DriverStatusHeaderProps) {
  return (
    <div className="flex items-center justify-between bg-white p-4 rounded-lg shadow">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 bg-gray-200 rounded-full flex items-center justify-center">
          <span className="text-xl font-semibold">{name[0]}</span>
        </div>
        <div>
          <h2 className="font-semibold">{name}</h2>
          <span
            className={`text-sm ${isOnline ? 'text-green-600' : 'text-gray-500'}`}
          >
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      <button
        onClick={onToggleStatus}
        disabled={isLoading}
        className={`px-6 py-2 rounded-full font-medium transition-colors ${
          isOnline
            ? 'bg-red-100 text-red-700 hover:bg-red-200'
            : 'bg-green-100 text-green-700 hover:bg-green-200'
        } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
        aria-label={isOnline ? 'Go offline' : 'Go online'}
      >
        {isLoading ? 'Updating...' : isOnline ? 'Go Offline' : 'Go Online'}
      </button>
    </div>
  );
}
```

**ActiveDeliveryCard Component:**

```typescript
interface ActiveDeliveryCardProps {
  /** Order details */
  order: Order;
  /** Handler for status update */
  onUpdateStatus: (orderId: string, status: string) => void;
  /** Distance to destination in km */
  distance?: number;
}

export function ActiveDeliveryCard({
  order,
  onUpdateStatus,
  distance,
}: ActiveDeliveryCardProps) {
  const statusActions: Record<string, { next: string; label: string }> = {
    driver_assigned: { next: 'picked_up', label: 'Confirm Pickup' },
    picked_up: { next: 'in_transit', label: 'Start Delivery' },
    in_transit: { next: 'delivered', label: 'Complete Delivery' },
  };

  const action = statusActions[order.status];

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-4">
      {/* Merchant info */}
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold">{order.merchant.name}</h3>
          <p className="text-sm text-gray-500">{order.merchant.address}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {/* Delivery address */}
      <div className="border-t pt-4">
        <p className="text-sm font-medium text-gray-600">Deliver to:</p>
        <p className="text-sm">{order.delivery_address}</p>
        {distance && (
          <p className="text-xs text-gray-500 mt-1">{distance.toFixed(1)} km away</p>
        )}
      </div>

      {/* Order items summary */}
      <div className="border-t pt-4">
        <p className="text-sm text-gray-600">
          {order.items.length} item{order.items.length > 1 ? 's' : ''} - ${order.total.toFixed(2)}
        </p>
      </div>

      {/* Action button */}
      {action && (
        <button
          onClick={() => onUpdateStatus(order.id, action.next)}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
          aria-label={action.label}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
```

**DeliveryOfferModal Component with Countdown:**

```typescript
interface DeliveryOfferModalProps {
  /** The order being offered */
  offer: Order | null;
  /** Seconds remaining to respond */
  timeRemaining: number;
  /** Handler for accepting offer */
  onAccept: () => void;
  /** Handler for declining offer */
  onDecline: () => void;
  /** Whether action is in progress */
  isLoading: boolean;
}

export function DeliveryOfferModal({
  offer,
  timeRemaining,
  onAccept,
  onDecline,
  isLoading,
}: DeliveryOfferModalProps) {
  if (!offer) return null;

  const urgencyClass = timeRemaining <= 10 ? 'text-red-600' : 'text-gray-600';

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="offer-title"
    >
      <div className="bg-white rounded-xl p-6 m-4 max-w-md w-full shadow-2xl">
        <div className="text-center mb-4">
          <h2 id="offer-title" className="text-xl font-bold">
            New Delivery Offer
          </h2>
          <p className={`text-sm ${urgencyClass}`}>
            Expires in {timeRemaining}s
          </p>
        </div>

        {/* Offer details */}
        <div className="space-y-3 mb-6">
          <div className="flex justify-between">
            <span className="text-gray-600">Pickup</span>
            <span className="font-medium">{offer.merchant.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Deliver to</span>
            <span className="font-medium">{offer.delivery_address.split(',')[0]}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Earnings</span>
            <span className="font-semibold text-green-600">
              ${(offer.delivery_fee + order.tip).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-gray-200 rounded-full mb-6 overflow-hidden">
          <div
            className="h-full bg-blue-600 transition-all duration-1000"
            style={{ width: `${(timeRemaining / 30) * 100}%` }}
          />
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onDecline}
            disabled={isLoading}
            className="flex-1 py-3 border border-gray-300 rounded-lg font-medium hover:bg-gray-50"
          >
            Decline
          </button>
          <button
            onClick={onAccept}
            disabled={isLoading}
            className="flex-1 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700"
          >
            {isLoading ? 'Accepting...' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 3. Custom Hook for Driver Dashboard

Extract complex logic into a custom hook for testability and reusability:

```typescript
// hooks/useDriverDashboard.ts
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import { wsService } from '../services/websocket';
import { useLocationStore } from '../stores/locationStore';
import type { Order, DriverStats } from '../types';

interface UseDriverDashboardReturn {
  // State
  isOnline: boolean;
  stats: DriverStats | null;
  activeOrders: Order[];
  currentOffer: Order | null;
  offerTimeRemaining: number;
  isLoading: boolean;
  error: string | null;

  // Actions
  toggleOnlineStatus: () => Promise<void>;
  acceptOffer: () => Promise<void>;
  declineOffer: () => Promise<void>;
  updateOrderStatus: (orderId: string, status: string) => Promise<void>;
}

export function useDriverDashboard(): UseDriverDashboardReturn {
  const [isOnline, setIsOnline] = useState(false);
  const [stats, setStats] = useState<DriverStats | null>(null);
  const [activeOrders, setActiveOrders] = useState<Order[]>([]);
  const [currentOffer, setCurrentOffer] = useState<Order | null>(null);
  const [offerTimeRemaining, setOfferTimeRemaining] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offerTimerRef = useRef<NodeJS.Timeout | null>(null);
  const { startWatching, stopWatching, position } = useLocationStore();

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statusRes, statsRes, ordersRes] = await Promise.all([
          api.get('/driver/status'),
          api.get('/driver/stats'),
          api.get('/driver/orders'),
        ]);
        setIsOnline(statusRes.data.status === 'available');
        setStats(statsRes.data);
        setActiveOrders(ordersRes.data);
      } catch (err) {
        setError('Failed to load driver data');
      }
    };
    fetchData();
  }, []);

  // WebSocket connection management
  useEffect(() => {
    if (!isOnline) return;

    wsService.connect();

    // Listen for new offers
    wsService.on('new_offer', (offer: Order) => {
      setCurrentOffer(offer);
      setOfferTimeRemaining(30);

      // Start countdown timer
      offerTimerRef.current = setInterval(() => {
        setOfferTimeRemaining((prev) => {
          if (prev <= 1) {
            clearInterval(offerTimerRef.current!);
            setCurrentOffer(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    });

    // Listen for order updates
    wsService.on('order_update', (update: { orderId: string; status: string }) => {
      setActiveOrders((orders) =>
        orders.map((o) =>
          o.id === update.orderId ? { ...o, status: update.status } : o
        )
      );
    });

    return () => {
      wsService.disconnect();
      if (offerTimerRef.current) {
        clearInterval(offerTimerRef.current);
      }
    };
  }, [isOnline]);

  // Location tracking when online
  useEffect(() => {
    if (isOnline) {
      startWatching();
    } else {
      stopWatching();
    }
    return () => stopWatching();
  }, [isOnline, startWatching, stopWatching]);

  // Send location updates
  useEffect(() => {
    if (!isOnline || !position) return;

    const sendLocation = async () => {
      try {
        await api.post('/driver/location', {
          lat: position.lat,
          lng: position.lng,
        });
        wsService.send('location_update', position);
      } catch (err) {
        console.error('Failed to send location:', err);
      }
    };

    sendLocation();
    const interval = setInterval(sendLocation, 3000);
    return () => clearInterval(interval);
  }, [isOnline, position]);

  // Actions
  const toggleOnlineStatus = useCallback(async () => {
    setIsLoading(true);
    try {
      const endpoint = isOnline ? '/driver/go-offline' : '/driver/go-online';
      await api.post(endpoint);
      setIsOnline(!isOnline);
    } catch (err) {
      setError('Failed to update status');
    } finally {
      setIsLoading(false);
    }
  }, [isOnline]);

  const acceptOffer = useCallback(async () => {
    if (!currentOffer) return;
    setIsLoading(true);
    try {
      await api.post(`/driver/offers/${currentOffer.id}/accept`);
      setActiveOrders((orders) => [...orders, currentOffer]);
      setCurrentOffer(null);
      if (offerTimerRef.current) {
        clearInterval(offerTimerRef.current);
      }
    } catch (err) {
      setError('Failed to accept offer');
    } finally {
      setIsLoading(false);
    }
  }, [currentOffer]);

  const declineOffer = useCallback(async () => {
    if (!currentOffer) return;
    try {
      await api.post(`/driver/offers/${currentOffer.id}/reject`);
      setCurrentOffer(null);
      if (offerTimerRef.current) {
        clearInterval(offerTimerRef.current);
      }
    } catch (err) {
      setError('Failed to decline offer');
    }
  }, [currentOffer]);

  const updateOrderStatus = useCallback(async (orderId: string, status: string) => {
    try {
      await api.post(`/driver/orders/${orderId}/${status}`);
      if (status === 'delivered') {
        setActiveOrders((orders) => orders.filter((o) => o.id !== orderId));
        // Refresh stats after completion
        const statsRes = await api.get('/driver/stats');
        setStats(statsRes.data);
      }
    } catch (err) {
      setError('Failed to update order status');
    }
  }, []);

  return {
    isOnline,
    stats,
    activeOrders,
    currentOffer,
    offerTimeRemaining,
    isLoading,
    error,
    toggleOnlineStatus,
    acceptOffer,
    declineOffer,
    updateOrderStatus,
  };
}
```

### 4. Zustand State Management

**Auth Store:**

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  name: string;
  email: string;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (user: User, token: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const response = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          throw new Error('Invalid credentials');
        }

        const { user, token } = await response.json();
        set({ user, token, isAuthenticated: true });
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false });
      },

      setUser: (user, token) => {
        set({ user, token, isAuthenticated: true });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, token: state.token }),
    }
  )
);
```

**Cart Store with Persistence:**

```typescript
// stores/cartStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface CartItem {
  id: string;
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  specialInstructions?: string;
}

interface CartState {
  merchantId: string | null;
  merchantName: string | null;
  items: CartItem[];
  addItem: (item: Omit<CartItem, 'id'>) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  clearCart: () => void;
  setMerchant: (id: string, name: string) => void;
  total: () => number;
  itemCount: () => number;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      merchantId: null,
      merchantName: null,
      items: [],

      addItem: (item) => {
        const id = crypto.randomUUID();
        set((state) => ({
          items: [...state.items, { ...item, id }],
        }));
      },

      removeItem: (id) => {
        set((state) => ({
          items: state.items.filter((item) => item.id !== id),
        }));
      },

      updateQuantity: (id, quantity) => {
        if (quantity <= 0) {
          get().removeItem(id);
          return;
        }
        set((state) => ({
          items: state.items.map((item) =>
            item.id === id ? { ...item, quantity } : item
          ),
        }));
      },

      clearCart: () => {
        set({ merchantId: null, merchantName: null, items: [] });
      },

      setMerchant: (id, name) => {
        const currentMerchantId = get().merchantId;
        if (currentMerchantId && currentMerchantId !== id) {
          // Clear cart if switching merchants
          set({ merchantId: id, merchantName: name, items: [] });
        } else {
          set({ merchantId: id, merchantName: name });
        }
      },

      total: () => {
        return get().items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0
        );
      },

      itemCount: () => {
        return get().items.reduce((sum, item) => sum + item.quantity, 0);
      },
    }),
    {
      name: 'cart-storage',
    }
  )
);
```

**Location Store:**

```typescript
// stores/locationStore.ts
import { create } from 'zustand';

interface Position {
  lat: number;
  lng: number;
  accuracy: number;
  heading?: number;
  speed?: number;
}

interface LocationState {
  position: Position | null;
  error: string | null;
  isWatching: boolean;
  watchId: number | null;
  startWatching: () => void;
  stopWatching: () => void;
}

export const useLocationStore = create<LocationState>((set, get) => ({
  position: null,
  error: null,
  isWatching: false,
  watchId: null,

  startWatching: () => {
    if (get().isWatching) return;

    if (!navigator.geolocation) {
      set({ error: 'Geolocation is not supported' });
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        set({
          position: {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading ?? undefined,
            speed: pos.coords.speed ?? undefined,
          },
          error: null,
        });
      },
      (err) => {
        set({ error: err.message });
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000,
      }
    );

    set({ isWatching: true, watchId });
  },

  stopWatching: () => {
    const { watchId } = get();
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
    }
    set({ isWatching: false, watchId: null });
  },
}));
```

### 5. WebSocket Service

```typescript
// services/websocket.ts
type EventHandler = (data: unknown) => void;

class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  connect(token?: string) {
    const url = `ws://localhost:3000/ws${token ? `?token=${token}` : ''}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        const handlers = this.handlers.get(message.type);
        if (handlers) {
          handlers.forEach((handler) => handler(message.data));
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.attemptReconnect(token);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private attemptReconnect(token?: string) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(token), delay);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(type: string, data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler) {
    this.handlers.get(event)?.delete(handler);
  }
}

export const wsService = new WebSocketService();
```

### 6. Order Tracking Page with Real-time Updates

```typescript
// routes/orders.$orderId.tsx
import { useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { wsService } from '../services/websocket';
import { StatusBadge, LoadingSpinner } from '../components';
import type { Order } from '../types';

export function OrderTrackingPage() {
  const { orderId } = useParams({ from: '/orders/$orderId' });
  const [order, setOrder] = useState<Order | null>(null);
  const [driverLocation, setDriverLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchOrder = async () => {
      try {
        const response = await api.get(`/orders/${orderId}`);
        setOrder(response.data);
      } catch (err) {
        console.error('Failed to fetch order:', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchOrder();
  }, [orderId]);

  // Subscribe to real-time updates
  useEffect(() => {
    if (!order || !order.driver_id) return;

    wsService.connect();

    // Subscribe to this order's updates
    wsService.send('subscribe', { orderId });

    wsService.on('location_update', (data: { lat: number; lng: number; eta: number }) => {
      setDriverLocation({ lat: data.lat, lng: data.lng });
      setEta(data.eta);
    });

    wsService.on('status_update', (data: { status: string }) => {
      setOrder((prev) => prev ? { ...prev, status: data.status } : null);
    });

    return () => {
      wsService.send('unsubscribe', { orderId });
      wsService.disconnect();
    };
  }, [order, orderId]);

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!order) {
    return <div className="p-4 text-center text-red-600">Order not found</div>;
  }

  return (
    <div className="max-w-lg mx-auto p-4 space-y-6">
      {/* Status header */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-xl font-bold">Order #{order.id.slice(0, 8)}</h1>
          <StatusBadge status={order.status} />
        </div>

        {eta && (
          <div className="text-center py-4 bg-blue-50 rounded-lg">
            <p className="text-sm text-gray-600">Estimated arrival</p>
            <p className="text-3xl font-bold text-blue-600">
              {Math.ceil(eta / 60)} min
            </p>
          </div>
        )}
      </div>

      {/* Order timeline */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold mb-4">Order Progress</h2>
        <OrderTimeline status={order.status} />
      </div>

      {/* Driver info */}
      {order.driver && (
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold mb-4">Your Driver</h2>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gray-200 rounded-full" />
            <div>
              <p className="font-medium">{order.driver.name}</p>
              <p className="text-sm text-gray-500">
                Rating: {order.driver.rating.toFixed(1)} / 5.0
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Order summary */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold mb-4">Order Summary</h2>
        <div className="space-y-2">
          {order.items.map((item) => (
            <div key={item.id} className="flex justify-between text-sm">
              <span>{item.quantity}x {item.name}</span>
              <span>${(item.unit_price * item.quantity).toFixed(2)}</span>
            </div>
          ))}
          <div className="border-t pt-2 mt-2">
            <div className="flex justify-between text-sm">
              <span>Subtotal</span>
              <span>${order.subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Delivery fee</span>
              <span>${order.delivery_fee.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-semibold mt-2">
              <span>Total</span>
              <span>${order.total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OrderTimeline({ status }: { status: string }) {
  const steps = [
    { key: 'confirmed', label: 'Order Confirmed' },
    { key: 'preparing', label: 'Preparing' },
    { key: 'picked_up', label: 'Picked Up' },
    { key: 'in_transit', label: 'On the Way' },
    { key: 'delivered', label: 'Delivered' },
  ];

  const statusOrder = ['pending', 'confirmed', 'preparing', 'ready_for_pickup', 'driver_assigned', 'picked_up', 'in_transit', 'delivered'];
  const currentIndex = statusOrder.indexOf(status);

  return (
    <div className="space-y-3">
      {steps.map((step, index) => {
        const stepIndex = statusOrder.indexOf(step.key);
        const isComplete = currentIndex >= stepIndex;
        const isCurrent = status === step.key;

        return (
          <div key={step.key} className="flex items-center gap-3">
            <div
              className={`w-4 h-4 rounded-full flex items-center justify-center ${
                isComplete ? 'bg-green-500' : 'bg-gray-200'
              } ${isCurrent ? 'ring-2 ring-green-300' : ''}`}
            >
              {isComplete && (
                <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </div>
            <span className={isComplete ? 'text-gray-900' : 'text-gray-400'}>
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

### 7. Accessibility Patterns

**Focus Management:**

```typescript
// components/DeliveryOfferModal.tsx - Focus trap
import { useEffect, useRef } from 'react';

export function DeliveryOfferModal({ offer, onAccept, onDecline, ...props }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  // Focus first interactive element when modal opens
  useEffect(() => {
    if (offer) {
      acceptButtonRef.current?.focus();
    }
  }, [offer]);

  // Trap focus within modal
  useEffect(() => {
    if (!offer) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDecline();
      }
      if (e.key === 'Tab') {
        const focusableElements = modalRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusableElements?.length) return;

        const first = focusableElements[0] as HTMLElement;
        const last = focusableElements[focusableElements.length - 1] as HTMLElement;

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [offer, onDecline]);

  // ... rest of component
}
```

**Screen Reader Announcements:**

```typescript
// hooks/useAnnounce.ts
export function useAnnounce() {
  const announce = (message: string, priority: 'polite' | 'assertive' = 'polite') => {
    const region = document.getElementById('announcements') || createAnnouncementRegion();
    region.setAttribute('aria-live', priority);
    region.textContent = message;
  };

  return { announce };
}

function createAnnouncementRegion(): HTMLElement {
  const region = document.createElement('div');
  region.id = 'announcements';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.className = 'sr-only';
  document.body.appendChild(region);
  return region;
}

// Usage in driver dashboard
const { announce } = useAnnounce();

wsService.on('new_offer', (offer) => {
  announce(`New delivery offer from ${offer.merchant.name}. You have 30 seconds to respond.`, 'assertive');
});
```

### 8. Loading and Error States

**Skeleton Loader for Merchant Cards:**

```typescript
export function MerchantCardSkeleton() {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden animate-pulse">
      {/* Image placeholder */}
      <div className="h-40 bg-gray-200" />

      {/* Content */}
      <div className="p-4 space-y-3">
        {/* Title */}
        <div className="h-5 bg-gray-200 rounded w-3/4" />

        {/* Category */}
        <div className="h-4 bg-gray-200 rounded w-1/2" />

        {/* Rating and delivery time */}
        <div className="flex gap-4">
          <div className="h-4 bg-gray-200 rounded w-16" />
          <div className="h-4 bg-gray-200 rounded w-20" />
        </div>
      </div>
    </div>
  );
}

export function MerchantListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <MerchantCardSkeleton key={i} />
      ))}
    </div>
  );
}
```

**Error Boundary with Retry:**

```typescript
import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="p-8 text-center" role="alert">
          <div className="text-red-500 mb-4">
            <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
          <p className="text-gray-600 mb-4">{this.state.error?.message}</p>
          <button
            onClick={this.handleRetry}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand | Redux / Context | Minimal boilerplate, built-in persistence |
| Routing | Tanstack Router | React Router | File-based routing, type-safe params |
| WebSocket | Native WebSocket | Socket.io | Lower overhead, sufficient for use case |
| Component styling | Tailwind CSS | CSS Modules / styled-components | Rapid prototyping, consistent design system |
| Location tracking | Geolocation API | Map SDK built-in | No external dependency, privacy control |
| Real-time updates | Push via WebSocket | Polling | Lower latency, reduced server load |

## Future Enhancements

1. **Map visualization**: Integrate Mapbox/Google Maps for driver tracking with route display
2. **Offline mode**: Service worker for cart persistence and order queue when offline
3. **Performance optimization**: Virtual list for long order histories, lazy-loaded images
4. **Push notifications**: Web Push API for order updates when app is in background
5. **PWA**: Add to home screen, splash screen, offline indicators
6. **E2E testing**: Playwright tests for critical user flows
