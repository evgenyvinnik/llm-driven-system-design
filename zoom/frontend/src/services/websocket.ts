type MessageHandler = (message: Record<string, unknown>) => void;

interface JoinRequest {
  meetingCode: string;
  displayName: string;
  muted: boolean;
  videoOn: boolean;
}

/**
 * Close codes >= 4000 are deliberate server decisions (not signed in, replaced by
 * another window, removed by the host); reconnecting would only repeat them.
 */
const isFinalClose = (code: number) => code >= 4000 || code === 1000;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private shouldReconnect = false;
  /** The meeting to re-enter after a reconnect; cleared on leave or a final close. */
  private currentJoin: JoinRequest | null = null;

  /**
   * Opens the signaling socket. Identity comes from the session cookie the
   * browser sends on the upgrade; the client no longer names itself.
   */
  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.reconnectAttempts = 0;
        // The server freed nothing yet if we are back inside its grace window:
        // re-sending the join resumes the same seat and role.
        if (this.currentJoin) this.send({ type: 'join-meeting', ...this.currentJoin });
        resolve();
      };

      ws.onerror = (err) => {
        if (this.ws !== ws) return;
        console.error('WebSocket error:', err);
        reject(err);
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        try {
          this.dispatch(JSON.parse(event.data));
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.dispatch({ type: 'connection-closed', code: event.code, reason: event.reason });
        if (isFinalClose(event.code)) {
          this.currentJoin = null;
          return;
        }
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.attemptReconnect();
        }
      };
    });
  }

  private attemptReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (!this.shouldReconnect) return;
      this.connect().catch((err) => {
        console.error('Reconnection failed:', err);
      });
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    this.currentJoin = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close(1000, 'Client disconnect');
  }

  /** Stops re-joining on reconnect (meeting ended, denied, removed). */
  forgetMeeting() {
    this.currentJoin = null;
  }

  send(message: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, cannot send:', message);
    }
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  off(type: string, handler: MessageHandler) {
    const handlers = this.handlers.get(type);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  private dispatch(message: Record<string, unknown>) {
    const type = message.type as string;
    for (const handler of [...(this.handlers.get(type) ?? []), ...(this.handlers.get('*') ?? [])]) {
      handler(message);
    }
  }

  // Signaling methods
  joinMeeting(meetingCode: string, displayName: string, muted: boolean, videoOn: boolean) {
    this.currentJoin = { meetingCode, displayName, muted, videoOn };
    this.send({ type: 'join-meeting', ...this.currentJoin });
  }

  leaveMeeting() {
    this.currentJoin = null;
    this.send({ type: 'leave-meeting' });
  }

  produce(kind: 'audio' | 'video' | 'screen', rtpParameters?: unknown) {
    this.send({ type: 'produce', kind, rtpParameters: rtpParameters || {} });
  }

  consume(producerId: string) {
    this.send({ type: 'consume', producerId });
  }

  closeProducer(producerId: string) {
    this.send({ type: 'producer-close', producerId });
  }

  toggleMute(muted: boolean) {
    this.send({ type: 'toggle-mute', muted });
  }

  toggleVideo(videoOn: boolean) {
    this.send({ type: 'toggle-video', videoOn });
  }

  startScreenShare() {
    this.send({ type: 'start-screen-share' });
  }

  stopScreenShare() {
    this.send({ type: 'stop-screen-share' });
  }

  raiseHand(raised: boolean) {
    this.send({ type: 'raise-hand', raised });
  }

  sendChatMessage(content: string, recipientId?: string) {
    this.send({ type: 'chat-message', content, recipientId });
  }

  // Host controls (the server checks the caller's role for each)
  admitParticipant(userId: string) {
    this.send({ type: 'admit-participant', userId });
  }

  denyParticipant(userId: string) {
    this.send({ type: 'deny-participant', userId });
  }

  muteParticipant(userId: string) {
    this.send({ type: 'mute-participant', userId });
  }

  muteAll() {
    this.send({ type: 'mute-all' });
  }

  removeParticipant(userId: string) {
    this.send({ type: 'remove-participant', userId });
  }

  transferHost(userId: string) {
    this.send({ type: 'transfer-host', userId });
  }

  setRole(userId: string, role: 'co-host' | 'participant') {
    this.send({ type: 'set-role', userId, role });
  }

  lockMeeting(locked: boolean) {
    this.send({ type: 'lock-meeting', locked });
  }

  endMeeting() {
    this.send({ type: 'end-meeting' });
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

/** Singleton WebSocket client for real-time meeting signaling and chat. */
export const wsClient = new WebSocketClient();
