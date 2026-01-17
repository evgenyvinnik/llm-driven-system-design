import type { WebSocketMessage } from '../types';

type MessageHandler = (message: WebSocketMessage) => void;

class SignalingService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageHandlers: Set<MessageHandler> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private userId: string | null = null;
  private deviceId: string | null = null;

  connect(userId: string, deviceId?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.userId = userId;
      this.deviceId = deviceId || this.generateDeviceId();

      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;

        // Register with server
        this.send({
          type: 'register',
          userId: this.userId!,
          deviceId: this.deviceId!,
          data: { deviceType: this.getDeviceType() },
        });

        // Start ping interval
        this.pingInterval = setInterval(() => {
          this.send({ type: 'ping' });
        }, 30000);

        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          this.messageHandlers.forEach((handler) => handler(message));
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.cleanup();
        this.attemptReconnect();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };
    });
  }

  disconnect(): void {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting reconnection in ${delay}ms...`);
    setTimeout(() => {
      if (this.userId) {
        this.connect(this.userId, this.deviceId || undefined);
      }
    }, delay);
  }

  send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket not connected');
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // Call methods
  initiateCall(calleeIds: string[], callType: 'video' | 'audio'): void {
    this.send({
      type: 'call_initiate',
      data: { calleeIds, callType },
    });
  }

  answerCall(callId: string): void {
    this.send({
      type: 'call_answer',
      callId,
    });
  }

  declineCall(callId: string): void {
    this.send({
      type: 'call_decline',
      callId,
    });
  }

  endCall(callId: string): void {
    this.send({
      type: 'call_end',
      callId,
    });
  }

  // WebRTC signaling
  sendOffer(callId: string, offer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'offer',
      callId,
      data: offer,
    });
  }

  sendAnswer(callId: string, answer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'answer',
      callId,
      data: answer,
    });
  }

  sendIceCandidate(callId: string, candidate: RTCIceCandidate): void {
    this.send({
      type: 'ice_candidate',
      callId,
      data: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
    });
  }

  private generateDeviceId(): string {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
  }

  private getDeviceType(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (/mobile|android|iphone|ipad|ipod/.test(ua)) {
      return /ipad|tablet/.test(ua) ? 'tablet' : 'mobile';
    }
    return 'desktop';
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const signalingService = new SignalingService();
