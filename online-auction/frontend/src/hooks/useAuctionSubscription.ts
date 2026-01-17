import { useEffect, useCallback } from 'react';
import { useWebSocketStore } from '../stores/websocketStore';
import type { WebSocketMessage } from '../types';

export function useAuctionSubscription(
  auctionId: string,
  onMessage?: (message: WebSocketMessage) => void
) {
  const { subscribe, unsubscribe, addMessageListener, isConnected } = useWebSocketStore();

  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.auction_id === auctionId && onMessage) {
        onMessage(message);
      }
    },
    [auctionId, onMessage]
  );

  useEffect(() => {
    subscribe(auctionId);

    const removeListener = addMessageListener(handleMessage);

    return () => {
      unsubscribe(auctionId);
      removeListener();
    };
  }, [auctionId, subscribe, unsubscribe, addMessageListener, handleMessage]);

  return { isConnected };
}
