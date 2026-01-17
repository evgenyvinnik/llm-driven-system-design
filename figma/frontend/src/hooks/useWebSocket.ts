/**
 * React hook for WebSocket-based real-time collaboration.
 * Manages connection lifecycle, message handling, and provides methods
 * for sending operations and presence updates to other collaborators.
 */
import { useEffect, useRef, useCallback } from 'react';
import type { WSMessage, PresenceState, Operation, CanvasData } from '../types';
import { useEditorStore, setOperationSender } from '../stores/editorStore';
import { applyOperation } from '../services/operationApplier';

/**
 * Custom hook for WebSocket real-time collaboration.
 * Automatically connects when fileId is provided, handles reconnection,
 * and processes incoming messages for state synchronization.
 * @param fileId - The file ID to subscribe to, or null to disconnect
 * @returns Object with sendOperation and sendPresence functions
 */
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

  /**
   * Handles incoming WebSocket messages and updates state accordingly.
   * Processes sync, operation, presence, ack, and error message types.
   * @param message - The parsed WebSocket message
   */
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
        const state = useEditorStore.getState();

        // Filter out own operations (already applied optimistically)
        const remoteOps = payload.operations.filter(
          (op) => op.userId !== state.userId
        );

        // Apply each remote operation to the canvas data
        if (remoteOps.length > 0) {
          let currentData = state.canvasData;
          for (const op of remoteOps) {
            currentData = applyOperation(currentData, op);
          }
          // Update store with new canvas data (don't push to history for remote changes)
          useEditorStore.setState({ canvasData: currentData });
        }
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

  /**
   * Sends design operations to the server for broadcast to other clients.
   * @param operations - Array of operations to send
   */
  const sendOperation = useCallback((operations: Operation[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message: WSMessage = {
        type: 'operation',
        payload: { operations },
      };
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  /**
   * Sends presence updates (cursor position, selection) to other collaborators.
   * @param cursor - Current cursor position in canvas coordinates
   * @param selection - Array of currently selected object IDs
   */
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
    // Register the sendOperation function with the store so it can send operations
    setOperationSender(sendOperation);
    connect();

    return () => {
      setOperationSender(null);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect, sendOperation]);

  return { sendOperation, sendPresence };
}
