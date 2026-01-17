/**
 * WebSocket service for real-time delivery updates.
 * Manages connection lifecycle, automatic reconnection, and message routing
 * for order tracking, driver offers, and location updates.
 *
 * @module services/websocket
 */
import type { WSMessage, LocationUpdatePayload, StatusUpdatePayload, NewOfferPayload } from '@/types';

/**
 * Callbacks for handling different WebSocket message types.
 */
export type WSEventHandler = {
  onLocationUpdate?: (payload: LocationUpdatePayload) => void;
  onStatusUpdate?: (payload: StatusUpdatePayload) => void;
  onNewOffer?: (payload: NewOfferPayload) => void;
  onConnected?: (data: { client_id: string; user_id: string; role: string }) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

/**
 * WebSocket client for real-time communication with the delivery platform.
 * Features automatic reconnection with exponential backoff on connection loss.
 */
export class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: WSEventHandler = {};
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private token: string | null = null;

  /**
   * Establishes a WebSocket connection with authentication.
   * Sets up message handlers and automatic reconnection on disconnect.
   *
   * @param token - Authentication token to include in connection URL
   * @param handlers - Callbacks for handling different message types
   */
  connect(token: string, handlers: WSEventHandler): void {
    this.token = token;
    this.handlers = handlers;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.handlers.onClose?.();
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.handlers.onError?.('WebSocket connection error');
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
        this.handlers.onConnected?.(
          message.payload as { client_id: string; user_id: string; role: string }
        );
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
        this.handlers.onError?.((message.payload as { message: string }).message || 'Unknown error');
        break;

      default:
        console.log('Unknown WebSocket message type:', message.type);
    }
  }

  /**
   * Attempts to reconnect with exponential backoff.
   * Gives up after max attempts to prevent infinite loops.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting to reconnect in ${delay}ms...`);

    setTimeout(() => {
      if (this.token && this.handlers) {
        this.connect(this.token, this.handlers);
      }
    }, delay);
  }

  /**
   * Sends a message through the WebSocket connection.
   * Logs a warning if the connection is not open.
   *
   * @param message - Message to send (will be JSON stringified)
   */
  send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not connected');
    }
  }

  /**
   * Subscribes to real-time updates for a specific order.
   * Customer receives status updates and driver location.
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
   * Call when leaving order tracking page or order is completed.
   */
  unsubscribeFromOrder(): void {
    this.send({
      type: 'unsubscribe_order',
    });
  }

  /**
   * Subscribes driver to receive real-time delivery offers.
   * Should be called when driver goes online.
   */
  subscribeToDriverOffers(): void {
    this.send({
      type: 'subscribe_driver_offers',
    });
  }

  /**
   * Sends driver's current location through WebSocket.
   * Alternative to HTTP API for frequent location updates.
   *
   * @param lat - Current latitude
   * @param lng - Current longitude
   * @param speed - Optional current speed
   * @param heading - Optional heading direction
   */
  updateLocation(lat: number, lng: number, speed?: number, heading?: number): void {
    this.send({
      type: 'update_location',
      payload: { lat, lng, speed, heading },
    });
  }

  /**
   * Closes the WebSocket connection and cleans up state.
   * Call when user logs out or navigates away from real-time features.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.token = null;
    this.handlers = {};
  }

  /**
   * Checks if the WebSocket connection is currently open.
   *
   * @returns True if connected and ready to send/receive
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

/**
 * Singleton WebSocket service instance.
 * Import and use this instance throughout the application.
 */
export const wsService = new WebSocketService();
