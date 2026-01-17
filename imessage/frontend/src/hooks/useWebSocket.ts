import { useEffect, useRef } from 'react';
import { wsService } from '@/services/websocket';
import { useChatStore } from '@/stores/chatStore';
import type { WebSocketMessage } from '@/types';

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
