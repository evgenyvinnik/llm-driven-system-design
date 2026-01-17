/**
 * @fileoverview Custom React hook for WebSocket real-time communication.
 * Handles connection lifecycle, reconnection, heartbeat, and message dispatching
 * to the appropriate Zustand stores.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useMessageStore, usePresenceStore } from '../stores';
import type { WSMessage, Message } from '../types';

/**
 * Establishes and manages a WebSocket connection for real-time updates.
 * Automatically reconnects on disconnection after 3 seconds.
 * Dispatches incoming messages to the appropriate stores for state updates.
 *
 * @param userId - The authenticated user's ID. If undefined, no connection is made.
 * @param workspaceId - The workspace to connect to. If undefined, no connection is made.
 * @returns Object containing sendTyping function for typing indicator broadcasts
 */
export function useWebSocket(userId: string | undefined, workspaceId: string | undefined) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number>();
  const { addMessage, updateMessage, deleteMessage, addReaction, removeReaction, setTypingUsers } =
    useMessageStore();
  const { updatePresence } = usePresenceStore();

  /**
   * Establishes WebSocket connection with the server.
   * Sets up event handlers for open, close, error, and message events.
   * Automatically attempts reconnection on disconnect.
   */
  const connect = useCallback(() => {
    if (!userId || !workspaceId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?userId=${userId}&workspaceId=${workspaceId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
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
  }, [userId, workspaceId]);

  /**
   * Processes incoming WebSocket messages and routes them to appropriate handlers.
   * Updates stores for messages, reactions, presence, and typing indicators.
   * @param message - The parsed WebSocket message
   */
  const handleMessage = useCallback(
    (message: WSMessage) => {
      switch (message.type) {
        case 'message': {
          const msg = message.payload as Message;
          addMessage(msg);
          break;
        }
        case 'message_update': {
          const msg = message.payload as Message;
          updateMessage(msg);
          break;
        }
        case 'message_delete': {
          const { id, channel_id } = message.payload as { id: number; channel_id: string };
          deleteMessage(id, channel_id);
          break;
        }
        case 'reaction_add': {
          const { message_id, user_id, emoji } = message.payload as {
            message_id: number;
            user_id: string;
            emoji: string;
          };
          // Get channel_id from existing messages
          const allMessages = useMessageStore.getState().messages;
          for (const [channelId, messages] of Object.entries(allMessages)) {
            if (messages.some((m) => m.id === message_id)) {
              addReaction(message_id, channelId, user_id, emoji);
              break;
            }
          }
          break;
        }
        case 'reaction_remove': {
          const { message_id, user_id, emoji } = message.payload as {
            message_id: number;
            user_id: string;
            emoji: string;
          };
          const allMessages = useMessageStore.getState().messages;
          for (const [channelId, messages] of Object.entries(allMessages)) {
            if (messages.some((m) => m.id === message_id)) {
              removeReaction(message_id, channelId, user_id, emoji);
              break;
            }
          }
          break;
        }
        case 'typing': {
          const { channelId, userId: typingUserId } = message.payload as {
            channelId: string;
            userId: string;
          };
          const currentTyping = useMessageStore.getState().typingUsers[channelId] || [];
          if (!currentTyping.includes(typingUserId)) {
            setTypingUsers(channelId, [...currentTyping, typingUserId]);
            // Clear typing after 5 seconds
            setTimeout(() => {
              const updated = useMessageStore.getState().typingUsers[channelId] || [];
              setTypingUsers(
                channelId,
                updated.filter((id) => id !== typingUserId)
              );
            }, 5000);
          }
          break;
        }
        case 'presence': {
          const update = message.payload as { userId: string; status: string };
          updatePresence({
            userId: update.userId,
            status: update.status as 'online' | 'away' | 'offline',
          });
          break;
        }
        case 'connected':
          console.log('WebSocket authenticated');
          break;
        case 'pong':
          // Heartbeat response
          break;
        default:
          console.log('Unknown message type:', message.type);
      }
    },
    [addMessage, updateMessage, deleteMessage, addReaction, removeReaction, setTypingUsers, updatePresence]
  );

  /**
   * Sends a message over the WebSocket connection.
   * Silently fails if the connection is not open.
   * @param type - The message type
   * @param payload - The message payload
   */
  const sendMessage = useCallback((type: string, payload: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  /**
   * Broadcasts a typing indicator to other users in a channel.
   * @param channelId - The channel where the user is typing
   */
  const sendTyping = useCallback((channelId: string) => {
    sendMessage('typing', { channelId });
  }, [sendMessage]);

  useEffect(() => {
    connect();

    // Ping every 25 seconds to keep connection alive
    const pingInterval = setInterval(() => {
      sendMessage('ping', {});
    }, 25000);

    return () => {
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect, sendMessage]);

  return { sendTyping };
}
