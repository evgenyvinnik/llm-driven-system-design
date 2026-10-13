/**
 * WebSocket service for real-time delivery updates.
 * Manages connection lifecycle, automatic reconnection, and message routing
 * for order tracking, driver offers, and location updates.
 *
 * Contract with the server: pub/sub has no replay, so every (re)connect is
 * "snapshot, then stream". Pages resubscribe in onConnected; the server answers
 * an order subscription with an `order_snapshot`, and status events carry the
 * order's `version` so pages can drop anything older than what they show.
 *
 * @module services/websocket
 */
import type {
  WSMessage,
  LocationUpdatePayload,
  StatusUpdatePayload,
  NewOfferPayload,
  OrderSnapshotPayload,
  ConnectionState,
} from '@/types';

/**
 * Callbacks for handling different WebSocket message types.
 */
export type WSEventHandler = {
  onLocationUpdate?: (payload: LocationUpdatePayload) => void;
  onStatusUpdate?: (payload: StatusUpdatePayload) => void;
  onOrderSnapshot?: (payload: OrderSnapshotPayload) => void;
  onNewOffer?: (payload: NewOfferPayload) => void;
  /** Called after every successful (re)connect: resubscribe and resync here. */
  onConnected?: (data: { client_id: string; user_id: string; role: string }) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

/** Reconnect delays grow 1 s, 2 s, 4 s ... up to this cap, with jitter. */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * WebSocket client for real-time communication with the delivery platform.
 * Reconnects with capped exponential backoff and jitter until disconnect() is
 * called; a phone that loses signal for five minutes recovers on its own.
 */
export class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: WSEventHandler = {};
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private token: string | null = null;

  /**
   * Establishes a WebSocket connection with authentication.
   * Replaces any existing connection (the service is a shared singleton).
   *
   * @param token - Authentication token to include in connection URL
   * @param handlers - Callbacks for handling different message types
   */
  connect(token: string, handlers: WSEventHandler): void {
    this.closeSocket();
    this.token = token;
    this.handlers = handlers;
    this.open();
  }

  private open(): void {
    if (!this.token) return;
    this.handlers.onConnectionChange?.(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onConnectionChange?.('open');
    };

    ws.onmessage = (event) => {
      let message: WSMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
        return;
      }
      this.handleMessage(message);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return; // replaced or closed on purpose
      this.ws = null;
      this.handlers.onClose?.();
      // 4001 = authentication failed: retrying cannot help.
      if (event.code === 4001) {
        this.handlers.onConnectionChange?.('closed');
        this.handlers.onError?.('Session expired; please log in again');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  /**
   * Routes incoming WebSocket messages to appropriate handlers.
   *
   * @param message - Parsed WebSocket message with type and payload
   */
  private handleMessage(message: WSMessage): void {
    switch (message.type) {
      case 'connected':
        this.handlers.onConnected?.(message.payload as { client_id: string; user_id: string; role: string });
        break;

      case 'order_snapshot':
        this.handlers.onOrderSnapshot?.(message.payload as OrderSnapshotPayload);
        break;

      case 'location_update':
        this.handlers.onLocationUpdate?.(message.payload as LocationUpdatePayload);
        break;

      case 'status_update':
        this.handlers.onStatusUpdate?.(message.payload as StatusUpdatePayload);
        break;

      case 'new_offer':
        this.handlers.onNewOffer?.(message.payload as NewOfferPayload);
        break;

      case 'error':
        this.handlers.onError?.((message.payload as { message?: string } | undefined)?.message || 'Unknown error');
        break;

      case 'offers_subscribed':
      case 'order_unsubscribed':
        break;

      default:
        console.debug('Unhandled WebSocket message type:', message.type);
    }
  }

  /**
   * Schedules the next reconnect: exponential backoff capped at 30 s, with
   * full jitter so thousands of clients dropped by one deploy do not reconnect
   * in the same second.
   */
  private scheduleReconnect(): void {
    if (!this.token) return;
    this.handlers.onConnectionChange?.('reconnecting');
    const ceiling = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts);
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  /**
   * Sends a message through the WebSocket connection.
   *
   * @param message - Message to send (will be JSON stringified)
   * @returns True if the message was handed to an open socket
   */
  send(message: WSMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /**
   * Subscribes to real-time updates for a specific order.
   * The server replies with an `order_snapshot`, then streams changes.
   *
   * @param orderId - Order UUID to subscribe to
   */
  subscribeToOrder(orderId: string): void {
    this.send({
      type: 'subscribe_order',
      payload: { order_id: orderId },
    });
  }

  /**
   * Unsubscribes from order updates.
   */
  unsubscribeFromOrder(): void {
    this.send({
      type: 'unsubscribe_order',
    });
  }

  /**
   * Subscribes driver to receive real-time delivery offers.
   */
  subscribeToDriverOffers(): void {
    this.send({
      type: 'subscribe_driver_offers',
    });
  }

  /**
   * Sends driver's current location through WebSocket.
   *
   * @returns False when the socket is not open (the caller falls back to HTTP)
   */
  updateLocation(lat: number, lng: number, speed?: number, heading?: number): boolean {
    return this.send({
      type: 'update_location',
      payload: { lat, lng, speed, heading },
    });
  }

  private closeSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  /**
   * Closes the WebSocket connection and stops reconnecting.
   */
  disconnect(): void {
    this.closeSocket();
    this.handlers.onConnectionChange?.('closed');
    this.token = null;
    this.handlers = {};
    this.reconnectAttempts = 0;
  }

  /**
   * Checks if the WebSocket connection is currently open.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Singleton WebSocket service instance.
 */
export const wsService = new WebSocketService();
