export interface User {
  id: number;
  nickname: string;
}

export interface Room {
  name: string;
  memberCount: number;
  createdAt: string;
}

export interface Message {
  id?: number;
  room: string;
  user: string;
  content: string;
  timestamp: string;
  messageId?: number;
}

export interface Session {
  sessionId: string;
  userId: number;
  nickname: string;
  currentRoom: string | null;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
