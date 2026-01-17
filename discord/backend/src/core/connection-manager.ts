import type { Session, TransportType } from '../types/index.js';
import { logger } from '../utils/logger.js';

export class ConnectionManager {
  private sessions: Map<string, Session> = new Map();
  private userIdToSessions: Map<number, Set<string>> = new Map();

  /**
   * Register a new session
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

    logger.info('Session connected', {
      sessionId,
      userId,
      nickname,
      transport,
    });

    return session;
  }

  /**
   * Remove a session
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

    logger.info('Session disconnected', {
      sessionId,
      userId: session.userId,
      nickname: session.nickname,
    });

    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a user
   */
  getSessionsByUserId(userId: number): Session[] {
    const sessionIds = this.userIdToSessions.get(userId);
    if (!sessionIds) return [];

    return Array.from(sessionIds)
      .map((id) => this.sessions.get(id))
      .filter((s): s is Session => s !== undefined);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update session nickname
   */
  updateNickname(sessionId: string, newNickname: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.nickname = newNickname;
    return true;
  }

  /**
   * Update session's current room
   */
  setCurrentRoom(sessionId: string, roomName: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.currentRoom = roomName;
    return true;
  }

  /**
   * Get all sessions in a specific room
   */
  getSessionsInRoom(roomName: string): Session[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.currentRoom === roomName
    );
  }

  /**
   * Check if user is online (has at least one session)
   */
  isUserOnline(userId: number): boolean {
    const sessions = this.userIdToSessions.get(userId);
    return sessions !== undefined && sessions.size > 0;
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get count of unique online users
   */
  getOnlineUserCount(): number {
    return this.userIdToSessions.size;
  }
}

export const connectionManager = new ConnectionManager();
export default connectionManager;
