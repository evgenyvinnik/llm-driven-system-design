/**
 * API Service Module
 *
 * HTTP client functions for communicating with the Baby Discord backend.
 * All functions use the fetch API and handle JSON serialization.
 * The API_BASE is relative to enable Vite proxy configuration.
 */

import type { ApiResponse, Room, Message, Session } from '../types';

/** Base URL for API requests (proxied by Vite in development) */
const API_BASE = '/api';

/**
 * Connect to the chat server with a nickname.
 * Creates a user if needed and returns a session token.
 *
 * @param nickname - Desired display name (2-50 characters)
 * @returns Session object containing sessionId, userId, and nickname
 * @throws Error if connection fails or nickname is invalid
 */
export async function connect(nickname: string): Promise<Session> {
  const response = await fetch(`${API_BASE}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });

  const data: ApiResponse<Session> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to connect');
  }

  return data.data;
}

/**
 * Disconnect from the chat server.
 * Ends the session and leaves any active rooms.
 *
 * @param sessionId - Session token to invalidate
 */
export async function disconnect(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * Execute a slash command on the server.
 * Commands include /join, /leave, /create, /nick, /help, etc.
 *
 * @param sessionId - Session token for authentication
 * @param command - Command string (e.g., "/join general")
 * @returns API response with command result
 */
export async function executeCommand(
  sessionId: string,
  command: string
): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, command }),
  });

  return response.json();
}

/**
 * Send a chat message to the current room.
 *
 * @param sessionId - Session token for authentication
 * @param content - Message text to send
 * @returns API response with message ID on success
 */
export async function sendMessage(
  sessionId: string,
  content: string
): Promise<ApiResponse> {
  const response = await fetch(`${API_BASE}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content }),
  });

  return response.json();
}

/**
 * Get list of all available chat rooms.
 *
 * @returns Array of Room objects with member counts
 * @throws Error if request fails
 */
export async function getRooms(): Promise<Room[]> {
  const response = await fetch(`${API_BASE}/rooms`);
  const data: ApiResponse<{ rooms: Room[] }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to get rooms');
  }

  return data.data.rooms;
}

/**
 * Get message history for a specific room.
 * Returns the last 10 messages in chronological order.
 *
 * @param roomName - Name of the room to get history for
 * @returns Array of Message objects
 * @throws Error if room not found or request fails
 */
export async function getRoomHistory(roomName: string): Promise<Message[]> {
  const response = await fetch(`${API_BASE}/rooms/${roomName}/history`);
  const data: ApiResponse<{ messages: Message[] }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to get history');
  }

  return data.data.messages;
}

/**
 * Get session details by session ID.
 * Used to restore sessions from localStorage.
 *
 * @param sessionId - Session token to look up
 * @returns Session object if valid, null if expired/invalid
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  const response = await fetch(`${API_BASE}/session/${sessionId}`);

  if (!response.ok) {
    return null;
  }

  const data: ApiResponse<Session> = await response.json();
  return data.data || null;
}

/**
 * Create an SSE (Server-Sent Events) connection for real-time messages.
 * The connection receives messages as they are sent to the room.
 *
 * @param room - Room name to subscribe to
 * @param sessionId - Session token for authentication
 * @param onMessage - Callback for incoming messages
 * @param onError - Callback for connection errors
 * @returns EventSource that must be closed when leaving the room
 */
export function createSSEConnection(
  room: string,
  sessionId: string,
  onMessage: (message: Message) => void,
  onError: (error: Event) => void
): EventSource {
  const eventSource = new EventSource(
    `${API_BASE}/messages/${room}?sessionId=${sessionId}`
  );

  eventSource.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      onMessage(message);
    } catch {
      // Handle plain text messages
      onMessage({
        room,
        user: 'system',
        content: event.data,
        timestamp: new Date().toISOString(),
      });
    }
  });

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected to room:', room);
  });

  eventSource.addEventListener('error', onError);

  return eventSource;
}
