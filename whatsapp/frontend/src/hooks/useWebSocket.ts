import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import {
  WSMessage,
  WSMessageAck,
  WSDeliveryReceipt,
  WSTypingEvent,
  WSPresenceEvent,
  WSIncomingMessage,
  Message,
} from '../types';

let wsInstance: WebSocket | null = null;
let reconnectTimeout: number | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;

export function useWebSocket() {
  const { user } = useAuthStore();
  const {
    addMessage,
    updateMessageId,
    updateMessageStatus,
    markMessagesAsRead,
    setTyping,
    updatePresence,
    currentConversationId,
    updateConversationLastMessage,
    loadConversations,
  } = useChatStore();

  const currentConversationIdRef = useRef(currentConversationId);
  currentConversationIdRef.current = currentConversationId;

  const connect = useCallback(() => {
    if (!user) return;
    if (wsInstance?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    console.log('Connecting to WebSocket:', wsUrl);
    wsInstance = new WebSocket(wsUrl);

    wsInstance.onopen = () => {
      console.log('WebSocket connected');
      reconnectAttempts = 0;
    };

    wsInstance.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    };

    wsInstance.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      wsInstance = null;

      // Reconnect if we have a user and haven't exceeded attempts
      if (user && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
        reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        reconnectTimeout = window.setTimeout(connect, delay);
      }
    };

    wsInstance.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }, [user]);

  const handleMessage = useCallback(
    (message: WSMessage) => {
      switch (message.type) {
        case 'message': {
          const msg = message as WSIncomingMessage;
          const newMessage: Message = {
            ...msg.payload,
            status: 'delivered',
          };
          addMessage(newMessage);
          updateConversationLastMessage(newMessage.conversation_id, newMessage);

          // If viewing this conversation, mark as read
          if (currentConversationIdRef.current === newMessage.conversation_id) {
            sendReadReceipt(newMessage.conversation_id, [newMessage.id]);
          }

          // Refresh conversations to update unread count
          loadConversations();
          break;
        }

        case 'message_ack': {
          const ack = message as WSMessageAck;
          updateMessageId(
            ack.payload.clientMessageId,
            ack.payload.messageId,
            ack.payload.createdAt
          );
          break;
        }

        case 'delivery_receipt': {
          const receipt = message as WSDeliveryReceipt;
          updateMessageStatus(receipt.payload.messageId, 'delivered');
          break;
        }

        case 'read_receipt': {
          const readReceipt = message as WSDeliveryReceipt;
          const messageIds = readReceipt.payload.messageIds || [readReceipt.payload.messageId];
          // Find conversation for these messages and update
          for (const msgId of messageIds) {
            updateMessageStatus(msgId, 'read');
          }
          break;
        }

        case 'typing':
        case 'stop_typing': {
          const typingEvent = message as WSTypingEvent;
          setTyping(
            typingEvent.payload.conversationId,
            typingEvent.payload.userId,
            message.type === 'typing'
          );
          break;
        }

        case 'presence': {
          const presenceEvent = message as WSPresenceEvent;
          updatePresence(
            presenceEvent.payload.userId,
            presenceEvent.payload.status,
            presenceEvent.payload.timestamp
          );
          break;
        }

        case 'error': {
          console.error('WebSocket error from server:', message.payload);
          break;
        }
      }
    },
    [
      addMessage,
      updateMessageId,
      updateMessageStatus,
      markMessagesAsRead,
      setTyping,
      updatePresence,
      updateConversationLastMessage,
      loadConversations,
    ]
  );

  const disconnect = useCallback(() => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (wsInstance) {
      wsInstance.close();
      wsInstance = null;
    }
    reconnectAttempts = 0;
  }, []);

  useEffect(() => {
    if (user) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      // Don't disconnect on unmount if we still have a user
      // This allows the connection to persist across route changes
    };
  }, [user, connect, disconnect]);

  return {
    isConnected: wsInstance?.readyState === WebSocket.OPEN,
    sendMessage,
    sendTyping,
    sendReadReceipt,
  };
}

export function sendMessage(
  conversationId: string,
  content: string,
  clientMessageId: string
) {
  if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
    console.error('WebSocket not connected');
    return false;
  }

  wsInstance.send(
    JSON.stringify({
      type: 'message',
      payload: {
        conversationId,
        content,
        contentType: 'text',
      },
      clientMessageId,
    })
  );

  return true;
}

export function sendTyping(conversationId: string, isTyping: boolean) {
  if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
    return;
  }

  wsInstance.send(
    JSON.stringify({
      type: isTyping ? 'typing' : 'stop_typing',
      payload: {
        conversationId,
      },
    })
  );
}

export function sendReadReceipt(conversationId: string, messageIds: string[]) {
  if (!wsInstance || wsInstance.readyState !== WebSocket.OPEN) {
    return;
  }

  wsInstance.send(
    JSON.stringify({
      type: 'read_receipt',
      payload: {
        conversationId,
        messageIds,
      },
    })
  );
}
