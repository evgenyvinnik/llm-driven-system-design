import { useEffect, useRef, useCallback } from 'react';
import type { WSMessage, PresenceState, Operation, CanvasData } from '../types';
import { useEditorStore } from '../stores/editorStore';

export function useWebSocket(fileId: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const {
    userId,
    userName,
    setCanvasData,
    setFileName,
    setCollaborators,
    updateCollaborator,
    removeCollaborator,
    setUserInfo,
  } = useEditorStore();

  const connect = useCallback(() => {
    if (!fileId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');

      // Subscribe to file
      const subscribeMessage: WSMessage = {
        type: 'subscribe',
        payload: {
          fileId,
          userId,
          userName,
        },
      };
      ws.send(JSON.stringify(subscribeMessage));
    };

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Attempt to reconnect after 3 seconds
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connect();
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [fileId, userId, userName]);

  const handleMessage = useCallback((message: WSMessage) => {
    switch (message.type) {
      case 'sync': {
        const payload = message.payload as {
          file: { id: string; name: string; canvas_data: CanvasData };
          presence: PresenceState[];
          yourColor?: string;
        };
        setCanvasData(payload.file.canvas_data);
        setFileName(payload.file.name);
        if (payload.presence) {
          // Filter out self
          setCollaborators(payload.presence.filter(p => p.userId !== userId));
        }
        if (payload.yourColor) {
          setUserInfo(userId, userName, payload.yourColor);
        }
        break;
      }
      case 'operation': {
        const payload = message.payload as { operations: Operation[] };
        // Apply operations from other users
        // For now, we'll refetch state on operation
        // A proper implementation would apply operations incrementally
        break;
      }
      case 'presence': {
        const payload = message.payload as {
          presence?: PresenceState[];
          removed?: string[];
        };
        if (payload.presence) {
          payload.presence.forEach(p => {
            if (p.userId !== userId) {
              updateCollaborator(p);
            }
          });
        }
        if (payload.removed) {
          payload.removed.forEach(id => removeCollaborator(id));
        }
        break;
      }
      case 'ack':
        // Operation acknowledged
        break;
      case 'error': {
        const payload = message.payload as { error: string };
        console.error('WebSocket error:', payload.error);
        break;
      }
    }
  }, [userId, userName, setCanvasData, setFileName, setCollaborators, updateCollaborator, removeCollaborator, setUserInfo]);

  const sendOperation = useCallback((operations: Operation[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: WSMessage = {
        type: 'operation',
        payload: { operations },
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendPresence = useCallback((cursor?: { x: number; y: number }, selection?: string[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: WSMessage = {
        type: 'presence',
        payload: {
          cursor,
          selection,
        },
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return { sendOperation, sendPresence };
}
