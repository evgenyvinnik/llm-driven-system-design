export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface UserDevice {
  id: string;
  user_id: string;
  device_name: string;
  device_type: 'desktop' | 'mobile' | 'tablet';
  push_token: string | null;
  is_active: boolean;
  last_seen: Date;
  created_at: Date;
}

export interface Call {
  id: string;
  initiator_id: string;
  call_type: 'video' | 'audio' | 'group';
  state: 'ringing' | 'connected' | 'ended' | 'missed' | 'declined';
  room_id: string | null;
  max_participants: number;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
}

export interface CallParticipant {
  id: string;
  call_id: string;
  user_id: string;
  device_id: string | null;
  state: 'ringing' | 'connected' | 'left' | 'declined';
  is_initiator: boolean;
  joined_at: Date | null;
  left_at: Date | null;
  created_at: Date;
}

// WebSocket message types
export type WebSocketMessageType =
  | 'register'
  | 'call_initiate'
  | 'call_ring'
  | 'call_answer'
  | 'call_decline'
  | 'call_end'
  | 'call_busy'
  | 'offer'
  | 'answer'
  | 'ice_candidate'
  | 'user_joined'
  | 'user_left'
  | 'error'
  | 'ping'
  | 'pong';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  callId?: string;
  userId?: string;
  deviceId?: string;
  data?: unknown;
  timestamp?: number;
}

export interface SignalingOffer {
  sdp: string;
  type: 'offer';
}

export interface SignalingAnswer {
  sdp: string;
  type: 'answer';
}

export interface ICECandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface CallInitiateData {
  calleeIds: string[];
  callType: 'video' | 'audio';
}

export interface CallAnswerData {
  callId: string;
  accept: boolean;
}

export interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  deviceType: string;
  lastPing: number;
}
