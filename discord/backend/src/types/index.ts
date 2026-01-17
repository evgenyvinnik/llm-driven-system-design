// Type definitions for Baby Discord

export interface User {
  id: number;
  nickname: string;
  createdAt: Date;
}

export interface Room {
  id: number;
  name: string;
  createdBy: number | null;
  createdAt: Date;
}

export interface Message {
  id: number;
  roomId: number;
  userId: number | null;
  content: string;
  createdAt: Date;
  // Denormalized for convenience
  nickname?: string;
  roomName?: string;
}

export interface RoomMember {
  roomId: number;
  userId: number;
  joinedAt: Date;
}

export type TransportType = 'tcp' | 'http';

export interface Session {
  sessionId: string;
  userId: number;
  nickname: string;
  currentRoom: string | null;
  transport: TransportType;
  sendMessage: (msg: string) => void;
  createdAt: Date;
}

export type CommandType =
  | 'help'
  | 'nick'
  | 'list'
  | 'quit'
  | 'create'
  | 'join'
  | 'rooms'
  | 'leave'
  | 'message'
  | 'dm';

export interface ParsedCommand {
  type: CommandType;
  args: string[];
  raw: string;
}

export interface CommandResult {
  success: boolean;
  message: string;
  broadcast?: {
    room: string;
    content: string;
    excludeSender?: boolean;
  };
  data?: Record<string, unknown>;
}

export interface ChatMessage {
  room: string;
  user: string;
  content: string;
  timestamp: Date;
  messageId?: number;
}

export interface PresenceUpdate {
  type: 'join' | 'leave' | 'nick_change';
  room: string;
  user: string;
  oldNick?: string;
}

// Redis pub/sub message types
export interface PubSubMessage {
  type: 'chat' | 'presence' | 'system';
  instanceId: string;
  payload: ChatMessage | PresenceUpdate | { message: string };
  room: string;
  timestamp: number;
}

// API types
export interface ConnectRequest {
  nickname: string;
}

export interface ConnectResponse {
  sessionId: string;
  userId: number;
  nickname: string;
}

export interface CommandRequest {
  sessionId: string;
  command: string;
}

export interface MessageRequest {
  sessionId: string;
  content: string;
}

export interface RoomInfo {
  name: string;
  memberCount: number;
  createdAt: Date;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}
