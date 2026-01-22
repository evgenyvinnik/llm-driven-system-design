# Local Delivery Service - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Problem Statement

Design a local delivery platform like DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking with geo-indexing, efficient driver-order matching with scoring algorithms, WebSocket-based live updates, and building a seamless three-sided marketplace connecting customers, merchants, and drivers.

## Requirements Clarification

### Functional Requirements
- **Order placement**: Customers browse merchants, build cart, place orders
- **Driver matching**: Match orders to nearby available drivers using scoring
- **Real-time tracking**: Live driver location and ETA updates
- **Driver dashboard**: Go online/offline, accept offers, manage deliveries
- **Admin interface**: Monitor system statistics, orders, and drivers

### Non-Functional Requirements
- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: 1M orders/day, 100K concurrent drivers
- **Availability**: 99.99% for order placement
- **Responsiveness**: Frontend renders updates within 100ms of receipt

### Three-Sided Marketplace
- **Customers**: Browse and order, track deliveries
- **Drivers**: Manage availability, accept/complete orders
- **Merchants**: Receive orders, update prep status (future)

## High-Level Architecture

```
+------------------------------------------------------------------+
|                         Client Layer                              |
+------------------------------------------------------------------+
|  +----------------+  +----------------+  +----------------+       |
|  |   Customer     |  |    Driver      |  |     Admin      |       |
|  |   React App    |  |   React App    |  |   React App    |       |
|  +-------+--------+  +-------+--------+  +-------+--------+       |
|          |                   |                   |                |
|          +-------------------+-------------------+                |
|                              |                                    |
+------------------------------------------------------------------+
                               | HTTPS / WebSocket
+------------------------------------------------------------------+
|                         API Layer                                 |
+------------------------------------------------------------------+
|  +------------------------------------------------------------+  |
|  |                    Express.js Server                        |  |
|  |  +------------------+  +------------------+                 |  |
|  |  |   REST Routes    |  |  WebSocket       |                 |  |
|  |  |  /api/v1/*       |  |  Handler         |                 |  |
|  |  +------------------+  +------------------+                 |  |
|  +------------------------------------------------------------+  |
|          |                        |                              |
+------------------------------------------------------------------+
                               |
+------------------------------------------------------------------+
|                        Service Layer                              |
+------------------------------------------------------------------+
|  +-------------+  +-------------+  +-------------+  +---------+  |
|  |   Order     |  |  Location   |  |  Matching   |  | Tracking|  |
|  |   Service   |  |  Service    |  |  Service    |  | Service |  |
|  +-------------+  +-------------+  +-------------+  +---------+  |
+------------------------------------------------------------------+
                               |
+------------------------------------------------------------------+
|                         Data Layer                                |
+------------------------------------------------------------------+
|  +------------------+  +------------------+                       |
|  |    PostgreSQL    |  |      Redis       |                       |
|  |  (Transactions)  |  |  (Geo + Pub/Sub) |                       |
|  +------------------+  +------------------+                       |
+------------------------------------------------------------------+
```

## Deep Dives

### 1. Shared Type Definitions

TypeScript types shared between frontend and backend ensure consistency:

```typescript
// shared/types.ts (conceptually shared, practically duplicated with care)

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
  created_at: string;
}

export interface Driver extends User {
  vehicle_type: 'bicycle' | 'motorcycle' | 'car' | 'van';
  status: 'offline' | 'available' | 'busy';
  rating: number;
  total_deliveries: number;
  acceptance_rate: number;
  current_lat?: number;
  current_lng?: number;
}

// Merchant types
export interface Merchant {
  id: string;
  name: string;
  description?: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  avg_prep_time_minutes: number;
  rating: number;
  is_open: boolean;
}

export interface MenuItem {
  id: string;
  merchant_id: string;
  name: string;
  description?: string;
  price: number;
  category?: string;
  image_url?: string;
  is_available: boolean;
}

// Order types
export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready_for_pickup'
  | 'driver_assigned'
  | 'picked_up'
  | 'in_transit'
  | 'delivered'
  | 'cancelled';

export interface Order {
  id: string;
  customer_id: string;
  merchant_id: string;
  driver_id?: string;
  status: OrderStatus;
  delivery_address: string;
  delivery_lat: number;
  delivery_lng: number;
  subtotal: number;
  delivery_fee: number;
  tip: number;
  total: number;
  estimated_delivery_time?: string;
  created_at: string;
  items: OrderItem[];
  merchant?: Merchant;
  driver?: Driver;
}

export interface OrderItem {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  special_instructions?: string;
}

// WebSocket message types
export type WSMessageType =
  | 'new_offer'
  | 'offer_expired'
  | 'location_update'
  | 'status_update'
  | 'order_cancelled';

export interface WSMessage<T = unknown> {
  type: WSMessageType;
  data: T;
  timestamp: string;
}

// API response types
export interface ApiResponse<T> {
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
  };
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
```

### 2. RESTful API Design

Consistent API patterns across all endpoints:

**Customer Endpoints:**

```typescript
// Backend route definitions
// routes/customers.ts

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/validation';

const router = Router();

// Browse merchants
// GET /api/v1/merchants?lat=37.7749&lng=-122.4194&category=pizza&limit=20
router.get('/merchants', async (req, res) => {
  const { lat, lng, category, limit = 20 } = req.query;

  const merchants = await db.query(`
    SELECT *,
      (6371 * acos(cos(radians($1)) * cos(radians(lat)) *
       cos(radians(lng) - radians($2)) + sin(radians($1)) *
       sin(radians(lat)))) AS distance
    FROM merchants
    WHERE is_open = true
    ${category ? 'AND category = $3' : ''}
    ORDER BY distance
    LIMIT $4
  `, category ? [lat, lng, category, limit] : [lat, lng, limit]);

  res.json({ data: merchants.rows });
});

// Get merchant menu
// GET /api/v1/merchants/:id/menu
router.get('/merchants/:id/menu', async (req, res) => {
  const { id } = req.params;

  const [merchant, items] = await Promise.all([
    db.query('SELECT * FROM merchants WHERE id = $1', [id]),
    db.query('SELECT * FROM menu_items WHERE merchant_id = $1 AND is_available = true ORDER BY category, name', [id]),
  ]);

  if (!merchant.rows[0]) {
    return res.status(404).json({ error: 'Merchant not found' });
  }

  res.json({
    data: {
      merchant: merchant.rows[0],
      menu: items.rows,
    },
  });
});

// Create order
// POST /api/v1/orders
router.post('/orders', requireAuth, async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'] as string;
  const { merchant_id, items, delivery_address, delivery_lat, delivery_lng } = req.body;

  const { result, cached } = await withIdempotency(
    idempotencyKey,
    req.userId,
    'create_order',
    async () => {
      return await db.transaction(async (client) => {
        // Calculate totals
        const menuItems = await client.query(
          'SELECT * FROM menu_items WHERE id = ANY($1)',
          [items.map((i: any) => i.menu_item_id)]
        );

        let subtotal = 0;
        const orderItems = items.map((item: any) => {
          const menuItem = menuItems.rows.find((m) => m.id === item.menu_item_id);
          subtotal += menuItem.price * item.quantity;
          return {
            menu_item_id: item.menu_item_id,
            name: menuItem.name,
            quantity: item.quantity,
            unit_price: menuItem.price,
            special_instructions: item.special_instructions,
          };
        });

        const delivery_fee = 2.99; // Simplified
        const total = subtotal + delivery_fee;

        // Create order
        const orderResult = await client.query(`
          INSERT INTO orders (customer_id, merchant_id, delivery_address, delivery_lat, delivery_lng, subtotal, delivery_fee, total)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [req.userId, merchant_id, delivery_address, delivery_lat, delivery_lng, subtotal, delivery_fee, total]);

        const order = orderResult.rows[0];

        // Create order items
        for (const item of orderItems) {
          await client.query(`
            INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, special_instructions)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [order.id, item.menu_item_id, item.name, item.quantity, item.unit_price, item.special_instructions]);
        }

        // Trigger matching asynchronously
        startDriverMatching(order.id);

        return { ...order, items: orderItems };
      });
    }
  );

  res.status(cached ? 200 : 201).json({ data: result });
});
```

**Driver Endpoints:**

```typescript
// routes/driver.ts

// Go online
// POST /api/v1/driver/go-online
router.post('/go-online', requireAuth, requireRole('driver'), async (req, res) => {
  const driverId = req.userId;

  // Update PostgreSQL
  await db.query(
    'UPDATE drivers SET status = $1 WHERE id = $2',
    ['available', driverId]
  );

  // Get current location from request or last known
  const { lat, lng } = req.body;
  if (lat && lng) {
    // Add to Redis geo index
    await redis.geoadd('drivers:locations', lng, lat, driverId);
    await redis.hset(`driver:${driverId}`, {
      lat: lat.toString(),
      lng: lng.toString(),
      status: 'available',
      updated_at: Date.now().toString(),
    });
  }

  res.json({ data: { status: 'available' } });
});

// Update location
// POST /api/v1/driver/location
router.post('/location', requireAuth, requireRole('driver'), async (req, res) => {
  const driverId = req.userId;
  const { lat, lng, heading, speed } = req.body;

  // Update Redis geo index (real-time)
  await redis.geoadd('drivers:locations', lng, lat, driverId);
  await redis.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lng: lng.toString(),
    updated_at: Date.now().toString(),
  });

  // Update PostgreSQL (persistent last-known)
  await db.query(
    'UPDATE drivers SET current_lat = $1, current_lng = $2, location_updated_at = NOW() WHERE id = $3',
    [lat, lng, driverId]
  );

  // Publish for real-time tracking subscribers
  await redis.publish(`driver:${driverId}:location`, JSON.stringify({ lat, lng, heading, speed }));

  // Log to history (for analytics)
  await db.query(
    'INSERT INTO driver_location_history (driver_id, lat, lng, speed, heading) VALUES ($1, $2, $3, $4, $5)',
    [driverId, lat, lng, speed, heading]
  );

  res.json({ data: { success: true } });
});

// Accept offer
// POST /api/v1/driver/offers/:orderId/accept
router.post('/offers/:orderId/accept', requireAuth, requireRole('driver'), async (req, res) => {
  const driverId = req.userId;
  const { orderId } = req.params;

  // Verify offer exists and is still valid
  const offer = await db.query(`
    SELECT * FROM driver_offers
    WHERE order_id = $1 AND driver_id = $2 AND status = 'pending' AND expires_at > NOW()
  `, [orderId, driverId]);

  if (!offer.rows[0]) {
    return res.status(400).json({ error: 'Offer expired or already responded' });
  }

  // Use transaction to prevent race conditions
  const result = await db.transaction(async (client) => {
    // Update offer status
    await client.query(
      'UPDATE driver_offers SET status = $1, responded_at = NOW() WHERE id = $2',
      ['accepted', offer.rows[0].id]
    );

    // Assign driver to order (with optimistic lock)
    const updateResult = await client.query(`
      UPDATE orders SET driver_id = $1, status = 'driver_assigned'
      WHERE id = $2 AND driver_id IS NULL
      RETURNING *
    `, [driverId, orderId]);

    if (updateResult.rowCount === 0) {
      throw new Error('Order already assigned');
    }

    // Update driver status
    await client.query(
      'UPDATE drivers SET status = $1 WHERE id = $2',
      ['busy', driverId]
    );

    return updateResult.rows[0];
  });

  // Notify customer
  await redis.publish(`order:${orderId}:status`, JSON.stringify({
    status: 'driver_assigned',
    driver_id: driverId,
  }));

  res.json({ data: result });
});
```

### 3. Frontend API Client Integration

Typed API client with error handling:

```typescript
// services/api.ts

import { useAuthStore } from '../stores/authStore';
import type { ApiResponse, ApiError, Merchant, MenuItem, Order } from '../types';

const API_BASE = '/api/v1';

class ApiClient {
  private getHeaders(): HeadersInit {
    const token = useAuthStore.getState().token;
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async get<T>(path: string): Promise<ApiResponse<T>> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const error: ApiError = await response.json();
      throw new Error(error.message);
    }

    return response.json();
  }

  async post<T>(path: string, data?: unknown, options?: { idempotencyKey?: string }): Promise<ApiResponse<T>> {
    const headers = this.getHeaders();
    if (options?.idempotencyKey) {
      headers['X-Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const error: ApiError = await response.json();
      throw new Error(error.message);
    }

    return response.json();
  }
}

export const api = new ApiClient();

// Typed API functions
export async function fetchMerchants(lat: number, lng: number, category?: string): Promise<Merchant[]> {
  const params = new URLSearchParams({ lat: lat.toString(), lng: lng.toString() });
  if (category) params.append('category', category);

  const response = await api.get<Merchant[]>(`/merchants?${params}`);
  return response.data;
}

export async function fetchMerchantMenu(merchantId: string): Promise<{ merchant: Merchant; menu: MenuItem[] }> {
  const response = await api.get<{ merchant: Merchant; menu: MenuItem[] }>(`/merchants/${merchantId}/menu`);
  return response.data;
}

export async function createOrder(orderData: {
  merchant_id: string;
  items: Array<{ menu_item_id: string; quantity: number; special_instructions?: string }>;
  delivery_address: string;
  delivery_lat: number;
  delivery_lng: number;
}): Promise<Order> {
  const idempotencyKey = crypto.randomUUID();
  const response = await api.post<Order>('/orders', orderData, { idempotencyKey });
  return response.data;
}

export async function goOnline(location: { lat: number; lng: number }): Promise<void> {
  await api.post('/driver/go-online', location);
}

export async function goOffline(): Promise<void> {
  await api.post('/driver/go-offline');
}

export async function acceptOffer(orderId: string): Promise<Order> {
  const response = await api.post<Order>(`/driver/offers/${orderId}/accept`);
  return response.data;
}
```

### 4. Order Placement Flow (End-to-End)

**Frontend - Cart Component:**

```typescript
// routes/cart.tsx

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useCartStore } from '../stores/cartStore';
import { useLocationStore } from '../stores/locationStore';
import { createOrder } from '../services/api';
import { LoadingSpinner } from '../components';

export function CartPage() {
  const navigate = useNavigate();
  const { merchantId, merchantName, items, total, clearCart } = useCartStore();
  const { position } = useLocationStore();
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePlaceOrder = async () => {
    if (!merchantId || items.length === 0 || !deliveryAddress || !position) {
      setError('Please complete all required fields');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const order = await createOrder({
        merchant_id: merchantId,
        items: items.map((item) => ({
          menu_item_id: item.menuItemId,
          quantity: item.quantity,
          special_instructions: item.specialInstructions,
        })),
        delivery_address: deliveryAddress,
        delivery_lat: position.lat,
        delivery_lng: position.lng,
      });

      clearCart();
      navigate({ to: '/orders/$orderId', params: { orderId: order.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to place order');
    } finally {
      setIsLoading(false);
    }
  };

  if (!merchantId || items.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-600">Your cart is empty</p>
        <button
          onClick={() => navigate({ to: '/' })}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded"
        >
          Browse Restaurants
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Your Cart</h1>

      {/* Merchant */}
      <div className="bg-gray-50 p-4 rounded-lg mb-4">
        <p className="font-medium">{merchantName}</p>
      </div>

      {/* Items */}
      <div className="space-y-4 mb-6">
        {items.map((item) => (
          <CartItemRow key={item.id} item={item} />
        ))}
      </div>

      {/* Delivery address */}
      <div className="mb-6">
        <label className="block text-sm font-medium mb-2">Delivery Address</label>
        <input
          type="text"
          value={deliveryAddress}
          onChange={(e) => setDeliveryAddress(e.target.value)}
          placeholder="Enter your address"
          className="w-full p-3 border rounded-lg"
        />
      </div>

      {/* Summary */}
      <div className="border-t pt-4 mb-6">
        <div className="flex justify-between mb-2">
          <span>Subtotal</span>
          <span>${total().toFixed(2)}</span>
        </div>
        <div className="flex justify-between mb-2">
          <span>Delivery fee</span>
          <span>$2.99</span>
        </div>
        <div className="flex justify-between font-bold text-lg">
          <span>Total</span>
          <span>${(total() + 2.99).toFixed(2)}</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {/* Place order button */}
      <button
        onClick={handlePlaceOrder}
        disabled={isLoading || !deliveryAddress}
        className="w-full py-4 bg-blue-600 text-white rounded-lg font-medium disabled:opacity-50"
      >
        {isLoading ? <LoadingSpinner size="small" /> : 'Place Order'}
      </button>
    </div>
  );
}
```

**Backend - Order Processing:**

```typescript
// services/orderService.ts

export async function startDriverMatching(orderId: string): Promise<void> {
  const maxAttempts = 5;
  const offerTimeout = 30000; // 30 seconds
  const excludedDrivers = new Set<string>();

  const order = await db.query(
    'SELECT o.*, m.lat as merchant_lat, m.lng as merchant_lng FROM orders o JOIN merchants m ON o.merchant_id = m.id WHERE o.id = $1',
    [orderId]
  );

  if (!order.rows[0]) {
    throw new Error('Order not found');
  }

  const orderData = order.rows[0];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Find best available driver
    const driver = await findBestDriver(
      orderData.merchant_lat,
      orderData.merchant_lng,
      excludedDrivers
    );

    if (!driver) {
      // Wait and retry
      await new Promise((resolve) => setTimeout(resolve, 10000));
      continue;
    }

    // Create offer record
    await db.query(`
      INSERT INTO driver_offers (order_id, driver_id, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 seconds')
    `, [orderId, driver.id]);

    // Send offer via WebSocket
    await sendOfferToDriver(driver.id, orderData);

    // Wait for response
    const response = await waitForDriverResponse(driver.id, orderId, offerTimeout);

    if (response === 'accepted') {
      // Success! Order is assigned
      return;
    }

    // Driver rejected or timed out
    excludedDrivers.add(driver.id);
  }

  // No driver accepted - notify customer
  await notifyCustomer(orderId, 'no_driver_available');
}

async function findBestDriver(
  merchantLat: number,
  merchantLng: number,
  excludedDrivers: Set<string>
): Promise<{ id: string; distance: number } | null> {
  // Get nearby drivers from Redis
  const nearbyIds = await redis.georadius(
    'drivers:locations',
    merchantLng,
    merchantLat,
    5, // km
    'km',
    'WITHDIST',
    'ASC',
    'COUNT',
    20
  );

  // Filter and score
  const candidates = [];
  for (const [driverId, distStr] of nearbyIds) {
    if (excludedDrivers.has(driverId)) continue;

    const metadata = await redis.hgetall(`driver:${driverId}`);
    if (metadata.status !== 'available') continue;

    const stats = await db.query(
      'SELECT rating, acceptance_rate, (SELECT COUNT(*) FROM orders WHERE driver_id = $1 AND status IN ($2, $3, $4)) as current_orders FROM drivers WHERE id = $1',
      [driverId, 'driver_assigned', 'picked_up', 'in_transit']
    );

    const distance = parseFloat(distStr);
    const { rating, acceptance_rate, current_orders } = stats.rows[0];

    // Calculate score
    const distanceScore = Math.max(0, 1 - distance / 5) * 0.4;
    const ratingScore = (rating / 5) * 0.25;
    const acceptanceScore = acceptance_rate * 0.2;
    const loadScore = Math.max(0, 1 - current_orders / 3) * 0.15;
    const totalScore = distanceScore + ratingScore + acceptanceScore + loadScore;

    candidates.push({ id: driverId, distance, score: totalScore });
  }

  // Sort by score and return best
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function sendOfferToDriver(driverId: string, order: any): Promise<void> {
  const offerData = {
    type: 'new_offer',
    data: {
      order_id: order.id,
      merchant: {
        name: order.merchant_name,
        address: order.merchant_address,
      },
      delivery_address: order.delivery_address,
      earnings: order.delivery_fee + (order.tip || 0),
      expires_in: 30,
    },
    timestamp: new Date().toISOString(),
  };

  await redis.publish(`driver:${driverId}:offers`, JSON.stringify(offerData));
}
```

### 5. Real-time Tracking Integration

**Backend - WebSocket Handler:**

```typescript
// websocket/handler.ts

import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';

interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  role?: string;
  subscriptions: Set<string>;
}

const clients = new Map<string, ClientConnection>();
const subscriber = new Redis();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws, req) => {
    const connectionId = crypto.randomUUID();
    const client: ClientConnection = {
      ws,
      subscriptions: new Set(),
    };
    clients.set(connectionId, client);

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(connectionId, message);
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    });

    ws.on('close', () => {
      clients.delete(connectionId);
    });
  });

  // Subscribe to Redis channels for real-time updates
  subscriber.psubscribe('driver:*:location', 'order:*:status', 'driver:*:offers');

  subscriber.on('pmessage', (pattern, channel, message) => {
    const data = JSON.parse(message);

    if (pattern === 'driver:*:location') {
      // Forward location updates to subscribed customers
      const driverId = channel.split(':')[1];
      broadcastToSubscribers(`driver:${driverId}`, data);
    }

    if (pattern === 'order:*:status') {
      // Forward status updates to order subscribers
      const orderId = channel.split(':')[1];
      broadcastToSubscribers(`order:${orderId}`, data);
    }

    if (pattern === 'driver:*:offers') {
      // Forward offers to specific driver
      const driverId = channel.split(':')[1];
      const driver = findClientByUserId(driverId);
      if (driver) {
        driver.ws.send(JSON.stringify(data));
      }
    }
  });
}

async function handleMessage(connectionId: string, message: { type: string; data: unknown }) {
  const client = clients.get(connectionId);
  if (!client) return;

  switch (message.type) {
    case 'auth':
      // Authenticate WebSocket connection
      const { token } = message.data as { token: string };
      const session = await redis.get(`session:${token}`);
      if (session) {
        const userData = JSON.parse(session);
        client.userId = userData.userId;
        client.role = userData.role;
      }
      break;

    case 'subscribe':
      // Subscribe to updates (e.g., order tracking)
      const { orderId } = message.data as { orderId: string };
      client.subscriptions.add(`order:${orderId}`);

      // If order has a driver, also subscribe to driver location
      const order = await db.query('SELECT driver_id FROM orders WHERE id = $1', [orderId]);
      if (order.rows[0]?.driver_id) {
        client.subscriptions.add(`driver:${order.rows[0].driver_id}`);
      }
      break;

    case 'unsubscribe':
      const { orderId: unsubOrderId } = message.data as { orderId: string };
      client.subscriptions.delete(`order:${unsubOrderId}`);
      break;

    case 'location_update':
      // Driver sending location update (also sent via REST, but WS for real-time)
      if (client.role === 'driver' && client.userId) {
        const { lat, lng } = message.data as { lat: number; lng: number };
        await redis.publish(`driver:${client.userId}:location`, JSON.stringify({ lat, lng }));
      }
      break;
  }
}

function broadcastToSubscribers(channel: string, data: unknown) {
  for (const [, client] of clients) {
    if (client.subscriptions.has(channel)) {
      client.ws.send(JSON.stringify(data));
    }
  }
}

function findClientByUserId(userId: string): ClientConnection | undefined {
  for (const [, client] of clients) {
    if (client.userId === userId) {
      return client;
    }
  }
  return undefined;
}
```

**Frontend - Order Tracking with Real-time Updates:**

```typescript
// hooks/useOrderTracking.ts

import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { wsService } from '../services/websocket';
import type { Order } from '../types';

interface DriverLocation {
  lat: number;
  lng: number;
  heading?: number;
}

interface UseOrderTrackingReturn {
  order: Order | null;
  driverLocation: DriverLocation | null;
  eta: number | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useOrderTracking(orderId: string): UseOrderTrackingReturn {
  const [order, setOrder] = useState<Order | null>(null);
  const [driverLocation, setDriverLocation] = useState<DriverLocation | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOrder = useCallback(async () => {
    try {
      const response = await api.get<Order>(`/orders/${orderId}`);
      setOrder(response.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order');
    } finally {
      setIsLoading(false);
    }
  }, [orderId]);

  // Initial fetch
  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  // WebSocket subscription for real-time updates
  useEffect(() => {
    if (!order) return;

    wsService.connect();
    wsService.send('subscribe', { orderId });

    // Handle location updates
    wsService.on('location_update', (data: { lat: number; lng: number; eta?: number }) => {
      setDriverLocation({ lat: data.lat, lng: data.lng });
      if (data.eta) {
        setEta(data.eta);
      }
    });

    // Handle status updates
    wsService.on('status_update', (data: { status: string; driver_id?: string }) => {
      setOrder((prev) => {
        if (!prev) return null;
        return { ...prev, status: data.status as Order['status'] };
      });

      // If driver just assigned, refresh to get driver details
      if (data.status === 'driver_assigned') {
        fetchOrder();
      }
    });

    return () => {
      wsService.send('unsubscribe', { orderId });
      wsService.off('location_update', () => {});
      wsService.off('status_update', () => {});
      wsService.disconnect();
    };
  }, [order, orderId, fetchOrder]);

  return {
    order,
    driverLocation,
    eta,
    isLoading,
    error,
    refetch: fetchOrder,
  };
}
```

### 6. Session Management

**Backend - Session Service:**

```typescript
// shared/auth.ts

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

const redis = new Redis();
const SESSION_TTL = 24 * 60 * 60; // 24 hours

export interface Session {
  userId: string;
  email: string;
  role: 'customer' | 'driver' | 'merchant' | 'admin';
  createdAt: string;
}

export async function createSession(user: { id: string; email: string; role: string }): Promise<string> {
  const token = crypto.randomUUID();
  const session: Session = {
    userId: user.id,
    email: user.email,
    role: user.role as Session['role'],
    createdAt: new Date().toISOString(),
  };

  await redis.setex(`session:${token}`, SESSION_TTL, JSON.stringify(session));

  // Also store in PostgreSQL as backup
  await db.query(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES ($1, $2, NOW() + INTERVAL '24 hours')
  `, [user.id, token]);

  return token;
}

export async function getSession(token: string): Promise<Session | null> {
  const data = await redis.get(`session:${token}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function destroySession(token: string): Promise<void> {
  await redis.del(`session:${token}`);
  await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// Middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  getSession(token).then((session) => {
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.userId = session.userId;
    req.userRole = session.role;
    next();
  });
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(req.userRole!)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
```

**Frontend - Auth Store with Session:**

```typescript
// stores/authStore.ts

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: true,

      login: async (email, password) => {
        const response = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Login failed');
        }

        const { user, token } = await response.json();
        set({ user, token, isAuthenticated: true });
      },

      register: async (data) => {
        const response = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Registration failed');
        }

        const { user, token } = await response.json();
        set({ user, token, isAuthenticated: true });
      },

      logout: async () => {
        const { token } = get();
        if (token) {
          await fetch('/api/v1/auth/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
        }
        set({ user: null, token: null, isAuthenticated: false });
      },

      checkSession: async () => {
        const { token } = get();
        if (!token) {
          set({ isLoading: false });
          return;
        }

        try {
          const response = await fetch('/api/v1/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          });

          if (response.ok) {
            const { user } = await response.json();
            set({ user, isAuthenticated: true, isLoading: false });
          } else {
            set({ user: null, token: null, isAuthenticated: false, isLoading: false });
          }
        } catch {
          set({ isLoading: false });
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
```

### 7. Error Handling Across Stack

**Backend - Consistent Error Responses:**

```typescript
// middleware/errorHandler.ts

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public isOperational = true
  ) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error('Error:', err);

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
      statusCode: err.statusCode,
    });
  }

  // Database errors
  if (err.message.includes('violates foreign key constraint')) {
    return res.status(400).json({
      error: 'ValidationError',
      message: 'Referenced resource does not exist',
      statusCode: 400,
    });
  }

  if (err.message.includes('duplicate key value')) {
    return res.status(409).json({
      error: 'ConflictError',
      message: 'Resource already exists',
      statusCode: 409,
    });
  }

  // Default error
  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected error occurred',
    statusCode: 500,
  });
}
```

**Frontend - Error Display Component:**

```typescript
// components/ErrorDisplay.tsx

interface ErrorDisplayProps {
  error: string | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function ErrorDisplay({ error, onRetry, onDismiss }: ErrorDisplayProps) {
  if (!error) return null;

  return (
    <div
      className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex items-center justify-between"
      role="alert"
    >
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
            clipRule="evenodd"
          />
        </svg>
        <span>{error}</span>
      </div>
      <div className="flex gap-2">
        {onRetry && (
          <button onClick={onRetry} className="text-red-700 hover:text-red-800 font-medium">
            Retry
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} className="text-red-500 hover:text-red-600">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand | Redux / React Query | Minimal boilerplate, persistence middleware built-in |
| API communication | REST + WebSocket | GraphQL subscriptions | Simpler for real-time location updates, REST familiar |
| Session storage | Redis + PostgreSQL | JWT only | Instant revocation, Redis for speed, PG for durability |
| Type sharing | Manual sync | Monorepo with shared package | Simpler setup for learning project |
| Real-time updates | WebSocket + Redis Pub/Sub | Server-Sent Events | Bidirectional needed for driver actions |
| Geo-indexing | Redis GEOADD | PostgreSQL PostGIS | Sub-ms queries for real-time matching |

## Future Enhancements

1. **GraphQL layer**: Add GraphQL for flexible data fetching with subscriptions
2. **Type code generation**: Generate types from OpenAPI/Prisma schema
3. **Service worker**: Offline queue for order placement, cache merchants
4. **End-to-end tests**: Playwright tests covering order placement to delivery
5. **Metrics dashboard**: Real-time monitoring with Prometheus + Grafana
6. **Map integration**: Mapbox/Google Maps for visual driver tracking
