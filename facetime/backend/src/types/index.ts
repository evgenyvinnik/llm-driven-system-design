/**
 * Represents a registered user in the FaceTime system.
 * Stores user identity and profile information used for
 * authentication, display, and contact management.
 */
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

/**
 * Represents a device registered to a user for receiving calls.
 * Tracks device type and online status to support multi-device
 * call delivery and presence indication.
 */
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

/**
 * Represents a video/audio call session.
 * Tracks call lifecycle from initiation through completion,
 * including state transitions, timing, and participant limits.
 */
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

/**
 * Represents a user's participation in a call.
 * Tracks individual participant state, join/leave times,
 * and role (initiator vs recipient) within a call.
 */
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

/**
 * Enumeration of all WebSocket message types used in signaling.
 * Covers the complete call lifecycle including registration,
 * call control, and WebRTC offer/answer/ICE exchange.
 */
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

/**
 * Generic WebSocket message structure for signaling communication.
 * All signaling messages follow this format for consistent parsing
 * and routing on both client and server.
 */
export interface WebSocketMessage {
  type: WebSocketMessageType;
  callId?: string;
  userId?: string;
  deviceId?: string;
  data?: unknown;
  timestamp?: number;
}

/**
 * WebRTC SDP offer for initiating peer connection.
 * Sent from caller to callee to propose media capabilities.
 */
export interface SignalingOffer {
  sdp: string;
  type: 'offer';
}

/**
 * WebRTC SDP answer responding to an offer.
 * Sent from callee to caller to confirm media negotiation.
 */
export interface SignalingAnswer {
  sdp: string;
  type: 'answer';
}

/**
 * ICE candidate for NAT traversal in WebRTC.
 * Contains connection information discovered through
 * STUN/TURN servers for establishing peer connectivity.
 */
export interface ICECandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/**
 * Data payload for initiating a new call.
 * Specifies target users and call modality (video/audio).
 */
export interface CallInitiateData {
  calleeIds: string[];
  callType: 'video' | 'audio';
}

/**
 * Data payload for answering a call.
 * Indicates whether the callee accepts the call.
 */
export interface CallAnswerData {
  callId: string;
  accept: boolean;
}

/**
 * Represents a connected WebSocket client.
 * Tracks the socket connection, user identity, device info,
 * and last heartbeat for connection health monitoring.
 */
export interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  deviceType: string;
  lastPing: number;
}
