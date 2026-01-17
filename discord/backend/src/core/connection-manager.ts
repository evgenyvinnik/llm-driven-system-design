/**
 * Connection Manager Module
 *
 * Manages active user sessions across all transport protocols (TCP and HTTP).
 * Provides a central registry of connected users with methods for session
 * lifecycle management, user lookup, and room membership tracking.
 *
 * Key responsibilities:
 * - Track active sessions by sessionId
 * - Map users to their sessions (supports multiple sessions per user)
 * - Track which room each session is currently in
 * - Provide session counts for monitoring
 */

import type { Session, TransportType } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Manages all active user sessions.
 *
 * Sessions are identified by UUID and can be accessed by sessionId or userId.
 * A single user can have multiple sessions (e.g., browser + netcat),
 * enabling multi-device usage.
 */
export class ConnectionManager {
  /** Map of sessionId to Session for fast session lookup */
  private sessions: Map<string, Session> = new Map();
  /** Map of userId to set of sessionIds for user-based lookups */
  private userIdToSessions: Map<number, Set<string>> = new Map();

  /**
   * Register a new session for a connected user.
   * Called when a user successfully authenticates via TCP or HTTP.
   *
   * @param sessionId - Unique session identifier (UUID)
   * @param userId - Database ID of the authenticated user
   * @param nickname - User's display name
   * @param transport - Protocol used for this connection
   * @param sendFn - Callback to send messages to this session
   * @returns The created session object
   */
  connect(
    sessionId: string,
    userId: number,
    nickname: string,
    transport: TransportType,
    sendFn: (msg: string) => void
  ): Session {
    const session: Session = {
      sessionId,
      userId,
      nickname,
      currentRoom: null,
      transport,
      sendMessage: sendFn,
      createdAt: new Date(),
    };

    this.sessions.set(sessionId, session);

    // Track session by user ID (user can have multiple sessions)
    if (!this.userIdToSessions.has(userId)) {
      this.userIdToSessions.set(userId, new Set());
    }
    this.userIdToSessions.get(userId)!.add(sessionId);

    logger.info({ sessionId, userId, nickname, transport }, 'Session connected');

    return session;
  }

  /**
   * Remove a session when user disconnects.
   * Cleans up both session and user-to-session mappings.
   *
   * @param sessionId - ID of the session to remove
   * @returns The removed session, or undefined if not found
   */
  disconnect(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    this.sessions.delete(sessionId);

    // Remove from user ID mapping
    const userSessions = this.userIdToSessions.get(session.userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) {
        this.userIdToSessions.delete(session.userId);
      }
    }

    logger.info({ sessionId, userId: session.userId, nickname: session.nickname }, 'Session disconnected');

    return session;
  }

  /**
   * Get a session by its ID.
   *
   * @param sessionId - The session ID to look up
   * @returns The session if found, undefined otherwise
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a specific user.
   * Useful for sending DMs or checking online status.
   *
   * @param userId - The user's database ID
   * @returns Array of active sessions for this user
   */
  getSessionsByUserId(userId: number): Session[] {
    const sessionIds = this.userIdToSessions.get(userId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  /**
   * Get all active sessions across all users.
   *
   * @returns Array of all active sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update a session's nickname after /nick command.
   *
   * @param sessionId - ID of the session to update
   * @param newNickname - New nickname to set
   * @returns True if session was found and updated, false otherwise
   */
  updateNickname(sessionId: string, newNickname: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.nickname = newNickname;
    return true;
  }

  /**
   * Update which room a session is currently in.
   * Called when user joins or leaves a room.
   *
   * @param sessionId - ID of the session to update
   * @param roomName - Name of the room, or null if leaving
   * @returns True if session was found and updated, false otherwise
   */
  setCurrentRoom(sessionId: string, roomName: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.currentRoom = roomName;
    return true;
  }

  /**
   * Get all sessions currently in a specific room.
   * Used for broadcasting messages to room members.
   *
   * @param roomName - Name of the room
   * @returns Array of sessions in the room
   */
  getSessionsInRoom(roomName: string): Session[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.currentRoom === roomName
    );
  }

  /**
   * Check if a user has at least one active session.
   *
   * @param userId - The user's database ID
   * @returns True if user has active sessions, false otherwise
   */
  isUserOnline(userId: number): boolean {
    const sessions = this.userIdToSessions.get(userId);
    return sessions !== undefined && sessions.size > 0;
  }

  /**
   * Get the total number of active sessions.
   * Used for monitoring and health checks.
   *
   * @returns Total session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get the number of unique online users.
   * A user with multiple sessions is counted once.
   *
   * @returns Number of unique online users
   */
  getOnlineUserCount(): number {
    return this.userIdToSessions.size;
  }
}

/** Singleton instance of the connection manager */
export const connectionManager = new ConnectionManager();
export default connectionManager;
