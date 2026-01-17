import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  WSMessage,
  CommentsBatchPayload,
  ReactionsBatchPayload,
  ViewerCountPayload,
  ErrorPayload,
  ReactionType,
} from '../types';

const WS_URL = `ws://${window.location.hostname}:3001`;

export function useWebSocket(streamId: string | null, userId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  const {
    setIsConnected,
    addComments,
    addReactionCounts,
    setViewerCount,
    addFloatingReaction,
  } = useAppStore();

  const connect = useCallback(() => {
    if (!streamId || !userId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    console.log('Connecting to WebSocket...');
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);

      // Join the stream
      ws.send(
        JSON.stringify({
          type: 'join_stream',
          payload: { stream_id: streamId, user_id: userId },
        })
      );

      // Start ping interval
      pingIntervalRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 25000);
    };

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Attempt to reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }, [streamId, userId, setIsConnected]);

  const handleMessage = (message: WSMessage) => {
    switch (message.type) {
      case 'comments_batch': {
        const payload = message.payload as CommentsBatchPayload;
        addComments(payload.comments);
        break;
      }
      case 'reactions_batch': {
        const payload = message.payload as ReactionsBatchPayload;
        addReactionCounts(payload.counts);
        // Add floating reactions for animation
        for (const [type, count] of Object.entries(payload.counts)) {
          // Limit to 10 floating reactions per batch for performance
          const displayCount = Math.min(count, 10);
          for (let i = 0; i < displayCount; i++) {
            addFloatingReaction(type);
          }
        }
        break;
      }
      case 'viewer_count': {
        const payload = message.payload as ViewerCountPayload;
        setViewerCount(payload.count);
        break;
      }
      case 'error': {
        const payload = message.payload as ErrorPayload;
        console.error('WebSocket error:', payload.code, payload.message);
        break;
      }
      case 'pong':
        // Heartbeat response
        break;
      default:
        console.log('Unknown message type:', message.type);
    }
  };

  const sendComment = useCallback(
    (content: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        return;
      }

      wsRef.current.send(
        JSON.stringify({
          type: 'post_comment',
          payload: {
            stream_id: streamId,
            user_id: userId,
            content,
          },
        })
      );
    },
    [streamId, userId]
  );

  const sendReaction = useCallback(
    (reactionType: ReactionType) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        console.error('WebSocket not connected');
        return;
      }

      wsRef.current.send(
        JSON.stringify({
          type: 'react',
          payload: {
            stream_id: streamId,
            user_id: userId,
            reaction_type: reactionType,
          },
        })
      );
    },
    [streamId, userId]
  );

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { sendComment, sendReaction };
}
