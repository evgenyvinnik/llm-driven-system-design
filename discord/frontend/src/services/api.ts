import type { ApiResponse, Room, Message, Session } from '../types';

const API_BASE = '/api';

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

export async function disconnect(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

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

export async function getRooms(): Promise<Room[]> {
  const response = await fetch(`${API_BASE}/rooms`);
  const data: ApiResponse<{ rooms: Room[] }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to get rooms');
  }

  return data.data.rooms;
}

export async function getRoomHistory(roomName: string): Promise<Message[]> {
  const response = await fetch(`${API_BASE}/rooms/${roomName}/history`);
  const data: ApiResponse<{ messages: Message[] }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || 'Failed to get history');
  }

  return data.data.messages;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const response = await fetch(`${API_BASE}/session/${sessionId}`);

  if (!response.ok) {
    return null;
  }

  const data: ApiResponse<Session> = await response.json();
  return data.data || null;
}

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
