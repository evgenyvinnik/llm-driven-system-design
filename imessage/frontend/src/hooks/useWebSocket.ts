import { useEffect, useRef, useSyncExternalStore } from 'react';
import { wsService } from '@/services/websocket';
import { useChatStore } from '@/stores/chatStore';
import type { ConnectionStatus, WebSocketMessage } from '@/types';

/**
 * React hook that bridges the WebSocket service with the chat store.
 * Sets up a subscription to incoming WebSocket messages and routes them
 * to the chat store's message handler for state updates.
 *
 * This hook should be used once in the main app component to ensure
 * all real-time updates (new messages, typing indicators, reactions, etc.)
 * are processed and reflected in the UI.
 *
 * @returns Object containing convenience methods for sending WebSocket messages:
 *   - sendMessage: Send a chat message
 *   - sendTyping: Send typing indicator
 *   - sendRead: Send read receipt
 *   - sendReaction: Add/remove emoji reaction
 *   - isConnected: Current connection status
 */
export function useWebSocket() {
  const handleMessage = useChatStore((state) => state.handleWebSocketMessage);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const unsubscribe = wsService.subscribe((message: WebSocketMessage) => {
      handleMessage(message);
    });

    return () => {
      unsubscribe();
      initialized.current = false;
    };
  }, [handleMessage]);

  return {
    sendMessage: wsService.sendMessage.bind(wsService),
    sendTyping: wsService.sendTyping.bind(wsService),
    sendRead: wsService.sendRead.bind(wsService),
    sendReaction: wsService.sendReaction.bind(wsService),
    isConnected: wsService.isConnected(),
  };
}

/**
 * Current WebSocket connection status, re-rendering on every change. Used to
 * tell the user that messages are queued while the connection is down.
 */
export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(
    (onChange) => wsService.subscribeStatus(onChange),
    () => wsService.getStatus()
  );
}
