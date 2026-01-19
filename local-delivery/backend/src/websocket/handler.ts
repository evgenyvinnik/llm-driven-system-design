/**
 * WebSocket server for real-time delivery tracking and driver notifications.
 * Handles order status subscriptions, driver location updates, and delivery offers.
 * Uses Redis Pub/Sub for cross-instance message distribution.
 *
 * @module websocket/handler
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getSessionByToken } from '../services/authService.js';
import { getOrderWithDetails } from '../services/order/index.js';
import { getDriverById } from '../services/driverService.js';
import {
  createSubscriber,
  subscribeToOrderTracking,
  unsubscribeFromOrderTracking,
} from '../utils/redis.js';
import { haversineDistance, calculateETA } from '../utils/geo.js';

/** Type for Redis subscriber client */
type RedisSubscriber = ReturnType<typeof createSubscriber>;

/**
 * Represents a connected WebSocket client with its subscriptions and state.
 */
interface WSClient {
  id: string;
  ws: WebSocket;
  userId: string;
  userRole: string;
  orderId?: string;
  driverId?: string;
  subscriber?: RedisSubscriber;
}

/** Map of all active WebSocket connections by client ID. */
const clients = new Map<string, WSClient>();

/**
 * Initializes the WebSocket server and attaches it to the HTTP server.
 * Handles connection authentication, message routing, and cleanup.
 *
 * @param server - HTTP server instance to attach WebSocket to
 * @returns Configured WebSocketServer instance
 */
export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
  });

  wss.on('connection', async (ws, req) => {
    const clientId = uuidv4();
    console.log(`WebSocket client connected: ${clientId}`);

    // Parse query params for authentication
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
      ws.close(4001, 'Authentication required');
      return;
    }

    // Validate token
    const session = await getSessionByToken(token);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
      ws.close(4001, 'Invalid token');
      return;
    }

    // Get user info
    const { getUserById } = await import('../services/authService.js');
    const user = await getUserById(session.userId);
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      ws.close(4001, 'User not found');
      return;
    }

    const client: WSClient = {
      id: clientId,
      ws,
      userId: user.id,
      userRole: user.role,
    };

    clients.set(clientId, client);

    ws.send(
      JSON.stringify({
        type: 'connected',
        client_id: clientId,
        user_id: user.id,
        role: user.role,
      })
    );

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleMessage(client, message);
      } catch (error) {
        console.error('WebSocket message error:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', async () => {
      console.log(`WebSocket client disconnected: ${clientId}`);
      await cleanupClient(client);
      clients.delete(clientId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
    });
  });

  console.log('WebSocket server initialized');
  return wss;
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 *
 * @param client - The connected WebSocket client
 * @param message - Parsed message with type and payload
 */
async function handleMessage(client: WSClient, message: { type: string; payload?: unknown }): Promise<void> {
  const { type, payload } = message;

  switch (type) {
    case 'subscribe_order':
      await handleSubscribeOrder(client, payload as { order_id: string });
      break;

    case 'unsubscribe_order':
      await handleUnsubscribeOrder(client);
      break;

    case 'subscribe_driver_offers':
      await handleSubscribeDriverOffers(client);
      break;

    case 'update_location':
      await handleDriverLocationUpdate(
        client,
        payload as { lat: number; lng: number; speed?: number; heading?: number }
      );
      break;

    default:
      client.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${type}` }));
  }
}

/**
 * Subscribes a client to real-time updates for a specific order.
 * Sets up Redis Pub/Sub for status changes and driver location updates.
 *
 * @param client - The WebSocket client to subscribe
 * @param payload - Contains the order_id to subscribe to
 */
async function handleSubscribeOrder(
  client: WSClient,
  payload: { order_id: string }
): Promise<void> {
  const { order_id } = payload;

  // Get order and verify access
  const order = await getOrderWithDetails(order_id);
  if (!order) {
    client.ws.send(
      JSON.stringify({ type: 'error', message: 'Order not found' })
    );
    return;
  }

  // Check if user has access to this order
  if (
    order.customer_id !== client.userId &&
    order.driver_id !== client.userId &&
    client.userRole !== 'admin'
  ) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'Access denied' }));
    return;
  }

  // Clean up previous subscription
  if (client.subscriber) {
    await client.subscriber.quit();
  }

  // Create new subscriber
  const subscriber = createSubscriber();
  client.subscriber = subscriber;
  client.orderId = order_id;

  // Subscribe to order status updates
  await subscriber.subscribe(`order:${order_id}:status`);

  // If order has a driver, subscribe to driver location
  if (order.driver_id) {
    await subscriber.subscribe(`driver:${order.driver_id}:location`);
    client.driverId = order.driver_id;
  }

  // Add to Redis tracking set
  await subscribeToOrderTracking(order_id, client.id);

  // Handle incoming messages
  subscriber.on('message', async (channel: string, message: string) => {
    try {
      const data = JSON.parse(message);

      if (channel.includes(':status')) {
        client.ws.send(
          JSON.stringify({
            type: 'status_update',
            payload: data,
          })
        );
      } else if (channel.includes(':location')) {
        // Calculate ETA to delivery address
        const eta = calculateETA(
          haversineDistance(
            { lat: data.lat, lng: data.lng },
            { lat: order.delivery_lat, lng: order.delivery_lng }
          )
        );

        client.ws.send(
          JSON.stringify({
            type: 'location_update',
            payload: {
              lat: data.lat,
              lng: data.lng,
              eta_seconds: eta,
              timestamp: data.timestamp,
            },
          })
        );
      }
    } catch (error) {
      console.error('Error processing subscription message:', error);
    }
  });

  // Send current order status
  client.ws.send(
    JSON.stringify({
      type: 'order_subscribed',
      payload: {
        order_id,
        status: order.status,
        driver_id: order.driver_id,
      },
    })
  );
}

/**
 * Unsubscribes a client from order tracking updates.
 * Cleans up Redis subscriptions and tracking state.
 *
 * @param client - The WebSocket client to unsubscribe
 */
async function handleUnsubscribeOrder(client: WSClient): Promise<void> {
  if (client.subscriber) {
    await client.subscriber.quit();
    client.subscriber = undefined;
  }

  if (client.orderId) {
    await unsubscribeFromOrderTracking(client.orderId, client.id);
    client.orderId = undefined;
  }

  client.driverId = undefined;

  client.ws.send(JSON.stringify({ type: 'order_unsubscribed' }));
}

/**
 * Subscribes a driver to receive real-time delivery offer notifications.
 * Sets up Redis Pub/Sub for the driver's offer channel.
 *
 * @param client - The driver's WebSocket client
 */
async function handleSubscribeDriverOffers(client: WSClient): Promise<void> {
  if (client.userRole !== 'driver') {
    client.ws.send(
      JSON.stringify({ type: 'error', message: 'Only drivers can subscribe to offers' })
    );
    return;
  }

  // Clean up previous subscription
  if (client.subscriber) {
    await client.subscriber.quit();
  }

  const subscriber = createSubscriber();
  client.subscriber = subscriber;

  // Subscribe to driver offers
  await subscriber.subscribe(`driver:${client.userId}:offers`);

  subscriber.on('message', async (channel: string, message: string) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'new_offer') {
        // Get order details
        const order = await getOrderWithDetails(data.order_id);

        if (order) {
          client.ws.send(
            JSON.stringify({
              type: 'new_offer',
              payload: {
                offer_id: data.offer_id,
                order,
                expires_in: data.expires_in,
              },
            })
          );
        }
      }
    } catch (error) {
      console.error('Error processing offer message:', error);
    }
  });

  client.ws.send(JSON.stringify({ type: 'offers_subscribed' }));
}

/**
 * Processes a driver's location update sent via WebSocket.
 * Updates Redis geo-index and database for tracking.
 *
 * @param client - The driver's WebSocket client
 * @param payload - Location data with lat, lng, and optional speed/heading
 */
async function handleDriverLocationUpdate(
  client: WSClient,
  payload: { lat: number; lng: number; speed?: number; heading?: number }
): Promise<void> {
  if (client.userRole !== 'driver') {
    client.ws.send(
      JSON.stringify({ type: 'error', message: 'Only drivers can update location' })
    );
    return;
  }

  const { updateDriverLocation } = await import('../services/driverService.js');
  await updateDriverLocation(client.userId, payload.lat, payload.lng);

  client.ws.send(JSON.stringify({ type: 'location_updated' }));
}

/**
 * Cleans up resources when a WebSocket client disconnects.
 * Closes Redis subscriptions and removes from tracking sets.
 *
 * @param client - The disconnecting WebSocket client
 */
async function cleanupClient(client: WSClient): Promise<void> {
  if (client.subscriber) {
    await client.subscriber.quit();
  }

  if (client.orderId) {
    await unsubscribeFromOrderTracking(client.orderId, client.id);
  }
}

/**
 * Sends a message to all WebSocket connections for a specific user.
 * Used for cross-device notifications and account-level updates.
 *
 * @param userId - The target user's UUID
 * @param message - Message object to send (will be JSON stringified)
 */
export function broadcastToUser(userId: string, message: unknown): void {
  clients.forEach((client) => {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

/**
 * Sends a message to all clients subscribed to a specific order.
 * Used for status updates that need to reach both customer and driver.
 *
 * @param orderId - The order's UUID
 * @param message - Message object to send (will be JSON stringified)
 */
export function broadcastToOrderSubscribers(orderId: string, message: unknown): void {
  clients.forEach((client) => {
    if (client.orderId === orderId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}
