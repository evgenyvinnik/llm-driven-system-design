export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role?: 'user' | 'admin';
}

export interface CallState {
  callId: string;
  caller: User | null;
  callees: User[];
  callType: 'video' | 'audio';
  state: 'idle' | 'initiating' | 'ringing' | 'connecting' | 'connected' | 'ended';
  direction: 'incoming' | 'outgoing';
  startTime: number | null;
  isGroup: boolean;
}

export interface WebSocketMessage {
  type: string;
  callId?: string;
  userId?: string;
  data?: unknown;
  timestamp?: number;
}

export interface ICEServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCredentials {
  iceServers: ICEServer[];
}

export interface CallHistoryItem {
  id: string;
  initiator_id: string;
  call_type: 'video' | 'audio' | 'group';
  state: string;
  duration_seconds: number | null;
  created_at: string;
  participants: {
    user_id: string;
    state: string;
    is_initiator: boolean;
    user: User;
  }[];
}
