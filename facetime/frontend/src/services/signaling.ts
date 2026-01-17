/**
 * Signaling Service Module
 *
 * Manages WebSocket connection to the signaling server for real-time
 * call coordination. Handles connection lifecycle, message routing,
 * and provides methods for call control and WebRTC signaling.
 */

import type { WebSocketMessage } from '../types';

/** Callback type for handling incoming WebSocket messages */
type MessageHandler = (message: WebSocketMessage) => void;

/**
 * Singleton class managing WebSocket connection for call signaling.
 * Handles automatic reconnection, heartbeat pings, and message routing.
 */
class SignalingService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private messageHandlers: Set<MessageHandler> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private userId: string | null = null;
  private deviceId: string | null = null;

  /**
   * Establishes WebSocket connection to the signaling server.
   * Registers the user and device, sets up heartbeat pings,
   * and configures automatic reconnection on disconnect.
   *
   * @param userId - The authenticated user's ID
   * @param deviceId - Optional device ID (generated if not provided)
   * @returns Promise that resolves when connection is established
   */
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

  /**
   * Closes the WebSocket connection and cleans up resources.
   * Called when user logs out or component unmounts.
   */
  disconnect(): void {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Clears ping interval timer */
  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /** Attempts to reconnect with exponential backoff */
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

  /**
   * Sends a message through the WebSocket connection.
   *
   * @param message - The message to send
   */
  send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('WebSocket not connected');
    }
  }

  /**
   * Registers a handler for incoming WebSocket messages.
   *
   * @param handler - Callback function to invoke on each message
   * @returns Unsubscribe function to remove the handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Initiates a call to one or more users.
   *
   * @param calleeIds - Array of user IDs to call
   * @param callType - Type of call: 'video' or 'audio'
   */
  initiateCall(calleeIds: string[], callType: 'video' | 'audio'): void {
    this.send({
      type: 'call_initiate',
      data: { calleeIds, callType },
    });
  }

  /**
   * Answers an incoming call.
   *
   * @param callId - The ID of the call to answer
   */
  answerCall(callId: string): void {
    this.send({
      type: 'call_answer',
      callId,
    });
  }

  /**
   * Declines an incoming call.
   *
   * @param callId - The ID of the call to decline
   */
  declineCall(callId: string): void {
    this.send({
      type: 'call_decline',
      callId,
    });
  }

  /**
   * Ends an active call.
   *
   * @param callId - The ID of the call to end
   */
  endCall(callId: string): void {
    this.send({
      type: 'call_end',
      callId,
    });
  }

  /**
   * Sends WebRTC SDP offer to the peer.
   *
   * @param callId - The call ID
   * @param offer - The SDP offer description
   */
  sendOffer(callId: string, offer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'offer',
      callId,
      data: offer,
    });
  }

  /**
   * Sends WebRTC SDP answer to the peer.
   *
   * @param callId - The call ID
   * @param answer - The SDP answer description
   */
  sendAnswer(callId: string, answer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'answer',
      callId,
      data: answer,
    });
  }

  /**
   * Sends an ICE candidate to the peer for NAT traversal.
   *
   * @param callId - The call ID
   * @param candidate - The ICE candidate
   */
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

  /**
   * Generates or retrieves a persistent device ID from localStorage.
   *
   * @returns The device ID string
   */
  private generateDeviceId(): string {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
      deviceId = crypto.randomUUID();
      localStorage.setItem('deviceId', deviceId);
    }
    return deviceId;
  }

  /**
   * Detects device type from user agent.
   *
   * @returns Device type: 'desktop', 'mobile', or 'tablet'
   */
  private getDeviceType(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (/mobile|android|iphone|ipad|ipod/.test(ua)) {
      return /ipad|tablet/.test(ua) ? 'tablet' : 'mobile';
    }
    return 'desktop';
  }

  /**
   * Checks if WebSocket is currently connected.
   *
   * @returns True if connected and ready
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

/** Singleton instance of the signaling service */
export const signalingService = new SignalingService();
