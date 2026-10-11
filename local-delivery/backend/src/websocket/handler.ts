/**
 * WebSocket server for real-time delivery tracking and driver notifications.
 * Handles order status subscriptions, driver location updates, and delivery offers.
 * Uses Redis Pub/Sub for cross-instance message distribution.
 *
 * Design:
 * - One Redis subscriber per process; a reference-counted registry fans each
 *   channel out to the local sockets that care (see channelRegistry.ts).
 * - Snapshot, then stream: subscribing to an order first subscribes to its
 *   channels, then sends the current order as `order_snapshot`. Status events
 *   carry the order's `version`, so a client keeps the newest copy whatever the
 *   arrival order. Pub/sub has no replay; after a reconnect the snapshot is
 *   what fills the gap.
 * - When a courier is assigned, the server moves the tracker's location
 *   subscription to that courier's channel; customers see the dot without
 *   resubscribing.
 * - Location updates carry a stage-aware ETA (to the merchant, wait for the
 *   food, then to the customer; or only the last leg after pickup).
 * - Heartbeat: every 30 s each socket is pinged; one that has not answered
 *   the previous ping is terminated, so dead connections do not pile up.
 *
 * @module websocket/handler
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getSessionByToken, getUserById } from '../services/authService.js';
import { getOrderWithDetails } from '../services/order/index.js';
import { updateDriverLocation } from '../services/driverService.js';
import { createSubscriber, getDriverLocationFromRedis } from '../utils/redis.js';
import { queryOne } from '../utils/db.js';
import { estimateDeliveryEtaSeconds } from '../utils/geo.js';
import type { Location, VehicleType } from '../utils/geo.js';
import { locationUpdateSchema } from '../shared/schemas.js';
import { logger } from '../shared/logger.js';
import { ChannelRegistry } from './channelRegistry.js';

const wsLogger = logger.child({ module: 'websocket' });

/** Interval between heartbeat pings. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Largest accepted client frame. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * What a tracking socket needs to compute ETAs without a database query per ping.
 */
interface TrackingContext {
  orderId: string;
  status: string;
  version: number;
  driverId: string | null;
  vehicleType?: VehicleType;
  pickup: Location;
  dropoff: Location;
  foodReadyAt: number | null;
}

/**
 * Represents a connected WebSocket client with its subscriptions and state.
 */
interface WSClient {
  id: string;
  ws: WebSocket;
  userId: string;
  userRole: string;
  isAlive: boolean;
  tracking?: TrackingContext;
}

/** Map of all active WebSocket connections by client ID. */
const clients = new Map<string, WSClient>();

type RedisSubscriber = ReturnType<typeof createSubscriber>;

let subscriber: RedisSubscriber | null = null;
let registry: ChannelRegistry<WSClient> | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let server: WebSocketServer | null = null;

const statusChannel = (orderId: string) => `order:${orderId}:status`;
const locationChannel = (driverId: string) => `driver:${driverId}:location`;
const offerChannel = (driverId: string) => `driver:${driverId}:offers`;

/**
 * Sends a typed message if the socket is open.
 */
function send(client: WSClient, type: string, payload?: unknown): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(payload === undefined ? { type } : { type, payload }));
  }
}

function sendError(client: WSClient, message: string): void {
  send(client, 'error', { message });
}

/**
 * Initializes the WebSocket server and attaches it to the HTTP server.
 * Handles connection authentication, message routing, and cleanup.
 *
 * @param httpServer - HTTP server instance to attach WebSocket to
 * @returns Configured WebSocketServer instance
 */
export function setupWebSocket(httpServer: Server): WebSocketServer {
  subscriber = createSubscriber();
  subscriber.on('error', (error: Error) => {
    wsLogger.error({ error: error.message }, 'Redis subscriber error');
  });
  const sub = subscriber;
  registry = new ChannelRegistry<WSClient>(
    (channel) => sub.subscribe(channel),
    (channel) => sub.unsubscribe(channel)
  );
  sub.on('message', (channel: string, message: string) => {
    void routeChannelMessage(channel, message);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD_BYTES });
  server = wss;

  wss.on('connection', async (ws, req) => {
    const clientId = uuidv4();

    // Browsers cannot set headers on a WebSocket, so the session token comes
    // in the query string. It is never logged.
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Authentication required');
      return;
    }

    const session = await getSessionByToken(token).catch(() => null);
    const user = session ? await getUserById(session.userId).catch(() => null) : null;
    if (!user) {
      ws.close(4001, 'Invalid token');
      return;
    }

    const client: WSClient = {
      id: clientId,
      ws,
      userId: user.id,
      userRole: user.role,
      isAlive: true,
    };
    clients.set(clientId, client);

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', async (data) => {
      let message: { type?: string; payload?: unknown };
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendError(client, 'Invalid message format');
        return;
      }
      try {
        await handleMessage(client, message);
      } catch (error) {
        wsLogger.error({ clientId, error: (error as Error).message }, 'WebSocket message failed');
        sendError(client, 'Request failed');
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      void registry?.removeClient(client);
    });

    ws.on('error', (error) => {
      wsLogger.warn({ clientId, error: error.message }, 'WebSocket error');
    });

    send(client, 'connected', { client_id: clientId, user_id: user.id, role: user.role });
  });

  heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wsLogger.info('WebSocket server initialized');
  return wss;
}

/**
 * Routes incoming WebSocket messages to appropriate handlers.
 *
 * @param client - The connected WebSocket client
 * @param message - Parsed message with type and payload
 */
async function handleMessage(client: WSClient, message: { type?: string; payload?: unknown }): Promise<void> {
  switch (message.type) {
    case 'subscribe_order': {
      const orderId = (message.payload as { order_id?: unknown } | undefined)?.order_id;
      if (typeof orderId !== 'string') {
        sendError(client, 'subscribe_order requires payload.order_id');
        return;
      }
      await handleSubscribeOrder(client, orderId);
      return;
    }

    case 'unsubscribe_order':
      await stopTracking(client);
      send(client, 'order_unsubscribed');
      return;

    case 'subscribe_driver_offers':
      await handleSubscribeDriverOffers(client);
      return;

    case 'update_location':
      await handleDriverLocationUpdate(client, message.payload);
      return;

    default:
      sendError(client, `Unknown message type: ${message.type}`);
  }
}

/**
 * Drops the client's current order subscription, if any.
 */
async function stopTracking(client: WSClient): Promise<void> {
  const tracking = client.tracking;
  if (!tracking || !registry) return;
  client.tracking = undefined;
  await registry.remove(statusChannel(tracking.orderId), client);
  if (tracking.driverId) {
    await registry.remove(locationChannel(tracking.driverId), client);
  }
}

/**
 * Looks up the courier's vehicle (it changes the speed assumption in the ETA).
 */
async function getVehicleType(driverId: string): Promise<VehicleType | undefined> {
  const row = await queryOne<{ vehicle_type: VehicleType }>(
    `SELECT vehicle_type FROM drivers WHERE id = $1`,
    [driverId]
  );
  return row?.vehicle_type;
}

/**
 * Subscribes a client to an order: status channel, courier location channel,
 * then sends the snapshot.
 *
 * @param client - The WebSocket client to subscribe
 * @param orderId - The order to track
 */
async function handleSubscribeOrder(client: WSClient, orderId: string): Promise<void> {
  const order = await getOrderWithDetails(orderId);
  if (!order) {
    sendError(client, 'Order not found');
    return;
  }
  if (order.customer_id !== client.userId && order.driver_id !== client.userId && client.userRole !== 'admin') {
    sendError(client, 'Access denied');
    return;
  }
  if (!registry) return;

  await stopTracking(client);

  const prepMinutes = order.estimated_prep_time_minutes;
  client.tracking = {
    orderId,
    status: order.status,
    version: order.version,
    driverId: order.driver_id,
    vehicleType: order.driver_id ? await getVehicleType(order.driver_id) : undefined,
    pickup: { lat: Number(order.merchant?.lat), lng: Number(order.merchant?.lng) },
    dropoff: { lat: Number(order.delivery_lat), lng: Number(order.delivery_lng) },
    foodReadyAt: prepMinutes ? new Date(order.created_at).getTime() + prepMinutes * 60_000 : null,
  };

  // Subscribe first, then read the snapshot: a change committed in between is
  // either in the snapshot or arrives as an event, never lost.
  await registry.add(statusChannel(orderId), client);
  if (order.driver_id) {
    await registry.add(locationChannel(order.driver_id), client);
  }

  const snapshot = (await getOrderWithDetails(orderId)) ?? order;
  send(client, 'order_snapshot', { order: snapshot });

  // Seed the map with the courier's last known position instead of waiting for the next ping.
  if (snapshot.driver_id) {
    const last = await getDriverLocationFromRedis(snapshot.driver_id);
    if (last) {
      sendLocation(client, { lat: last.lat, lng: last.lng, timestamp: last.updated_at });
    }
  }
}

/**
 * Subscribes a driver to receive real-time delivery offer notifications.
 *
 * @param client - The driver's WebSocket client
 */
async function handleSubscribeDriverOffers(client: WSClient): Promise<void> {
  if (client.userRole !== 'driver') {
    sendError(client, 'Only drivers can subscribe to offers');
    return;
  }
  await registry?.add(offerChannel(client.userId), client);
  send(client, 'offers_subscribed');
}

/**
 * Processes a driver's location update sent via WebSocket.
 * Same path as POST /api/v1/driver/location: Redis on every ping, PostgreSQL sampled.
 *
 * @param client - The driver's WebSocket client
 * @param payload - Location data with lat, lng, and optional speed/heading
 */
async function handleDriverLocationUpdate(client: WSClient, payload: unknown): Promise<void> {
  if (client.userRole !== 'driver') {
    sendError(client, 'Only drivers can update location');
    return;
  }
  const parsed = locationUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    sendError(client, 'Invalid location');
    return;
  }
  const { lat, lng, speed, heading } = parsed.data;
  await updateDriverLocation(client.userId, lat, lng, { speed, heading });
}

/**
 * Fans one Redis message out to the local sockets listening on its channel.
 */
async function routeChannelMessage(channel: string, raw: string): Promise<void> {
  const listeners = registry?.clientsOf(channel) ?? [];
  if (listeners.length === 0) return;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    wsLogger.warn({ channel }, 'Dropping malformed pub/sub message');
    return;
  }

  if (channel.endsWith(':status')) {
    for (const client of listeners) {
      await onStatusEvent(client, data);
    }
  } else if (channel.endsWith(':location')) {
    for (const client of listeners) {
      sendLocation(client, data as { lat: number; lng: number; timestamp: number });
    }
  } else if (channel.endsWith(':offers') && data.type === 'new_offer') {
    const order = await getOrderWithDetails(String(data.order_id));
    if (!order) return;
    for (const client of listeners) {
      send(client, 'new_offer', {
        offer_id: data.offer_id,
        order,
        expires_in: data.expires_in,
      });
    }
  }
}

/**
 * Applies a status event to a tracking socket: updates the ETA context, moves
 * the location subscription when a courier is assigned, and forwards the event.
 */
async function onStatusEvent(client: WSClient, data: Record<string, unknown>): Promise<void> {
  const tracking = client.tracking;
  if (!tracking || data.order_id !== tracking.orderId) return;

  const version = Number(data.version ?? 0);
  if (version >= tracking.version) {
    tracking.version = version;
    tracking.status = String(data.status);
  }

  const driverId = typeof data.driver_id === 'string' ? data.driver_id : null;
  if (driverId && driverId !== tracking.driverId && registry) {
    if (tracking.driverId) {
      await registry.remove(locationChannel(tracking.driverId), client);
    }
    tracking.driverId = driverId;
    tracking.vehicleType = await getVehicleType(driverId);
    await registry.add(locationChannel(driverId), client);
  }

  send(client, 'status_update', {
    order_id: data.order_id,
    status: data.status,
    driver_id: driverId,
    version,
    timestamp: data.timestamp,
  });
}

/**
 * Forwards a courier position with the ETA for this socket's order.
 */
function sendLocation(client: WSClient, data: { lat: number; lng: number; timestamp: number }): void {
  const tracking = client.tracking;
  if (!tracking) return;
  const eta = estimateDeliveryEtaSeconds({
    status: tracking.status,
    courier: { lat: Number(data.lat), lng: Number(data.lng) },
    pickup: tracking.pickup,
    dropoff: tracking.dropoff,
    vehicleType: tracking.vehicleType,
    foodReadyAt: tracking.foodReadyAt,
  });
  send(client, 'location_update', {
    lat: data.lat,
    lng: data.lng,
    eta_seconds: eta,
    timestamp: data.timestamp,
  });
}

/**
 * Closes every socket with "going away" and releases the Redis subscriber.
 * Part of graceful shutdown: clients reconnect to another instance.
 */
export async function closeWebSocket(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const client of clients.values()) {
    client.ws.close(1001, 'Server shutting down');
  }
  clients.clear();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (subscriber) {
    await subscriber.quit().catch(() => undefined);
    subscriber = null;
  }
}

/**
 * Number of open sockets on this instance (for health output).
 */
export function getConnectedClientCount(): number {
  return clients.size;
}
