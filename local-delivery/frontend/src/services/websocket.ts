import type { WSMessage, LocationUpdatePayload, StatusUpdatePayload, NewOfferPayload } from '@/types';

export type WSEventHandler = {
  onLocationUpdate?: (payload: LocationUpdatePayload) => void;
  onStatusUpdate?: (payload: StatusUpdatePayload) => void;
  onNewOffer?: (payload: NewOfferPayload) => void;
  onConnected?: (data: { client_id: string; user_id: string; role: string }) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

export class WebSocketService {
  private ws: WebSocket | null = null;
  private handlers: WSEventHandler = {};
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private token: string | null = null;

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

  send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not connected');
    }
  }

  subscribeToOrder(orderId: string): void {
    this.send({
      type: 'subscribe_order',
      payload: { order_id: orderId },
    });
  }

  unsubscribeFromOrder(): void {
    this.send({
      type: 'unsubscribe_order',
    });
  }

  subscribeToDriverOffers(): void {
    this.send({
      type: 'subscribe_driver_offers',
    });
  }

  updateLocation(lat: number, lng: number, speed?: number, heading?: number): void {
    this.send({
      type: 'update_location',
      payload: { lat, lng, speed, heading },
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.token = null;
    this.handlers = {};
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const wsService = new WebSocketService();
